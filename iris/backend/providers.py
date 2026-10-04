import os

import httpx
from dotenv import load_dotenv

load_dotenv()


class ProviderError(Exception):
    pass


def parse_spec(spec: str):
    provider, _, model = spec.partition(":")
    if provider not in ("gemini", "ollama") or not model:
        raise ProviderError(f"Bad model setting '{spec}'. Use gemini:<model> or ollama:<model>.")
    return provider, model


async def call_gemini(model, system, prompt, search=False, json_mode=False):
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise ProviderError("GEMINI_API_KEY is not set")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3},
    }
    if search:
        body["tools"] = [{"google_search": {}}]
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    async with httpx.AsyncClient(timeout=90) as client:
        r = await client.post(url, json=body, headers={"x-goog-api-key": key})
    if r.status_code != 200:
        raise ProviderError(f"Gemini {r.status_code}: {r.text[:200]}")
    cand = (r.json().get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
    sources = []
    for chunk in cand.get("groundingMetadata", {}).get("groundingChunks", []):
        web = chunk.get("web")
        if web:
            sources.append({"title": web.get("title", ""), "url": web.get("uri", "")})
    return text.strip(), sources


async def call_ollama(model, system, prompt, json_mode=False):
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    body = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "options": {"temperature": 0.3},
    }
    if json_mode:
        body["format"] = "json"
    async with httpx.AsyncClient(timeout=180) as client:
        r = await client.post(f"{host}/api/chat", json=body)
    if r.status_code != 200:
        raise ProviderError(f"Ollama {r.status_code}: {r.text[:200]}")
    return r.json().get("message", {}).get("content", "").strip(), []


async def _call(spec, system, prompt, search, json_mode):
    provider, model = parse_spec(spec)
    try:
        if provider == "gemini":
            return await call_gemini(model, system, prompt, search, json_mode)
        return await call_ollama(model, system, prompt, json_mode)
    except httpx.HTTPError as e:
        raise ProviderError(f"{provider} unreachable ({e.__class__.__name__})")


async def ask(spec, fallback, system, prompt, search=False, json_mode=False):
    """Try the seat's model. If it fails, switch to the fallback model.
    Returns (text, sources, model_actually_used)."""
    try:
        text, sources = await _call(spec, system, prompt, search, json_mode)
        return text, sources, spec
    except ProviderError:
        if not fallback or fallback == spec:
            raise
    text, sources = await _call(fallback, system, prompt, search, json_mode)
    return text, sources, fallback
