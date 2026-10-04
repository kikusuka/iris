(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LANES = ["researcher", "skeptic", "factchecker", "advocate"];
  var BASE = "You are one member of a fact-checking panel. Be concise, under 120 words, no preamble. ";
  var ROLES = {
    researcher: ["Answer the statement or question directly and accurately. State your answer first.", false],
    skeptic: ["Do not answer yet. Check the premise: does the statement or question assume anything false, unproven or ambiguous? Say what and why. If the premise is sound, say so plainly.", false],
    factchecker: ["Use search. List the key factual claims and mark each supported, contradicted or unclear, with one line of evidence. Never guess. Say unclear if you cannot find a source.", true],
    advocate: ["You have read the panel's first-round notes. Argue against the group's emerging view: give the strongest reason it could be wrong or incomplete. If there is no real objection, say so plainly instead of inventing one.", false]
  };
  var JUDGE = "You are the judge of a fact-checking panel. Use only the panel notes. Prefer claims the fact-checker supported with a source. Anything still contested goes in open_doubts. Reply with JSON only, with exactly these keys: \"answer\" (string), \"confidence\" (\"high\", \"medium\" or \"low\"), \"premise_flag\" (string describing a false assumption in the question, or null), \"open_doubts\" (array of strings, empty if none).";
  var DEMO = {
    researcher: "Einstein won the Nobel Prize in Physics in 1921.",
    skeptic: "The question says relativity. Was the prize actually given for that? The premise needs checking before the year does.",
    factchecker: "The 1921 prize was awarded for his services to theoretical physics, especially the law of the photoelectric effect. Relativity was not the stated reason.",
    advocate: "Relativity is what he is best known for, so the mix-up is common. But the citation does not name it, so the premise fails.",
    verdict: { answer: "1921, but for the photoelectric effect, not relativity.", confidence: "high", premise_flag: "The question assumes the prize was for relativity. It was not.", open_doubts: [] },
    baseline: "Einstein won the Nobel Prize in Physics in 1921 for his theory of relativity."
  };
  var SEATS = [["researcher", "Researcher"], ["skeptic", "Skeptic"], ["factchecker", "Fact-checker"], ["advocate", "Devil's advocate"], ["judge", "Judge"], ["baseline", "Single-model comparison"]];
  var OLLAMA = "http://localhost:11434";
  var MODELS = { gemini: [], ollama: [] };
  var S = { mode: "demo", key: "", seats: {} };
  try { Object.assign(S, JSON.parse(localStorage.getItem("iris") || "{}")); } catch (e) {}
  if (S.mode !== "demo") S.mode = "live";
  S.seats = S.seats || {};
  SEATS.forEach(function (s) { if (!S.seats[s[0]]) S.seats[s[0]] = { p: "gemini", m: "gemini-2.5-flash" }; });
  var running = false;

  function save() {
    S.mode = $("mode").value; S.key = $("key").value.trim();
    try { localStorage.setItem("iris", JSON.stringify(S)); } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function note(t) { $("note").hidden = !t; $("note").textContent = t || ""; }

  function setLane(name, state, text, sources) {
    var el = $("lane-" + name);
    el.hidden = false;
    el.className = "lane " + state;
    el.querySelector(".body").textContent = state === "working" ? "Working on it…" : (text || "");
    var src = el.querySelector(".src");
    src.textContent = "";
    if (sources && sources.length) {
      src.append("Sources: ");
      sources.slice(0, 3).forEach(function (s, i) {
        if (i) src.append(", ");
        if (/^https?:\/\//.test(s.url)) {
          var a = document.createElement("a");
          a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = s.title || s.url;
          src.append(a);
        } else { src.append(s.title || s.url); }
      });
    }
  }

  function showVerdict(v) {
    $("judging").hidden = true;
    $("premise").hidden = !v.premise_flag;
    $("premise").querySelector("p").textContent = v.premise_flag || "";
    $("answer").textContent = v.answer;
    $("conf").textContent = v.confidence.charAt(0).toUpperCase() + v.confidence.slice(1);
    var ul = $("doubts"); ul.textContent = "";
    var items = v.open_doubts.length ? v.open_doubts : ["None"];
    items.forEach(function (d) { var li = document.createElement("li"); li.textContent = d; ul.append(li); });
    $("verdict").hidden = false;
  }

  function resetView() {
    LANES.forEach(function (n) { $("lane-" + n).hidden = true; });
    ["premise", "verdict", "base", "judging"].forEach(function (id) { $(id).hidden = true; });
    $("results").hidden = true; note("");
  }

  async function gemini(model, system, prompt, search, json) {
    if (!S.key) throw new Error("Add your Gemini key in Settings.");
    var body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } };
    if (search) body.tools = [{ google_search: {} }];
    if (json) body.generationConfig.responseMimeType = "application/json";
    var r;
    try {
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": S.key }, body: JSON.stringify(body)
      });
    } catch (e) { throw new Error("Cannot reach Gemini. Check your internet connection."); }
    if (!r.ok) throw new Error("Gemini " + r.status + ": " + (await r.text()).slice(0, 160));
    var c = ((await r.json()).candidates || [{}])[0];
    var text = (((c.content || {}).parts) || []).map(function (p) { return p.text || ""; }).join("").trim();
    var sources = (((c.groundingMetadata || {}).groundingChunks) || []).filter(function (x) { return x.web; })
      .map(function (x) { return { title: x.web.title || x.web.uri, url: x.web.uri }; });
    return { text: text, sources: sources };
  }

  async function ollama(model, system, prompt, json) {
    var body = { model: model, stream: false, options: { temperature: 0.3 }, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] };
    if (json) body.format = "json";
    var r;
    try {
      r = await fetch(OLLAMA + "/api/chat", { method: "POST", body: JSON.stringify(body) });
    } catch (e) { throw new Error("Cannot reach Ollama. Start it with OLLAMA_ORIGINS=* ollama serve"); }
    if (!r.ok) throw new Error("Ollama " + r.status + ": " + (await r.text()).slice(0, 160));
    return { text: (((await r.json()).message || {}).content || "").trim(), sources: [] };
  }

  function ask(seat, system, prompt, search, json) {
    var c = S.seats[seat];
    if (!c.m) return Promise.reject(new Error("No model chosen for this seat. Open Configure models."));
    return c.p === "gemini" ? gemini(c.m, system, prompt, search, json) : ollama(c.m, system, prompt, json);
  }
  function clip(t) { return t.length > 1200 ? t.slice(0, 1200) + "..." : t; }

  function parse(text) {
    try {
      var d = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
      return { answer: String(d.answer || ""), confidence: String(d.confidence || "low").toLowerCase(), premise_flag: d.premise_flag || null, open_doubts: Array.isArray(d.open_doubts) ? d.open_doubts : [] };
    } catch (e) {
      return { answer: text, confidence: "low", premise_flag: null, open_doubts: ["The judge did not return structured output."] };
    }
  }

  async function runDemo() {
    note("Demo mode plays a saved run of the Einstein example. Switch to Live to check your own question.");
    for (var i = 0; i < 4; i++) {
      var n = LANES[i];
      setLane(n, "working"); await sleep(1100);
      setLane(n, "done", DEMO[n], n === "factchecker" ? [{ title: "nobelprize.org, Physics 1921", url: "" }] : null);
    }
    $("judging").hidden = false; await sleep(1200);
    showVerdict(DEMO.verdict);
    $("basetext").textContent = DEMO.baseline; $("base").hidden = false;
  }

  async function runLive(question) {
    var results = {}, errors = {};
    var q = "Statement or question:\n" + question;
    var baseP = ask("baseline", "Answer the user's question.", question, false, false).catch(function (e) { return { error: e.message }; });

    async function agent(name, prompt) {
      setLane(name, "working");
      try {
        var r = await ask(name, BASE + ROLES[name][0], prompt, ROLES[name][1], false);
        results[name] = r;
        setLane(name, "done", r.text, r.sources);
        if (name === "factchecker" && !r.sources.length && S.seats.factchecker.p !== "gemini") {
          $("lane-factchecker").querySelector(".src").textContent = "Ollama has no search, so nothing was looked up.";
        }
      } catch (e) { errors[name] = e.message; setLane(name, "error", e.message); }
    }
    await Promise.all(["researcher", "skeptic", "factchecker"].map(function (n) { return agent(n, q); }));
    if (!Object.keys(results).length) { note("No agent could answer. " + Object.values(errors)[0]); return; }

    function notes() { return Object.keys(results).map(function (n) { return "[" + n + "]\n" + clip(results[n].text); }).join("\n\n"); }
    await agent("advocate", q + "\n\nFirst-round notes:\n" + notes());

    $("judging").hidden = false;
    var v;
    try { v = parse((await ask("judge", JUDGE, q + "\n\nPanel notes:\n" + notes(), false, true)).text); }
    catch (e) { v = { answer: "", confidence: "low", premise_flag: null, open_doubts: ["The judge failed: " + e.message] }; }
    Object.keys(errors).forEach(function (n) { v.open_doubts.push(n + " was unavailable: " + errors[n]); });
    showVerdict(v);

    var b = await baseP;
    if (b.text) { $("basetext").textContent = b.text; $("base").hidden = false; }
  }

  async function run() {
    var question = $("q").value.trim();
    if (running) return;
    if (question.length < 3) { note("Type a statement or question first."); return; }
    save(); resetView(); running = true; $("run").disabled = true;
    $("results").hidden = false;
    try {
      if (S.mode === "demo") await runDemo(); else await runLive(question);
    } catch (e) { note("Something went wrong: " + e.message); }
    running = false; $("run").disabled = false;
  }

  function known(p, m) { var l = MODELS[p]; return l.indexOf(m) > -1 || l.indexOf(m + ":latest") > -1; }

  function fillLists() {
    ["gemini", "ollama"].forEach(function (p) {
      var dl = $("dl-" + p); dl.textContent = "";
      MODELS[p].forEach(function (m) { var o = document.createElement("option"); o.value = m; dl.append(o); });
    });
    rows.forEach(function (r) { r.check(); });
  }

  function seatRow(seat, label) {
    var row = document.createElement("div"); row.className = "seat";
    var name = document.createElement("span"); name.className = "sname"; name.textContent = label;
    var sel = document.createElement("select"); sel.setAttribute("aria-label", label + " provider");
    [["gemini", "Gemini"], ["ollama", "Ollama"]].forEach(function (o) { var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; sel.append(op); });
    var inp = document.createElement("input"); inp.setAttribute("aria-label", label + " model");
    var warn = document.createElement("span"); warn.className = "warn";
    row.check = function () {
      var c = S.seats[seat], msg = "";
      inp.setAttribute("list", "dl-" + c.p);
      if (seat === "factchecker" && c.p === "ollama") msg = "Ollama has no search, so this seat will not look anything up.";
      else if (MODELS[c.p].length && c.m && !known(c.p, c.m)) msg = "Not in the " + (c.p === "gemini" ? "Gemini" : "installed Ollama") + " list.";
      warn.textContent = msg;
    };
    row.sync = function () { sel.value = S.seats[seat].p; inp.value = S.seats[seat].m; row.check(); };
    sel.addEventListener("change", function () {
      var c = S.seats[seat]; c.p = sel.value;
      if (MODELS[c.p].length && !known(c.p, c.m)) { c.m = MODELS[c.p][0]; inp.value = c.m; }
      row.check(); save();
    });
    inp.addEventListener("input", function () { S.seats[seat].m = inp.value.trim(); row.check(); save(); });
    row.append(name, sel, inp, warn); row.sync();
    return row;
  }

  async function loadModels() {
    var status = $("modelstatus"), parts = [];
    status.textContent = "Loading…";
    try {
      var r = await fetch(OLLAMA + "/api/tags");
      if (!r.ok) throw new Error("bad status");
      MODELS.ollama = ((await r.json()).models || []).map(function (m) { return m.name; });
      parts.push(MODELS.ollama.length + " Ollama models");
    } catch (e) { MODELS.ollama = []; parts.push("Ollama not reachable"); }
    if (S.key) {
      try {
        var g = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": S.key } });
        if (!g.ok) throw new Error("bad status");
        MODELS.gemini = ((await g.json()).models || [])
          .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf("generateContent") > -1; })
          .map(function (m) { return m.name.replace(/^models\//, ""); });
        parts.push(MODELS.gemini.length + " Gemini models");
      } catch (e) { MODELS.gemini = []; parts.push("Gemini list failed (check key and internet)"); }
    } else { parts.push("add a Gemini key to list Gemini models"); }
    status.textContent = parts.join(", ") + ".";
    fillLists();
  }

  var rows = SEATS.map(function (s) { var r = seatRow(s[0], s[1]); $("seats").append(r); return r; });
  $("mode").value = S.mode; $("key").value = S.key;
  $("mode").addEventListener("change", save); $("key").addEventListener("change", save);
  $("loadmodels").addEventListener("click", function () { save(); loadModels(); });
  $("allp").addEventListener("change", function () { $("allm").setAttribute("list", "dl-" + $("allp").value); });
  $("applyall").addEventListener("click", function () {
    var p = $("allp").value, m = $("allm").value.trim();
    if (!m) return;
    SEATS.forEach(function (s) { S.seats[s[0]] = { p: p, m: m }; });
    rows.forEach(function (r) { r.sync(); }); save();
  });
  $("run").addEventListener("click", run);
  $("clear").addEventListener("click", function () { $("q").value = ""; resetView(); });
  $("example").addEventListener("click", function () { $("q").value = "In what year did Einstein win the Nobel Prize for relativity?"; });
})();
