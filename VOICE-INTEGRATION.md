# Kokoro voice for Lock Down the Office

Sam and the question reader speak with Kokoro, a text-to-speech model that runs entirely in the browser. No installs, no npm, no build step, no server, no API keys. The model is hosted with the game, so nothing has to come from huggingface.co.

## Files

| File | What it does |
|---|---|
| `index.html` | The game, with the edits listed below. |
| `voice-engine.js` | The engine the game talks to (`window.VoiceEngine`). Plays audio, keeps the queue, cleans text, falls back to the browser voice. |
| `voice-worker.js` | Runs the Kokoro model in a Web Worker so the game never freezes. Started by the engine. |
| `models/Kokoro-82M-v1.0-ONNX/` | The model itself (about 430 MB), hosted with the game. |
| `.nojekyll` | Tells GitHub Pages to publish the files as they are, without running its site builder over the model folder. |

Keep them together, in the same layout.

## How it works

1. On page load the engine starts a Web Worker, which imports **kokoro-js 1.2.1** from jsDelivr (`https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm`, pinned). If that import fails it uses the package's web build from the same version.
2. The model files come from `models/Kokoro-82M-v1.0-ONNX/` next to the game. If that folder is missing or incomplete, or the game was opened as a file, the missing files come from huggingface.co instead (this can be switched off).
3. **WebGPU with fp32** first; if the browser has no WebGPU or loading fails, **WASM on the CPU with q8**. The browser console says which one is running.
4. After loading, it speaks a short throwaway line in each voice the game uses, so the first real line isn't slow.
5. Text is cleaned (markdown, emojis, links, code, `*stage directions*` and `[notes]` removed), split into sentences, and each sentence plays the moment it's ready, back to back on one shared AudioContext.
6. **Lines are made ahead of time.** The game tells the engine which lines come next (Sam's next three lines, the questions and their answers), and the worker makes them whenever it has nothing more urgent to do. The engine keeps the finished sentences and plays them itself, so a prepared line starts at once, even while the worker is busy making the next one. This matters on the CPU, where making a sentence can take longer than saying it. Speech that's needed now always goes before lines made ahead; a line that wasn't prepared (a hint, a decoy remark) can still wait for the sentence the worker is making at that moment.
7. A question waits for Sam's line to finish, and the code digit waits for Sam's closing line, instead of cutting them off.
8. If Kokoro can't load, the badge says so and the game speaks with the browser's built-in voice instead (this can be switched off).

**Download size:** the first visit downloads the model once, then the browser keeps it: about **330 MB** on WebGPU (fp32) or about **90 MB** on the CPU (q8). Later visits load from the browser cache, with no model download at all. On a slow connection the badge on the start screen shows the progress, and the game is silent (text only) until the voice is ready.

## The model copy

`models/Kokoro-82M-v1.0-ONNX/` holds Kokoro-82M v1.0 (Apache-2.0), the ONNX export by onnx-community:

```
Kokoro-82M-v1.0-ONNX/
  manifest.json                    parts, sizes and SHA-256 of every file
  SOURCE.md                        where it came from, how it was checked
  config.json, tokenizer.json, tokenizer_config.json
  voices/*.bin                     all 28 voices
  onnx/model.onnx.part0 … part6    fp32 model (WebGPU), 326 MB in 7 parts
  onnx/model_quantized.onnx.part0, part1   q8 model (CPU), 92 MB in 2 parts
```

The two model files are split into 45 MB parts because GitHub refuses files over 100 MB. `voice-worker.js` reads `manifest.json` and joins the parts while they download; the browser caches the joined file, so the parts are only fetched once.

**Checked:** both joined model files match the SHA-256 values onnx-community published, and the voices match the official kokoro-js package. In Chrome with huggingface.co blocked, the game loaded the CPU model from this folder and spoke; the file the browser cached was byte-identical to the official one, and the speech matched the same model run outside the browser.

**Moving it to an internal server:** copy the whole folder as it is (parts and `manifest.json` included) and set `MODEL_BASE_URL` in `index.html` to its address. If that server is a different site from the game, it must allow cross-origin requests (CORS).

**GitHub Pages limits:** a published Pages site can be up to 1 GB, and Pages has a soft bandwidth limit of 100 GB a month. Each new player downloads the model once, so that's roughly 300 first-time players a month on WebGPU (about 1,000 on the CPU). For a company-wide rollout, host the folder on an internal server.

## Settings

Set these in `window.VOICE_CONFIG` in `index.html` (or change the defaults at the top of `voice-engine.js`):

| Setting | Default | Meaning |
|---|---|---|
| `VOICE_MAP` | `{ sam: "am_michael", narrator: "af_heart" }` | Voice per character. Players can also change Sam's voice on the start screen. |
| `MODEL_BASE_URL` | `"models/Kokoro-82M-v1.0-ONNX/"` | Where the model copy is, relative to `voice-engine.js` or a full address. `null` downloads everything from huggingface.co. |
| `MODEL_FALLBACK_TO_HUB` | `true` | If the copy is missing or incomplete, get the missing files from huggingface.co. `false` never contacts huggingface.co: the game uses the browser voice instead. |
| `FALLBACK_TO_BROWSER_VOICE` | `true` | Use the browser voice if Kokoro fails. `false` keeps the game silent instead. Also `VoiceEngine.setFallback(true/false)`. |
| `FALLBACK_WHILE_LOADING` | `false` | Also use the browser voice while Kokoro is still downloading. |
| `WEBGPU_DTYPE` / `WASM_DTYPE` | `"fp32"` / `"q8"` | Model precision on each device. |
| `FORCE_CPU` | `false` | Skip WebGPU. Same as adding `?voice=cpu` to the address. |
| `DEFAULT_VOICE`, `SPEED` | `"af_heart"`, `1` | Fallback voice and speaking speed. |

Testing switches you can add to the game address: `?voice=cpu` (skip WebGPU) and `?voice=browser` (skip Kokoro, test the fallback).

## Engine API

```js
await VoiceEngine.init();                          // true when ready, false if unavailable
await VoiceEngine.speak("Hello.", { character: "sam" });   // resolves when playback ends: { stopped }
const s = VoiceEngine.stream({ voice: "af_heart" }); s.push("Some "); s.push("words. "); s.close(); await s.done;
VoiceEngine.stop();                                // stop now, clear the queue
VoiceEngine.prepare(["Next line.", { text: "A question?", character: "narrator" }], { character: "sam" });
                                                   // make lines ahead of time; each call replaces the last list
VoiceEngine.listVoices();                          // [{ id, name, language, gender, grade }]
VoiceEngine.isSpeaking; VoiceEngine.level;         // level: 0..1, updated every frame (lip-sync, speaking light)
VoiceEngine.onStart = () => {}; VoiceEngine.onEnd = () => {}; VoiceEngine.onSentence = (text) => {};
VoiceEngine.on("status", s => {});  // "loading" | "ready" | "error"; also "progress", "level", "error"
```

## Edits to index.html

### 1. Load the engine and its settings (in <head>)

**Before**

```html
<title>Lock Down the Office – Data Privacy Escape</title>
```

**After**

```html
<title>Lock Down the Office – Data Privacy Escape</title>
<script>
  /* Voice settings. Every option is listed at the top of voice-engine.js. */
  window.VOICE_CONFIG = {
    VOICE_MAP: { sam: "am_michael", narrator: "af_heart" },  // Sam on the radio, and the voice that reads questions
    MODEL_BASE_URL: "models/Kokoro-82M-v1.0-ONNX/"   // the model copy hosted with the game (null = download from huggingface.co)
  };
</script>
<script src="voice-engine.js" defer></script>
```

### 2. Styles: voice status badge, voice picker, Sam's speaking light

**Before**

```html
#radio .av{flex:none;width:clamp(38px,3.6vw,52px);height:clamp(38px,3.6vw,52px);border-radius:50%;display:grid;place-items:center;
  background:var(--amber);color:#2a1a00;font:800 clamp(18px,1.8vw,26px) var(--sans);box-shadow:0 0 0 3px rgba(255,178,62,.25)}
```

**After**

```html
#radio .av{flex:none;width:clamp(38px,3.6vw,52px);height:clamp(38px,3.6vw,52px);border-radius:50%;display:grid;place-items:center;
  background:var(--amber);color:#2a1a00;font:800 clamp(18px,1.8vw,26px) var(--sans);
  box-shadow:0 0 0 calc(3px + var(--lv,0) * 12px) rgba(255,178,62,calc(.25 + var(--lv,0) * .45));transition:box-shadow .06s linear}
.vbadge{display:inline-flex;align-items:center;gap:.45em;border-radius:999px;padding:.35em .9em;font:600 clamp(12px,1.15vw,15px) var(--sans);background:#d6e0e8;color:var(--ink)}
.vbadge::before{content:"";width:.6em;height:.6em;border-radius:50%;background:#7d93a6}
.vbadge.load::before{background:var(--amber);animation:blink 1s steps(2) infinite}
.vbadge.ok::before{background:var(--ok)}
.vbadge.err::before{background:var(--no)}
.vsel{display:inline-flex;align-items:center;gap:.5em;font:600 clamp(12px,1.15vw,15px) var(--sans);color:var(--ink)}
.vsel select{font:inherit;border:2px solid #b6c6d3;border-radius:999px;padding:.25em .7em;background:#fff;color:var(--ink)}
#vtag{position:fixed;right:16px;top:calc(clamp(60px,6vw,76px) + 14px);z-index:26;opacity:0;transition:opacity .4s;pointer-events:none}
#vtag.on{opacity:1}
```

### 3. Status chip shown during play while the voice loads

**Before**

```html
  <div id="heard"></div>
```

**After**

```html
  <div id="heard"></div>
  <div id="vtag"><span class="vbadge"></span></div>
```

### 4. Read aloud is on by default now that there is a proper voice

**Before**

```html
misses:[], tts:false, dwell:true,
```

**After**

```html
misses:[], tts:true, dwell:true,
```

### 5. speak(): use the voice engine, make upcoming lines ahead of time, keep the old browser-voice code as a last resort

**Before**

```html
function speak(text){ if(!G.tts||!("speechSynthesis" in window))return;
  try{ speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text); u.lang="en-GB"; Voice.mute=true;
    u.onend=()=>setTimeout(()=>Voice.mute=false,500); u.onerror=()=>Voice.mute=false; speechSynthesis.speak(u);}catch(e){} }
```

**After**

```html
// after=true: wait for the line that's playing instead of cutting it off (a question right after Sam's line).
function speak(text,who="narrator",after=false){ SAID.add(text); if(!G.tts)return;
  if(VE){ if(!after)VE.stop(); VE.speak(text,{character:who}); prepScene(G.running?G.idx:0); return; }
  if(!("speechSynthesis" in window))return;
  try{ if(!after)speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text); u.lang="en-GB"; Voice.mute=true;
    u.onend=()=>setTimeout(()=>Voice.mute=false,500); u.onerror=()=>Voice.mute=false; speechSynthesis.speak(u);}catch(e){} }
/* ---------- voice engine hookup (voice-engine.js) ---------- */
const LINES={ lostGone:"Gone? It's not on my cameras either. What do you do?",
  lostBlocked:"Old card blocked. I've sent a temporary card to the door. Tap it.",
  stickyBack:"The back says “pw: Summer2026!”. That's your password." };
/* Sam's lines and the questions, in the order they come up. The voice engine makes the next few
   ahead of time, so they start without a wait even when the voice runs on a slow CPU. */
const TASK_Q={badgeTray:"badgeIssue",holdLift:"liftVisitor",lostCard:"lostCard",phone:"phoneCall",final:"breach"};
const SAID=new Set();
let SCRIPT=null;
function script(){
  if(SCRIPT)return SCRIPT; SCRIPT=[];
  const add=(i,t,who)=>{ if(t)SCRIPT.push({i,t,who}); };
  const task=(i,name)=>{ const D=DECISIONS[TASK_Q[name]];
    if(name==="lostCard")add(i,LINES.lostGone,"sam");
    if(name==="sticky")add(i,LINES.stickyBack,"sam");
    if(D){ add(i,D.text,"narrator"); add(i,"Correct. "+D.why,"narrator"); }
    if(name==="lostCard")add(i,LINES.lostBlocked,"sam"); };
  SCENES.forEach((S,i)=>{
    S.beats.forEach(b=>{
      if(b.hunt){ add(i,b.hunt.brief,"sam"); b.hunt.risks.forEach(r=>{ add(i,r.found,"sam"); task(i,r.task); }); }
      else { add(i,b.say,"sam"); task(i,b.task); } });
    add(i,S.outro,"sam"); });
  return SCRIPT;
}
// Ask the voice engine to make the next three lines nobody has heard yet, from scene i on.
function prepScene(i){
  if(!VE||!VE.prepare||!G.tts)return;
  const out=[];
  for(const x of script()){ if(x.i<i||SAID.has(x.t))continue; out.push({text:x.t,character:x.who}); if(out.length>=3)break; }
  VE.prepare(out);
}
let VE=null;
function voiceState(){
  if(!VE) return performance.now()<6000?["Loading voice…","load"]:["Voice unavailable","err"];
  if(VE.status==="ready") return [VE.device==="webgpu"?"Voice ready (WebGPU)":"Voice ready (CPU)","ok"];
  if(VE.status==="error") return [VE.config.FALLBACK_TO_BROWSER_VOICE?"Voice unavailable (using browser voice)":"Voice unavailable","err"];
  return [`Loading voice… ${Math.round(VE.progress)}%`,"load"];
}
function paintVoice(){
  const [t,c]=voiceState(); $$(".vbadge").forEach(b=>{ b.textContent=t; b.className="vbadge "+c; });
  const vt=$("#vtag"), show=G.running&&c!=="ok"&&!(VE&&VE.status==="error"&&paintVoice.errShown);
  vt.classList.toggle("on",show); $("#bTts").title=t;
  if(VE&&VE.status==="error"&&G.running&&!paintVoice.errShown){ paintVoice.errShown=true; setTimeout(()=>{ vt.classList.remove("on"); },4000); }
}
function hookVoice(){
  if(VE||!window.VoiceEngine)return; VE=window.VoiceEngine;
  try{ const v=localStorage.getItem("lde_sam_voice"); if(v)VE.setVoiceMap({sam:v}); }catch(e){}
  VE.on("status",s=>{ paintVoice(); if(s==="ready"&&G.running)toast(voiceState()[0]); });
  VE.on("progress",paintVoice);
  VE.on("start",()=>{ Voice.mute=true; });
  VE.on("end",()=>{ setTimeout(()=>{ Voice.mute=false; },400); });
  paintVoice(); renderVoicePicker(); VE.init(); prepScene(0);
}
function renderVoicePicker(){
  const box=$("#vpick"); if(!box||!VE)return;
  const cur=VE.voiceMap.sam||VE.config.DEFAULT_VOICE;
  const opts=VE.listVoices().map(v=>`<option value="${v.id}"${v.id===cur?" selected":""}>${esc(v.name)} (${v.language==="en-gb"?"UK":"US"}, ${v.gender.toLowerCase()})</option>`).join("");
  box.innerHTML=`<label class="vsel">Sam's voice <select id="vsel">${opts}</select></label>`;
  $("#vsel").addEventListener("change",e=>{ const v=e.target.value; VE.setVoiceMap({sam:v}); try{ localStorage.setItem("lde_sam_voice",v); }catch(err){}
    VE.stop(); VE.speak("Sam here, Security. Ready when you are.",{character:"sam"}); prepScene(0); });
}
if(window.VoiceEngine)hookVoice(); else { addEventListener("voiceengine",hookVoice); setTimeout(()=>{ if(!VE)paintVoice(); },6200); }
onFrame(()=>{ const av=$("#radio .av"); if(av)av.style.setProperty("--lv",(VE&&VE.isSpeaking?VE.level:0).toFixed(3)); },false);
```

### 6. Sam's radio lines use Sam's voice

**Before**

```html
    speak("Sam. "+text); });
