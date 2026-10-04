import asyncio
import json
import os
import re

from providers import ProviderError, ask  # loads .env

DEFAULT = "gemini:gemini-2.5-flash"

# Which model sits in which seat. Change these in .env, no code edits needed.
SEATS = {
    "researcher": os.getenv("SEAT_RESEARCHER", DEFAULT),
    "skeptic": os.getenv("SEAT_SKEPTIC", DEFAULT),
    "factchecker": os.getenv("SEAT_FACTCHECKER", DEFAULT),
    "advocate": os.getenv("SEAT_ADVOCATE", DEFAULT),
    "judge": os.getenv("SEAT_JUDGE", DEFAULT),
    "baseline": os.getenv("SEAT_BASELINE", DEFAULT),
}
FALLBACK = os.getenv("FALLBACK", "")  # e.g. ollama:llama3.1
MAX_CTX = 1200  # characters of each agent's note passed on to later agents

BASE = "You are one member of a fact-checking panel. Be concise, under 120 words, no preamble."

ROLES = {
    "researcher": (
        "Answer the statement or question directly and accurately. State your answer first.",
        False,
    ),
    "skeptic": (
        "Do not answer yet. Check the premise: does the statement or question assume anything "
        "false, unproven or ambiguous? Say what and why. If the premise is sound, say so plainly.",
        False,
    ),
    "factchecker": (
        "Use search. List the key factual claims and mark each supported, contradicted or unclear, "
        "with one line of evidence. Never guess. Say unclear if you cannot find a source.",
        True,
    ),
    "advocate": (
        "You have read the panel's first-round notes. Argue against the group's emerging view: give "
        "the strongest reason it could be wrong or incomplete. If there is no real objection, say so "
        "plainly instead of inventing one.",
        False,
    ),
}

JUDGE = (
    "You are the judge of a fact-checking panel. Use only the panel notes. Prefer claims the "
    "fact-checker supported with a source. Anything still contested goes in open_doubts. "
    "Reply with JSON only, with exactly these keys: "
    '"answer" (string), "confidence" ("high", "medium" or "low"), '
    '"premise_flag" (string describing a false assumption in the question, or null), '
    '"open_doubts" (array of strings, empty if none).'
)


def _clip(text):
    return text if len(text) <= MAX_CTX else text[:MAX_CTX] + "..."


def _notes(results):
    return "\n\n".join(f"[{name}]\n{_clip(r['text'])}" for name, r in results.items())


async def _agent(name, prompt):
    role, search = ROLES[name]
    text, sources, used = await ask(SEATS[name], FALLBACK, f"{BASE} {role}", prompt, search=search)
    return {"text": text, "sources": sources, "model": used}


async def _baseline(question):
    text, _, used = await ask(SEATS["baseline"], FALLBACK, "Answer the user's question.", question)
    return {"text": text, "model": used}


async def _tag(name, coro):
    try:
        return name, await coro, None
    except ProviderError as e:
        return name, None, str(e)


def _parse(text):
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        d = json.loads(cleaned)
        return {
            "answer": str(d.get("answer", "")),
            "confidence": str(d.get("confidence", "low")).lower(),
            "premise_flag": d.get("premise_flag") or None,
            "open_doubts": list(d.get("open_doubts") or []),
        }
    except (json.JSONDecodeError, AttributeError, TypeError):
        return {
            "answer": text,
            "confidence": "low",
            "premise_flag": None,
            "open_doubts": ["The judge did not return structured output."],
        }


async def run_check(question):
    results, errors = {}, {}
    yield {"type": "start"}
    baseline_task = asyncio.create_task(_tag("baseline", _baseline(question)))
    q = f"Statement or question:\n{question}"

    # Round 1: blind. Each agent gets only the question, never another agent's answer.
    first = ["researcher", "skeptic", "factchecker"]
    for name in first:
        yield {"type": "agent_start", "agent": name}
    for fut in asyncio.as_completed([_tag(n, _agent(n, q)) for n in first]):
        name, res, err = await fut
        if err:
            errors[name] = err
            yield {"type": "agent_error", "agent": name, "error": err}
        else:
            results[name] = res
            yield {"type": "agent_done", "agent": name, **res}

    if not results:
        baseline_task.cancel()
        yield {"type": "error", "error": "No agent could answer. " + " | ".join(errors.values())}
        return

    # Round 2: the devil's advocate reads round 1 (clipped) and pushes back.
    yield {"type": "agent_start", "agent": "advocate"}
    name, res, err = await _tag("advocate", _agent("advocate", f"{q}\n\nFirst-round notes:\n{_notes(results)}"))
    if err:
        errors[name] = err
        yield {"type": "agent_error", "agent": name, "error": err}
    else:
        results[name] = res
        yield {"type": "agent_done", "agent": name, **res}

    # Judge: reads everything that survived, returns JSON.
    yield {"type": "judge_start"}
    try:
        text, _, used = await ask(
            SEATS["judge"], FALLBACK, JUDGE, f"{q}\n\nPanel notes:\n{_notes(results)}", json_mode=True
        )
        verdict = _parse(text)
        verdict["model"] = used
    except ProviderError as e:
        verdict = {"answer": "", "confidence": "low", "premise_flag": None,
                   "open_doubts": [f"The judge failed: {e}"], "model": SEATS["judge"]}
    verdict["open_doubts"] += [f"{n} was unavailable: {e}" for n, e in errors.items()]
    yield {"type": "verdict", **verdict}

    _, base, err = await baseline_task
    if base:
        yield {"type": "baseline", **base}
    yield {"type": "done"}
