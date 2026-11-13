/* voice-engine.js — local text-to-speech in the browser with Kokoro (kokoro-js 1.2.1).
   No installs, no npm, no build step, no server, no API keys.

   Add to a page:   <script src="voice-engine.js" defer></script>
   Then use:        VoiceEngine.init();  VoiceEngine.speak("Hello there.", { character: "sam" });

   The model runs in a Web Worker (voice-worker.js, same folder). Model files download once and
   the browser caches them. If Kokoro can't load, the engine can fall back to the browser's own
   voice (speechSynthesis) so the page still talks.

   API
     init()                         load the model; resolves true (ready) or false (unavailable)
     speak(text, {voice, speed, character})   queue text; resolves when playback ends ({stopped})
     stream({voice, speed, character})        returns {push(chunk), close(), done}; speaks sentence by sentence as text arrives
     stop()                         stop at once and clear the queue
     prepare(lines, {character, voice, speed, replace})   make lines that will be spoken soon in the background,
                                    so they start at once (speech always goes first; each call replaces the last list)
     listVoices()                   [{id, name, language, gender, grade}]
     setVoiceMap({sam: "am_michael"}), setMuted(bool), setFallback(bool), cleanText(text)
     isSpeaking, level (0..1, per frame), status ("idle" | "loading" | "ready" | "error"), progress (0..100), device, dtype
     events: onStart, onEnd, onSentence(text), onStatus(status), onProgress(pct), onLevel(level), onError(message)
             or VoiceEngine.on("start" | "end" | "sentence" | "status" | "progress" | "level" | "error", fn) -> unsubscribe
*/
(function () {
  "use strict";

  /* ======================= SETTINGS =======================
     Change them here, or set window.VOICE_CONFIG = { ... } before this file loads. */
  const DEFAULTS = {
    KOKORO_URL: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm",                 // pinned, never @latest
    KOKORO_WEB_URL: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js",// used if +esm fails
    TRANSFORMERS_URL: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm",
    MODEL_ID: "onnx-community/Kokoro-82M-v1.0-ONNX",
    MODEL_BASE_URL: "models/Kokoro-82M-v1.0-ONNX/", // the model copy hosted with the game (relative to this file); null = huggingface.co only
    MODEL_FALLBACK_TO_HUB: true,     // if the copy is missing or incomplete, download from huggingface.co instead
    WEBGPU_DTYPE: "fp32",            // WebGPU first (about 330 MB, downloaded once)
    WASM_DTYPE: "q8",                // CPU fallback (about 90 MB, downloaded once)
    FORCE_CPU: false,                // skip WebGPU (also: add ?voice=cpu to the page address)
    DEFAULT_VOICE: "af_heart",
    VOICE_MAP: {},                   // per-character voices, e.g. { mabel: "af_bella", narrator: "bm_george" }
    SPEED: 1,
    FALLBACK_TO_BROWSER_VOICE: true, // if Kokoro fails, speak with the browser's built-in voice
    FALLBACK_WHILE_LOADING: false,   // also use the browser voice while Kokoro is still downloading
    WORKER_URL: null,                // default: voice-worker.js next to this file
    DEBUG: false
  };
  const CFG = Object.assign({}, DEFAULTS, window.VOICE_CONFIG || {});
  try {
    const q = new URLSearchParams(location.search).get("voice");
    if (q === "cpu") CFG.FORCE_CPU = true;          // test the CPU path
    if (q === "browser") CFG.FORCE_BROWSER = true;  // test the fallback path
  } catch (e) { /* no location */ }

  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || location.href;

  // Kokoro voices (kokoro-js 1.2.1). Grades are the model authors' own quality ratings.
  const VOICES = [
    ["af_heart","Heart","en-us","Female","A"],["af_alloy","Alloy","en-us","Female","C"],["af_aoede","Aoede","en-us","Female","C+"],
    ["af_bella","Bella","en-us","Female","A-"],["af_jessica","Jessica","en-us","Female","D"],["af_kore","Kore","en-us","Female","C+"],
    ["af_nicole","Nicole","en-us","Female","B-"],["af_nova","Nova","en-us","Female","C"],["af_river","River","en-us","Female","D"],
    ["af_sarah","Sarah","en-us","Female","C+"],["af_sky","Sky","en-us","Female","C-"],["am_adam","Adam","en-us","Male","F+"],
    ["am_echo","Echo","en-us","Male","D"],["am_eric","Eric","en-us","Male","D"],["am_fenrir","Fenrir","en-us","Male","C+"],
    ["am_liam","Liam","en-us","Male","D"],["am_michael","Michael","en-us","Male","C+"],["am_onyx","Onyx","en-us","Male","D"],
    ["am_puck","Puck","en-us","Male","C+"],["am_santa","Santa","en-us","Male","D-"],["bf_emma","Emma","en-gb","Female","B-"],
    ["bf_isabella","Isabella","en-gb","Female","C"],["bm_george","George","en-gb","Male","C"],["bm_lewis","Lewis","en-gb","Male","D+"],
    ["bf_alice","Alice","en-gb","Female","D"],["bf_lily","Lily","en-gb","Female","D"],["bm_daniel","Daniel","en-gb","Male","D"],
    ["bm_fable","Fable","en-gb","Male","C"]
  ].map(([id, name, language, gender, grade]) => ({ id, name, language, gender, grade }));
  const VOICE_IDS = new Set(VOICES.map((v) => v.id));

  const log = (...a) => console.info("[voice]", ...a);
  const dbg = (...a) => { if (CFG.DEBUG) console.debug("[voice]", ...a); };

  /* ======================= EVENTS ======================= */
  const listeners = { start: new Set(), end: new Set(), sentence: new Set(), status: new Set(), progress: new Set(), level: new Set(), error: new Set() };
  function emit(ev, ...args) {
    const prop = E["on" + ev[0].toUpperCase() + ev.slice(1)];
    if (typeof prop === "function") { try { prop(...args); } catch (e) { console.error(e); } }
    for (const fn of listeners[ev]) { try { fn(...args); } catch (e) { console.error(e); } }
  }

  /* ======================= TEXT CLEANUP ======================= */
  // Strips markdown, emojis, URLs, code, *stage directions* and [bracketed notes] before speaking.
  function cleanText(text) {
    let s = String(text == null ? "" : text);
    s = s.replace(/```[\s\S]*?(?:```|$)/g, " ");                          // code blocks
    s = s.replace(/`[^`]*`/g, " ");                                       // inline code
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");                          // images
    s = s.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.|\/|#|mailto:)[^)]*\)/gi, "$1"); // links: keep their text
    s = s.replace(/\[[^\]]*\]/g, " ");                                    // [stage directions]
    s = s.replace(/^\s*[*+\-•]\s+/gm, "");                                // list bullets
    s = s.replace(/^\s*\d+[.)]\s+/gm, "");                                // numbered lists
    s = s.replace(/(\d)\s*\*\s*(\d)/g, "$1 times $2");                    // 5 * 3
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1"); // bold: keep the words
    s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1 ");           // *stage directions*
    s = s.replace(/\*(?!\s)[^*\n]*$/g, " ");                              // an unclosed *direction at the end
    s = s.replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?;:]|$)/g, "$1$2");          // _italic_: keep the words
    s = s.replace(/[*~]+/g, " ");                                         // stray markers
    s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");                             // headings
    s = s.replace(/^\s*>\s?/gm, "");                                      // quotes
    s = s.replace(/^\s*(?:[-_=]\s*){3,}$/gm, " ");                        // horizontal rules
    s = s.replace(/<[^>]+>/g, " ");                                       // html tags
    s = s.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " "); // urls
    s = s.replace(/\|/g, " ");                                            // table pipes
    s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, ""); // emojis
    s = s.replace(/([^\s.!?,;:])[ \t]*\n+/g, "$1.\n");                    // line breaks (lists, headings) become pauses
    s = s.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/([,;:])(?=[.!?])/g, "").replace(/\.{2,}(?!\.)/g, (m) => (m.length === 3 ? m : ".")).trim();
    return s;
  }
  // Streaming version: only lets text through at sentence ends where no markup is still open.
  function makeCleaner() {
    let buf = "";
    function safeCut(s) {
      let fence = false, code = false, br = 0, par = 0, ast = false, last = 0;
      for (let i = 0; i < s.length; i++) {
        if (s.startsWith("```", i)) { fence = !fence; i += 2; continue; }
        if (fence) continue;
        const ch = s[i];
        if (ch === "`") { code = !code; continue; }
        if (code) continue;
        if (ch === "[") { br++; continue; }
        if (ch === "]") { if (br) br--; continue; }
        if (ch === "(" && s[i - 1] === "]") { par++; continue; }
        if (ch === ")" && par) { par--; continue; }
        if (ch === "*") { if (s[i + 1] === "*") { i++; continue; } ast = !ast; continue; }
        if (br || par || ast) continue;
        if ((ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === "\n") && /\s/.test(s[i + 1] || "")) last = i + 1;
      }
      return last;
    }
    return {
      push(chunk) { buf += chunk; const cut = safeCut(buf); if (!cut) return ""; const out = buf.slice(0, cut); buf = buf.slice(cut); return cleanText(out); },
      flush() { const out = buf; buf = ""; return cleanText(out); }
    };
  }

  /* ======================= AUDIO ======================= */
  let ctx = null, gainNode = null, analyser = null, playhead = 0, tdata = null, rafId = 0, browserTalking = false;
  const active = new Set();   // scheduled AudioBufferSourceNodes
  const timers = new Set();   // sentence-start timers
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      gainNode = ctx.createGain();
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      gainNode.connect(analyser); analyser.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  function unlockAudio() { try { audio(); } catch (e) { /* no Web Audio */ } }
  // Browsers only allow audio after a user gesture: resume the shared AudioContext on the first one.
  ["pointerdown", "keydown", "touchend"].forEach((ev) => addEventListener(ev, unlockAudio, { capture: true, passive: true }));

  function setSpeaking(on) {
    if (E.isSpeaking === on) return;
    E.isSpeaking = on;
    emit(on ? "start" : "end");
    if (on) levelLoop();
  }
  // Live volume level (0..1), once per frame, for lip-sync or a speaking light.
  function levelLoop() {
    if (rafId) return;
    const step = () => {
      let v = 0;
      if (analyser && active.size) {
        tdata = tdata || new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(tdata);
        let sum = 0; for (let i = 0; i < tdata.length; i++) sum += tdata[i] * tdata[i];
        v = Math.min(1, Math.sqrt(sum / tdata.length) * 4);
      } else if (browserTalking) {
        v = 0.35 + 0.25 * Math.sin(performance.now() / 90);   // the browser voice can't be measured: gentle pulse
      }
      E.level = v > E.level ? E.level * 0.4 + v * 0.6 : E.level * 0.85 + v * 0.15;
      if (E.level < 0.005) E.level = 0;
      emit("level", E.level);
      if (E.isSpeaking || E.level > 0) rafId = requestAnimationFrame(step); else rafId = 0;
    };
    rafId = requestAnimationFrame(step);
  }

  // Schedule one sentence right after the previous one: no gaps, no overlaps.
  function playSentence(job, pcm, sampleRate, text) {
    const c = audio();
    const buf = c.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    const src = c.createBufferSource();
    src.buffer = buf; src.connect(gainNode);
    const now = c.currentTime, start = Math.max(now + 0.03, playhead);
    playhead = start + buf.duration;
    src.start(start);
    active.add(src); job.pending++;
    if (E._trace) E._trace.push({ id: job.id, start, duration: buf.duration, text });
    const t = setTimeout(() => {
      timers.delete(t);
      if (!jobs.has(job.id)) return;
      setSpeaking(true);
      emit("sentence", text, { id: job.id, voice: job.voice });
    }, Math.max(0, (start - now) * 1000));
    timers.add(t);
    src.onended = () => { active.delete(src); job.pending--; checkJob(job); };
  }

  /* ======================= BROWSER VOICE FALLBACK ======================= */
  function pickBrowserVoice() {
    if (!("speechSynthesis" in window)) return null;
    const vs = speechSynthesis.getVoices() || [];
    return vs.find((v) => /en-GB/i.test(v.lang) && /natural|online|google/i.test(v.name)) ||
           vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  function browserPush(job, text) {
    job.sb += text;
    const re = /[^.!?…]+[.!?…]+["')\]]*\s+/g;
    let m, used = 0;
    while ((m = re.exec(job.sb))) { browserSay(job, m[0].trim()); used = re.lastIndex; }
    job.sb = job.sb.slice(used);
  }
  function browserClose(job) {
    const rest = job.sb.trim(); job.sb = "";
    if (rest) browserSay(job, rest);
    job.closedB = true;
    if (!job.pendingB) finishJob(job);
  }
  function browserSay(job, sentence) {
    if (!("speechSynthesis" in window) || !sentence) return;
    const u = new SpeechSynthesisUtterance(sentence);
    const v = pickBrowserVoice();
    u.lang = "en-GB";
    try { if (v) { u.voice = v; u.lang = v.lang; } } catch (e) { /* keep the default voice */ }
    u.rate = job.speed;
    u.pitch = /^(am_|bm_)/.test(job.voice) ? 0.85 : 1.05;   // keep male and female characters apart a little
    job.pendingB++;
    u.onstart = () => { if (!jobs.has(job.id)) return; browserTalking = true; setSpeaking(true); emit("sentence", sentence, { id: job.id, voice: job.voice }); };
    const done = () => { job.pendingB--; if (jobs.has(job.id) && job.closedB && !job.pendingB) finishJob(job); };
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  }

  /* ======================= JOBS (one per speak / stream) ======================= */
  const jobs = new Map();
  let seq = 0, worker = null, initPromise = null;

  function route() {
    if (E.muted) return "none";
    if (CFG.FORCE_BROWSER || E.useBrowserVoice) return CFG.FALLBACK_TO_BROWSER_VOICE || E.useBrowserVoice ? "browser" : "none";
    if (E.status === "ready") return "kokoro";
    if (E.status === "error") return CFG.FALLBACK_TO_BROWSER_VOICE ? "browser" : "none";
    return CFG.FALLBACK_WHILE_LOADING && CFG.FALLBACK_TO_BROWSER_VOICE ? "browser" : "none";
  }
  function getVoice(opts) {
    const v = opts.voice || (opts.character && E.voiceMap[opts.character]) || CFG.DEFAULT_VOICE;
    return VOICE_IDS.has(v) ? v : CFG.DEFAULT_VOICE;
  }
  function finishJob(job, stopped) {
    if (!jobs.has(job.id)) return;
    jobs.delete(job.id);
    job.resolve({ stopped: !!stopped });
    if (!jobs.size && !active.size) { browserTalking = false; playhead = 0; setSpeaking(false); }
  }
  function checkJob(job) {
    if (job.mode === "kokoro" && job.workerDone && job.pending <= 0) finishJob(job);
    else if (!jobs.size && !active.size) setSpeaking(false);
  }

  function stream(opts) {
    opts = opts || {};
    if (E.status === "idle" && !CFG.FORCE_BROWSER) init();
    const id = ++seq, voice = getVoice(opts), speed = opts.speed || CFG.SPEED, mode = route();
    let resolve; const done = new Promise((r) => (resolve = r));
    const job = { id, mode, voice, speed, character: opts.character || null, cleaner: makeCleaner(), closed: false, workerDone: false, pending: 0, sb: "", pendingB: 0, closedB: false, resolve };
    jobs.set(id, job);
    dbg("job", id, mode, voice);
    if (mode === "kokoro") worker.postMessage({ type: "open", id, voice, speed });
    const send = (text) => {
      if (!text) return;
      if (job.mode === "kokoro") worker.postMessage({ type: "push", id, text: text + " " });
      else if (job.mode === "browser") browserPush(job, text + " ");
    };
    const handle = {
      id, done,
      push(chunk) { if (!job.closed && jobs.has(id)) send(job.cleaner.push(String(chunk == null ? "" : chunk))); return handle; },
      close() {
        if (job.closed || !jobs.has(id)) return handle;
        job.closed = true;
        send(job.cleaner.flush());
        if (job.mode === "kokoro") worker.postMessage({ type: "close", id });
        else if (job.mode === "browser") browserClose(job);
        else finishJob(job);
        return handle;
      }
    };
    return handle;
  }
  function speak(text, opts) {
    opts = opts || {};
    return (route() === "kokoro" && fromPrepared(String(text == null ? "" : text), opts)) || stream(opts).push(text).close().done;
  }

  // Lines made ahead of time (see prepare) are kept here, sentence by sentence, and played straight from
  // here: the worker may be busy making the next line, and a prepared line shouldn't wait for it.
  const ready = new Map();   // "voice|speed|cleaned line" -> { texts: [sentences], parts: [{pcm, sr}] }
  const READY_MAX = 12;
  const piecesOf = (text) => { const c = makeCleaner(); return [c.push(String(text)), c.flush()].filter(Boolean).map((t) => t + " "); };
  // speak() for a line that was prepared, or that starts with one (a question read with its options):
  // play the sentences already made, and ask the worker only for the rest.
  function fromPrepared(text, opts) {
    const voice = getVoice(opts), speed = opts.speed || CFG.SPEED, base = voice + "|" + speed + "|";
    const whole = piecesOf(text).join("");
    let best = null, bestKey = null, len = 0;
    for (const [key, en] of ready) {
      if (!key.startsWith(base) || !en.texts || !en.parts[0]) continue;
      const line = key.slice(base.length).trimEnd();
      if (line.length <= len || !whole.startsWith(line) || !/\s/.test(whole[line.length] || " ")) continue;
      // More text after it: only if the prepared line ends a sentence, so the split is the same.
      if (whole.slice(line.length).trim() && !/[.!?…]["'”’)\]]*$/.test(line)) continue;
      best = en; bestKey = key; len = line.length;
    }
    if (!best) return null;
    ready.delete(bestKey); ready.set(bestKey, best);   // recently used
    let k = 0; while (k < best.texts.length && best.parts[k]) k++;
    const rest = (best.texts.slice(k).join(" ") + " " + whole.slice(len)).trim();
    const id = ++seq;
    let resolve; const done = new Promise((r) => (resolve = r));
    const job = { id, mode: "kokoro", voice, speed, character: opts.character || null, cleaner: makeCleaner(), closed: true, workerDone: !rest, pending: 0, sb: "", pendingB: 0, closedB: false, resolve };
    jobs.set(id, job);
    dbg("job", id, "prepared", k + "/" + best.texts.length, voice);
    for (let i = 0; i < k; i++) {
      const p = best.parts[i];
      if (typeof E._onAudio === "function") { try { E._onAudio(p.pcm, p.sr, best.texts[i]); } catch (err) { /* test hook */ } }
      playSentence(job, p.pcm, p.sr, best.texts[i]);
    }
    if (rest) { worker.postMessage({ type: "open", id, voice, speed }); worker.postMessage({ type: "push", id, text: rest + " " }); worker.postMessage({ type: "close", id }); }
    return done;
  }

  // Lines that will be spoken soon get made while the model is otherwise idle, so they start without a
  // wait (it matters on the CPU, where making a sentence can take longer than saying it). Lines are
  // strings or { text, character, voice, speed }; each call replaces the lines still waiting from the last.
  let pendingPrepare = null;
  function prepare(lines, opts) {
    opts = opts || {};
    if (CFG.FORCE_BROWSER || E.muted || E.useBrowserVoice || E.status === "error") return E;
    const items = [];
    for (const l of [].concat(lines == null ? [] : lines)) {
      const o = Object.assign({}, opts, typeof l === "string" ? { text: l } : (l || {}));
      if (o.text == null || !String(o.text).trim()) continue;
      const pushes = piecesOf(o.text);   // the same pieces speak() would send, so the sentences match exactly
      if (!pushes.length) continue;
      const voice = getVoice(o), speed = o.speed || CFG.SPEED, key = voice + "|" + speed + "|" + pushes.join("");
      const have = ready.get(key);
      if (have && have.texts && have.texts.every((t, i) => have.parts[i])) continue;   // already made
      items.push({ key, voice, speed, pushes });
    }
    const msg = { type: "prepare", items, replace: opts.replace !== false };
    if (E.status === "ready" && worker) worker.postMessage(msg);
    else { pendingPrepare = msg; if (E.status === "idle") init(); }
    return E;
  }

  function stop() {
    for (const s of active) { try { s.onended = null; s.stop(0); } catch (e) { /* already stopped */ } }
    active.clear();
    timers.forEach(clearTimeout); timers.clear();
    playhead = 0;
    if (worker && E.status === "ready") worker.postMessage({ type: "stop" });
    if (browserTalking || [...jobs.values()].some((j) => j.mode === "browser")) { try { speechSynthesis.cancel(); } catch (e) { /* none */ } }
    browserTalking = false;
    const pending = [...jobs.values()]; jobs.clear();
    pending.forEach((j) => j.resolve({ stopped: true }));
    setSpeaking(false);
  }

  /* ======================= MODEL (worker) ======================= */
  function setStatus(s) { if (E.status === s) return; E.status = s; emit("status", s); }
  function setProgress(p) { p = Math.max(0, Math.min(100, Math.round(p))); if (p === E.progress) return; E.progress = p; emit("progress", p); }
  function fail(message) {
    E.error = message;
    console.warn("[voice] Kokoro unavailable: " + message + (CFG.FALLBACK_TO_BROWSER_VOICE ? " (using the browser voice instead)" : ""));
    setStatus("error"); emit("error", message);
    for (const j of [...jobs.values()]) if (j.mode === "kokoro") finishJob(j);
  }
  function blobWorker(src) {
    // A classic worker: pages opened from a file can't start module workers from a Blob, but classic ones
    // can, and they can still import() kokoro-js from jsDelivr.
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    return new Worker(url);
  }
  function makeWorker() {
    const url = CFG.WORKER_URL ? new URL(CFG.WORKER_URL, SCRIPT_URL).href : new URL("voice-worker.js", SCRIPT_URL).href;
    if (location.protocol !== "file:") return Promise.resolve(new Worker(url, { type: "module" }));
    // Opened from a file: browsers block workers made from files, so load the worker file as a
    // plain script (allowed) and start it from a Blob.
    return new Promise((resolve, reject) => {
      if (window.KOKORO_WORKER_SRC) { resolve(blobWorker(window.KOKORO_WORKER_SRC)); return; }
      const sc = document.createElement("script");
      sc.src = url;
      sc.onload = () => (window.KOKORO_WORKER_SRC ? resolve(blobWorker(window.KOKORO_WORKER_SRC)) : reject(new Error("voice-worker.js did not load")));
      sc.onerror = () => reject(new Error("voice-worker.js was not found next to voice-engine.js"));
      document.head.appendChild(sc);
    });
  }
  function init() {
    if (initPromise) return initPromise;
    if (CFG.FORCE_BROWSER) { fail("Kokoro is switched off (?voice=browser)"); initPromise = Promise.resolve(false); return initPromise; }
    setStatus("loading"); setProgress(0);
    initPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      makeWorker().then((w) => {
        worker = w;
        worker.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === "log") log(m.msg);
          else if (m.type === "progress") setProgress(m.progress);
          else if (m.type === "ready") {
            E.device = m.device; E.dtype = m.dtype; E.availableVoices = m.voices || null;
            setProgress(100); setStatus("ready");
            log("Voice ready on " + (m.device === "webgpu" ? "WebGPU" : "the CPU (WASM)") + ", " + m.dtype);
            if (pendingPrepare) { worker.postMessage(pendingPrepare); pendingPrepare = null; }
            finish(true);
          } else if (m.type === "audio") {
            const job = jobs.get(m.id);
            if (typeof E._onAudio === "function") { try { E._onAudio(m.audio, m.sampleRate, m.text); } catch (err) { /* test hook */ } }
            if (job) playSentence(job, m.audio, m.sampleRate, m.text);
          } else if (m.type === "plan") {
            const en = ready.get(m.key) || { parts: [] };
            en.texts = m.texts; ready.delete(m.key); ready.set(m.key, en);
            while (ready.size > READY_MAX) ready.delete(ready.keys().next().value);
          } else if (m.type === "made") {
            const en = ready.get(m.key);
            if (en) en.parts[m.index] = { pcm: m.audio, sr: m.sampleRate };
          } else if (m.type === "end") {
            const job = jobs.get(m.id);
            if (job) { job.workerDone = true; checkJob(job); }
          } else if (m.type === "error") {
            if (m.fatal) { fail(m.message); finish(false); }
            else { console.warn("[voice] could not speak a line: " + m.message); const job = jobs.get(m.id); if (job) { job.workerDone = true; checkJob(job); } }
          }
        };
        worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail("the voice worker could not start" + (e && e.message ? ": " + e.message : "")); finish(false); };
        worker.postMessage({ type: "init", cfg: {
          kokoroUrl: CFG.KOKORO_URL, kokoroWebUrl: CFG.KOKORO_WEB_URL, transformersUrl: CFG.TRANSFORMERS_URL,
          modelId: CFG.MODEL_ID, modelBaseUrl: CFG.MODEL_BASE_URL ? new URL(CFG.MODEL_BASE_URL, SCRIPT_URL).href : null,
          modelFallbackToHub: CFG.MODEL_FALLBACK_TO_HUB !== false, webgpuDtype: CFG.WEBGPU_DTYPE, wasmDtype: CFG.WASM_DTYPE,
          forceCpu: !!CFG.FORCE_CPU, defaultVoice: CFG.DEFAULT_VOICE,
          warmVoices: Object.values(E.voiceMap).filter((v) => VOICE_IDS.has(v))
        } });
      }).catch((err) => { fail(String((err && err.message) || err)); finish(false); });
    });
    return initPromise;
  }

  /* ======================= PUBLIC OBJECT ======================= */
  const E = {
    status: "idle", progress: 0, device: null, dtype: null, error: null,
    isSpeaking: false, level: 0, muted: false, useBrowserVoice: false,
    voiceMap: Object.assign({}, CFG.VOICE_MAP), config: CFG, availableVoices: null,
    onStart: null, onEnd: null, onSentence: null, onStatus: null, onProgress: null, onLevel: null, onError: null,
    on(ev, fn) { listeners[ev].add(fn); return () => listeners[ev].delete(fn); },
    init, speak, stream, stop, prepare, cleanText, unlockAudio,
    listVoices() { return VOICES.map((v) => Object.assign({}, v)); },
    setVoiceMap(map) { Object.assign(E.voiceMap, map || {}); return E.voiceMap; },
    setMuted(m) { E.muted = !!m; if (E.muted) stop(); },
    setFallback(on) { CFG.FALLBACK_TO_BROWSER_VOICE = !!on; },
    get audioContext() { return ctx; }
  };
  window.VoiceEngine = E;
  window.dispatchEvent(new Event("voiceengine"));
})();