```

**After**

```html
    speak(text,"sam"); });
```

### 7. Settings area on the start screen: voice status and voice picker

**Before**

```html
    <div class="toggles">${tg("tgTts",G.tts,"🔊 Read aloud")}${tg("tgDwell",G.dwell,"⏱ Hold still to press buttons")}</div>
```

**After**

```html
    <div class="toggles">${tg("tgTts",G.tts,"🔊 Read aloud")}${tg("tgDwell",G.dwell,"⏱ Hold still to press buttons")}<span class="vbadge"></span><span id="vpick"></span></div>
```

### 8. Read-aloud toggle on the start screen also stops the voice

**Before**

```html
  else if(a==="tgTts"){ G.tts=!G.tts; b.classList.toggle("on",G.tts); if(G.tts)speak("Sam's lines and the questions will be read aloud."); }
```

**After**

```html
  else if(a==="tgTts"){ G.tts=!G.tts; b.classList.toggle("on",G.tts); if(G.tts)speak("Sam's lines and the questions will be read aloud."); else if(VE)VE.stop(); }
```

### 9. Pause stops the voice

**Before**

```html
  try{ if(on)speechSynthesis.pause(); else speechSynthesis.resume(); }catch(e){} }
```

**After**

```html
  try{ if(on)speechSynthesis.pause(); else speechSynthesis.resume(); }catch(e){}
  if(on&&VE)VE.stop(); }
