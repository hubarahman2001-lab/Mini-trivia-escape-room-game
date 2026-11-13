/* voice-worker.js
   Runs the Kokoro text-to-speech model inside a Web Worker, so the page never freezes.
   voice-engine.js starts it; you never load this file yourself.

   It works two ways:
   - On a web server (GitHub Pages, intranet): started as a module worker.
   - From a file opened by double-click (file://): browsers block workers made from files, so
     voice-engine.js loads this file as a plain <script>, reads the source below and starts it
     from a Blob instead. Nothing to set up either way.

   Messages in:  init {cfg} · open {id, voice, speed} · push {id, text} · close {id} · stop
                 prepare {items: [{key, voice, speed, pushes}], replace}
   Messages out: log · progress {progress} · ready {device, dtype, voices}
                 audio {id, text, audio: Float32Array, sampleRate} · end {id} · error {message, fatal, id}
                 plan {key, texts} · made {key, index, audio: Float32Array, sampleRate}   (lines made ahead of time)
*/
function kokoroWorker() {
  "use strict";

  let tts = null;                // the loaded KokoroTTS model
  let ready = false;             // warmed up: lines can be made now
  let TextSplitterStream = null; // kokoro-js sentence splitter (same module as the model)
  let cfg = null;
  const queue = [];              // jobs waiting to be spoken, in order
  const jobs = new Map();        // id -> job
  let pumping = false;

  // Sentences are made one at a time by the model. Sentences someone is waiting to hear (want) always
  // go before sentences made ahead of time (prep). Made sentences are kept for a while (made), so a
  // line that was prepared, or spoken before, starts at once.
  const made = new Map();        // "voice|speed|sentence" -> entry {key, voice, speed, text, p, waiting, urgent}
  const MADE_MAX = 30;           // about two minutes of speech
  const PREP_MAX = 24;           // sentences waiting to be made ahead of time
  let want = [], prep = [], making = false;

  const post = (msg, transfer) => self.postMessage(msg, transfer || []);
  const log = (msg) => post({ type: "log", msg: String(msg) });
  const errText = (e) => String((e && (e.message || e.reason)) || e);

  self.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "init") { init(m.cfg); return; }
    if (m.type === "open") {
      if (!ready) { post({ type: "end", id: m.id }); return; }
      const job = { id: m.id, voice: m.voice, speed: m.speed, splitter: new TextSplitterStream(), closed: false, cancelled: false };
      jobs.set(job.id, job); queue.push(job); pump();
      return;
    }
    if (m.type === "push") { const j = jobs.get(m.id); if (j && !j.closed && !j.cancelled) j.splitter.push(m.text); return; }
    if (m.type === "close") { const j = jobs.get(m.id); if (j && !j.closed) { j.closed = true; j.splitter.close(); } return; }
    if (m.type === "stop") {
      for (const j of jobs.values()) cancel(j);
      jobs.clear(); queue.length = 0;
      // Sentences the stopped lines were still waiting for: don't make them.
      for (const en of want) if (en.waiting) { forget(en); en.reject(new Error("stopped")); }
      want = [];
      return;
    }
    if (m.type === "prepare") { if (ready) prepare(m.items || [], m.replace !== false); return; }
  };

  // Stop a job without generating anything else for it.
  function cancel(j) {
    j.cancelled = true;
    try { j.splitter._buffer = ""; j.splitter._sentences.length = 0; } catch (e) { /* internal fields: best effort */ }
    if (!j.closed) { j.closed = true; try { j.splitter.close(); } catch (e) { /* already closed */ } }
  }

  function forget(en) { if (made.get(en.key) === en) made.delete(en.key); }

  // The audio for one sentence: from the made lines if it's there, otherwise queued for the model.
  function audioFor(voice, speed, text, urgent) {
    const key = voice + "|" + speed + "|" + text;
    let en = made.get(key);
    if (en) {
      made.delete(key); made.set(key, en);                         // recently used: keep it longest
      if (urgent && en.waiting && !en.urgent) {                    // someone is waiting for it now: move it up
        en.urgent = true;
        const i = prep.indexOf(en); if (i >= 0) prep.splice(i, 1);
        want.push(en);
      }
      return en.p;
    }
    en = { key, voice, speed, text, waiting: true, urgent: !!urgent };
    en.p = new Promise((resolve, reject) => { en.resolve = resolve; en.reject = reject; });
    en.p.catch(() => {});                                          // nobody may be listening (prepared lines)
    made.set(key, en);
    for (const [k, old] of made) { if (made.size <= MADE_MAX) break; if (!old.waiting) made.delete(k); }
    (urgent ? want : prep).push(en);
    makeNext();
    return en.p;
  }

  // The model makes one sentence at a time: waiting speech first, then lines made ahead.
  async function makeNext() {
    if (making) return;
    making = true;
    try {
      for (;;) {
        // Making a sentence keeps this thread busy, so let messages that came in meanwhile (new speech,
        // stop) be handled before choosing the next one. Otherwise prepared lines would run back to back.
        await new Promise((r) => setTimeout(r, 0));
        const en = want.shift() || prep.shift();
        if (!en) break;
        if (!en.waiting) continue;
        en.waiting = false;
        try {
          const a = await tts.generate(en.text, { voice: en.voice, speed: en.speed });
          en.resolve({ pcm: a.audio, sr: a.sampling_rate });
        } catch (err) {
          forget(en); en.reject(err);
        }
      }
    } finally {
      making = false;
    }
  }

  // Lines that will be spoken soon: split them into sentences exactly as speech would, make them whenever
  // the model has nothing more urgent to do, and send each sentence to the page as soon as it's made. The
  // page keeps them and plays them itself, so a prepared line starts at once even while this thread is
  // busy making the next one.
  async function prepare(items, replace) {
    const lines = [];
    for (const it of items) {
      const sp = new TextSplitterStream();
      for (const t of it.pushes || []) sp.push(t);
      sp.close();
      const texts = [];
      for await (const s of sp) { const text = String(s).trim(); if (text) texts.push(text); }
      if (texts.length) lines.push([it, texts]);
    }
    if (replace) { for (const en of prep) if (en.waiting && !en.urgent) forget(en); prep = []; }
    let budget = PREP_MAX;
    for (const [it, texts] of lines) {
      if (budget <= 0) break;
      post({ type: "plan", key: it.key, texts });
      texts.slice(0, budget).forEach((text, index) => {
        audioFor(it.voice, it.speed, text, false).then((r) => {
          const pcm = new Float32Array(r.pcm);
          post({ type: "made", key: it.key, index, audio: pcm, sampleRate: r.sr }, [pcm.buffer]);
        }, () => { /* dropped or failed: it will be made when it's spoken */ });
      });
      budget -= texts.length;
    }
  }

  // Speak jobs one at a time, sentence by sentence, as text arrives.
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const j = queue.shift();
      if (j.cancelled) continue;
      try {
        for await (const sentence of j.splitter) {
          if (j.cancelled) break;
          const text = String(sentence).trim();
          if (!text) continue;
          const r = await audioFor(j.voice, j.speed, text, true);
          if (j.cancelled) break;
          const pcm = new Float32Array(r.pcm);   // the made sentence stays here; this copy is handed over
          post({ type: "audio", id: j.id, text, audio: pcm, sampleRate: r.sr }, [pcm.buffer]);
        }
      } catch (err) {
        if (!j.cancelled) post({ type: "error", id: j.id, message: errText(err) });
      }
      jobs.delete(j.id);
      if (!j.cancelled) post({ type: "end", id: j.id });
    }
    pumping = false;
  }

  // Model files come from the copy hosted next to the game (cfg.modelBaseUrl) when it's there, and
  // from huggingface.co otherwise. The two big model files are stored in parts (GitHub refuses files
  // over 100 MB); they are joined back together here while they download.
  async function useModelCopy(modelId, base, fallbackToHub) {
    const hub = "https://huggingface.co/" + modelId + "/resolve/main/";
    const root = base.endsWith("/") ? base : base + "/";
    if (root.startsWith("file:")) {
      if (!fallbackToHub) throw new Error("the model copy can't be read when the game is opened from a file, and MODEL_FALLBACK_TO_HUB is off");
      log("Opened from a file: the model copy can't be read from here, using huggingface.co");
      return false;
    }
    const realFetch = self.fetch.bind(self);
    let manifest = null;
    try { const r = await realFetch(root + "manifest.json", { cache: "no-cache" }); if (r.ok) manifest = await r.json(); } catch (e) { /* no copy at this address */ }
    if (!manifest) {
      if (!fallbackToHub) throw new Error("no model copy at " + root + ", and MODEL_FALLBACK_TO_HUB is off");
      log("No model copy at " + root + ", using huggingface.co");
      return false;
    }
    const split = manifest.split || {};
    const checked = new Map();   // path -> Promise<boolean>: are all parts there?
    const partsThere = (path) => {
      if (!checked.has(path)) checked.set(path, Promise.all(split[path].parts.map((p) => realFetch(root + p.file, { method: "HEAD" }).then((r) => r.ok).catch(() => false))).then((all) => all.every(Boolean)));
      return checked.get(path);
    };
    const joined = (path) => {
      const info = split[path]; let i = 0, reader = null;
      const body = new ReadableStream({
        async pull(ctrl) {
          for (;;) {
            if (!reader) {
              if (i >= info.parts.length) { ctrl.close(); return; }
              const part = info.parts[i++], get = () => realFetch(root + part.file).catch(() => null);
              let r = await get();
              if (!r || !r.ok) r = await get();   // one retry for a dropped connection
              if (!r || !r.ok || !r.body) throw new Error("model part missing: " + part.file);
              reader = r.body.getReader();
            }
            const { done, value } = await reader.read();
            if (done) { reader = null; continue; }
            ctrl.enqueue(value); return;
          }
        }
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(info.size) } });
    };
    self.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      if (!url.startsWith(hub)) return realFetch(input, init);
      const path = url.slice(hub.length);
      try {
        if (split[path]) { if (await partsThere(path)) return joined(path); }
        else { const r = await realFetch(root + path, init); if (r.ok) return r; }
      } catch (e) { log("Model copy failed for " + path + " (" + errText(e) + ")"); }
      if (fallbackToHub) { log(path + " is not in the model copy, using huggingface.co"); return realFetch(input, init); }
      return new Response(null, { status: 404, statusText: "Not in the model copy" });
    };
    log("Model files load from " + root);
    return true;
  }

  async function init(c) {
    cfg = c;
    try {
      if (cfg.modelBaseUrl) await useModelCopy(cfg.modelId, cfg.modelBaseUrl, cfg.modelFallbackToHub !== false);

      // 1. kokoro-js, pinned. Try the +esm build first, then the package's own web build.
      let mod, viaEsm = true;
      try { mod = await import(cfg.kokoroUrl); }
      catch (e) {
        viaEsm = false;
        log("kokoro-js +esm import failed (" + errText(e) + "). Trying the web build.");
        mod = await import(cfg.kokoroWebUrl);
      }
      if (!mod || !mod.KokoroTTS || !mod.TextSplitterStream) throw new Error("kokoro-js loaded, but KokoroTTS or TextSplitterStream is missing");
      log("kokoro-js 1.2.1 loaded (" + (viaEsm ? "+esm" : "web build") + ")");
      TextSplitterStream = mod.TextSplitterStream;

      // Without the Cache API (rare: some file:// setups) turn caching off instead of failing.
      if (typeof caches === "undefined" && viaEsm && cfg.transformersUrl) {
        try { const T = await import(cfg.transformersUrl); T.env.useBrowserCache = false; log("Browser cache not available here: the model will download on every visit"); }
        catch (e) { /* not fatal */ }
      }

      // 2. Download progress: add up every file the model needs (0-95%; warm-up is the last 5%).
      const files = new Map();
      let last = -1;
      const onProgress = (p) => {
        if (!p || !p.file) return;
        const f = files.get(p.file) || { loaded: 0, total: 0 };
        if (p.status === "progress") { if (p.total) f.total = p.total; if (p.loaded != null) f.loaded = p.loaded; }
        if (p.status === "done" && f.total) f.loaded = f.total;
        files.set(p.file, f);
        let L = 0, T = 0;
        for (const v of files.values()) { L += v.loaded; T += v.total; }
        // The small files (config, tokenizer) arrive first; stay at 0% until the big model file
        // has started, or the badge would jump to 95% and then back down.
        const pct = T > 5e6 ? Math.min(95, Math.floor((L / T) * 95)) : 0;
        if (pct !== last) { last = pct; post({ type: "progress", progress: pct }); }
      };

      // 3. WebGPU (fp32) first, then WASM on the CPU (q8).
      let device = "wasm";
      if (cfg.forceCpu) log("CPU forced by settings");
      else if (!("gpu" in navigator) || !navigator.gpu) log("WebGPU is not available in this browser");
      else {
        try { const adapter = await navigator.gpu.requestAdapter(); if (adapter) device = "webgpu"; else log("WebGPU: no suitable graphics adapter"); }
        catch (e) { log("WebGPU check failed: " + errText(e)); }
      }

      let dtype = null;
      if (device === "webgpu") {
        try {
          tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, { dtype: cfg.webgpuDtype, device: "webgpu", progress_callback: onProgress });
          dtype = cfg.webgpuDtype;
          await warmUp();
        } catch (e) {
          log("WebGPU load failed (" + errText(e) + "). Falling back to the CPU.");
          tts = null; device = "wasm";
        }
      }
      if (!tts) {
        files.clear(); last = -1;
        tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, { dtype: cfg.wasmDtype, device: "wasm", progress_callback: onProgress });
        dtype = cfg.wasmDtype;
        await warmUp();
      }
      log("Kokoro is running on " + (device === "webgpu" ? "WebGPU" : "the CPU (WASM)") + " with " + dtype);
      ready = true;
      post({ type: "ready", device, dtype, voices: Object.keys(tts.voices) });
    } catch (err) {
      post({ type: "error", fatal: true, message: errText(err) });
    }
  }

  // A short throwaway line per voice, so the first real line isn't slow (also downloads each voice file).
  async function warmUp() {
    post({ type: "progress", progress: 96 });
    const voices = [...new Set([cfg.defaultVoice].concat(cfg.warmVoices || []))].filter((v) => v && tts.voices[v]);
    for (const v of voices) await tts.generate("Ready.", { voice: v, speed: 1 });
    post({ type: "progress", progress: 100 });
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  // Loaded as a plain <script> by a page opened from file:// — give the source to voice-engine.js.
  window.KOKORO_WORKER_SRC = "(" + kokoroWorker.toString() + ")();";
} else {
  kokoroWorker();
}