```

### 10. The 🔊 button is the mute toggle

**Before**

```html
$("#bTts").addEventListener("click",()=>{ G.tts=!G.tts; updateHud(); toast(G.tts?"Reading aloud":"Read-aloud off"); });
```

**After**

```html
$("#bTts").addEventListener("click",()=>{ G.tts=!G.tts; if(!G.tts&&VE)VE.stop(); updateHud(); toast(G.tts?"Reading aloud":"Read-aloud off"); });
```

### 11. Badge and picker appear whenever the start screen is drawn

**Before**

```html
    <div class="status" id="st">${esc(note||"Best in Chrome or Edge. Your camera and microphone stay on your computer.")}</div>`,"intro",true);
```

**After**

```html
    <div class="status" id="st">${esc(note||"Best in Chrome or Edge. Your camera and microphone stay on your computer.")}</div>`,"intro",true);
  paintVoice(); renderVoicePicker();
```

### 12. A question waits for Sam's line to finish instead of cutting it off

**Before**

```html
function readQ(auto){ const Q=G.q; if(!Q)return; const was=G.tts; if(!auto)G.tts=true;
  speak(Q.D.text+" Option A. "+Q.D.opts[Q.order[0]].t+". Option B. "+Q.D.opts[Q.order[1]].t+". Option C. "+Q.D.opts[Q.order[2]].t); G.tts=was; }
```

**After**

```html
function readQ(auto){ const Q=G.q; if(!Q)return; const was=G.tts; if(!auto)G.tts=true; SAID.add(Q.D.text);
  speak(Q.D.text+" Option A. "+Q.D.opts[Q.order[0]].t+". Option B. "+Q.D.opts[Q.order[1]].t+". Option C. "+Q.D.opts[Q.order[2]].t,"narrator",!!auto); G.tts=was; }
```

### 13. Lines spoken inside the lost-card task come from LINES (so they can be made ahead)

**Before**

```html
  await radio("Gone? It's not on my cameras either. What do you do?",3500); await sleep(500);
  await decide(DECISIONS.lostCard);
  await radio("Old card blocked. I've sent a temporary card to the door. Tap it.",5000);
```

**After**

```html
  await radio(LINES.lostGone,3500); await sleep(500);
  await decide(DECISIONS.lostCard);
  await radio(LINES.lostBlocked,5000);
```

### 14. The sticky-note line comes from LINES too

**Before**

```html
if(!told){ told=true; radio("The back says “pw: Summer2026!”. That's your password.",4500); } },
```

**After**

```html
if(!told){ told=true; radio(LINES.stickyBack,4500); } },
```

### 15. A new run starts with nothing heard yet

**Before**

```html
  clearRun(); G.run++; G.scenes=SCENES; G.idx=0;
```

**After**

```html
  clearRun(); G.run++; G.scenes=SCENES; G.idx=0; SAID.clear();
```

### 16. Entering a room puts its lines next in line to be made

**Before**

```html
  $("#fade").style.opacity=0; banner(S); await sleep(1100);
}
```

**After**

```html
  prepScene(i);
  $("#fade").style.opacity=0; banner(S); await sleep(1100);
}
```

### 17. The code digit is read after Sam's closing line, not over it

**Before**

```html
  speak("Zone cleared. Code digit "+G.found+" is "+d);
```

**After**

```html
  speak("Zone cleared. Code digit "+G.found+" is "+d,"narrator",true);
```


## Browser test checklist

Use Chrome or Edge, open the game from its web address (the GitHub Pages link, or any web server), and press F12 to open the Console.

1. **Model loads from the game's own folder.** The start screen badge goes from "Loading voice… 0%" up to "Voice ready (WebGPU)" (or "Voice ready (CPU)"). The Console prints `[voice] Model files load from …/models/Kokoro-82M-v1.0-ONNX/` and `[voice] Kokoro is running on WebGPU with fp32`. In the Network tab, filter for `huggingface`: nothing. Reload the page: it's ready again within seconds, from the cache.
2. **Speaks one line.** In the Console run `VoiceEngine.speak("Sam here, Security. Can you hear me?", {character: "sam"})`. You hear it, and the result shows `{stopped: false}` when it finishes. Changing "Sam's voice" on the start screen plays a sample too.
3. **Streams a long reply.** Paste this; speech should start after the first sentence arrives, continue without gaps, and skip "coughs":
   ```js
   const h = VoiceEngine.stream({character: "narrator"});
   const w = "This reply arrives a few words at a time. The first sentence starts before the rest has arrived. The next one follows straight after. *coughs* Stage directions are skipped.".split(" ");
   let i = 0; const t = setInterval(() => i < w.length ? h.push(w[i++] + " ") : (clearInterval(t), h.close()), 120);
   ```
4. **stop() cuts off mid-sentence.** Run `VoiceEngine.speak("One two three four five six seven eight nine ten. Eleven twelve thirteen."); setTimeout(() => VoiceEngine.stop(), 1500)`. The audio stops at once, and `VoiceEngine.isSpeaking` is `false`. In the game, pausing while Sam talks does the same.
5. **Works with WebGPU disabled.** Add `?voice=cpu` to the end of the game address (or turn off "Use graphics acceleration when available" in Chrome Settings → System and relaunch). The badge should say "Voice ready (CPU)" and lines still play (the first time downloads the ~90 MB CPU model). Wait on the start screen for 20 seconds before pressing Start: Sam's first line should begin straight away, because it was made while you waited. `?voice=browser` checks the fallback: the badge says the voice is unavailable and the browser's own voice speaks instead.
