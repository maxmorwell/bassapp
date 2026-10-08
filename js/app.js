// app.js — the page. Load clip -> decode its audio -> analyse -> shake curve -> render.
// The model lives in shake.js (golden-tested against the reference generator); what the
// sliders show vs the model values lives in controls.js (per-control tested).
import { analyseAudio, energyPerFrame, synth, overscanFor, snapFps, blurRange, wobbleHz, displaySpectrum, bassShare, bassGain, bassPeakDb, levelGain, REF_H } from "./shake.js";
import { MAIN, ADVANCED, ALL, UI_PRESETS, presetModel, sliderFor, WOBBLE, TYPICAL_MIX } from "./controls.js";
import { WM_TEXT, WM_DEFAULTS, spotsFor, planWatermark, placeText, wmFont, drawWatermark, chooseSpots } from "./watermark.js";

const log = window.log;
const $ = id => document.getElementById(id);
const MAX_BLUR_DRAWS = 12;        // blur = averaged copies of the frame; cap per frame for speed
const PREVIEW_DEFAULT = 3;        // seconds; slider 3-10, back to 3 on a new clip
const OUTPUT = [["720p", 720], ["1080p", 1080], ["Original", 0]];   // by the SHORTER dimension
// Feedback goes to a form service (Google Form -> Sheet). Not set up yet: Send falls back to
// copying the report. Fill in the form's formResponse URL and its entry ids to switch it on.
const FEEDBACK_FORM = { action: "", fields: { worked: "", look: "", text: "", report: "" } };

let MB;
try {
  MB = await import("../vendor/mediabunny-1.61.3.min.mjs");
  log("library loaded (mediabunny 1.61.3, hosted with the page)");
} catch (e) {
  log("LIBRARY LOAD FAILED: " + (e && e.message));
  setStatus("anaStatus", "bad", "The video library could not load. Please send feedback below with the report ticked.");
  throw e;
}
const { Input, Output, BlobSource, BufferTarget, Mp4OutputFormat, Conversion, ALL_FORMATS, AudioSampleSink, EncodedPacketSink, CanvasSink, canEncodeVideo, canEncodeAudio, QUALITY_HIGH } = MB;

// ---------------------------------------------------------------- state ----------
const S = {
  file: null, meta: null,          // probe results
  an: null, offsetSec: 0,          // audio analysis (the expensive part, once per file)
  Ecache: new Map(),               // "p|fMin" -> energy per frame
  preset: UI_PRESETS[0], params: presetModel(UI_PRESETS[0]),   // REAL model values
  sliders: {},                     // what the sliders show (display only)
  outSize: 1080, previewLen: PREVIEW_DEFAULT,
  curve: null,                     // { dy, rot, blur, amp, peak, overscan } in reference px
  out: null,                       // { blob, name, file } after export
  running: null,                   // active Conversion
  names: new Set(),                // loaded file names: removed from the feedback report
  fb: { worked: null, look: null },
  wm: Object.assign({}, WM_DEFAULTS),   // watermark test switch + sliders (TEST BUILD, BASSAPP-006)
  wmPlan: null,                    // last plan used by render (for automated checks)
};
window.__app = S;                  // for automated checks

const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : "?";
const mb = b => (b / 1048576).toFixed(1) + " MB";
const even = n => Math.max(2, Math.round(n / 2) * 2);
const mmss = s => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");

// ------------------------------------------------------------- controls ----------
// Slider markup follows the mockup: label · hint · readout, then the track with its marks.
// A mark at slider value v sits at (f% + (8 - f*0.16) px) for a 16 px knob, f = 0..100.
const markLeft = f => `calc(${f.toFixed(2)}% + ${(8 - f * 0.16).toFixed(2)}px)`;
function sliderRow(c, box, onInput) {
  const d = document.createElement("div"); d.className = "row";
  if (c.seg) {
    d.classList.add("seg-row");
    d.innerHTML = `<label id="l_${c.id}">${c.label}</label><span class="hint">${c.hint || ""}</span><span></span><div class="seg" role="group" aria-labelledby="l_${c.id}" id="c_${c.id}">${c.seg.map((x, k) => `<button type="button" data-i="${k}" aria-pressed="false">${x}</button>`).join("")}</div>`;
    box.append(d);
    d.querySelectorAll("button").forEach(b => b.addEventListener("click", () => onInput(Number(b.dataset.i))));
    return d;
  }
  const span = c.max - c.min, frac = v => 100 * (v - c.min) / span;
  let marks = "";
  if (c.crossover) {
    const L = markLeft(frac(c.crossover.at));
    marks = `<span class="mark" style="left:${L}"></span><span class="ml ml-l" style="right:calc(100% - ${L.slice(5, -1)} + 7px)">${c.crossover.labels[0]}</span><span class="ml ml-r" style="left:calc(${L.slice(5, -1)} + 7px)">${c.crossover.labels[1]}</span>`;
  }
  if (c.marks) marks += c.marks.map(m => { const L = markLeft(frac(m.at)); return `<span class="mark mark-c" style="left:${L}"></span><span class="ml ml-c" style="left:${L}">${m.label}</span>`; }).join("");
  d.innerHTML = `<label for="c_${c.id}">${c.label}</label><span class="hint">${c.hint || ""}</span><output id="o_${c.id}" for="c_${c.id}"></output>` +
    `<div class="track${marks ? " hasmark" : ""}"><input type="range" id="c_${c.id}" min="${c.min}" max="${c.max}" step="${c.step}">${marks}</div>` +
    (c.scale ? `<div class="scale"><span>${c.scale[0]}</span><span>${c.scale[1]}</span></div>` : "");
  box.append(d);
  const inp = d.querySelector("input");
  inp.addEventListener("input", () => onInput(Number(inp.value)));
  if (c.toModel) inp.addEventListener("change", () => log("set " + c.id + " = " + inp.value + " -> " + JSON.stringify(c.toModel(Number(inp.value)))));
  return d;
}
function paintSlider(id, v, text) {
  const inp = $("c_" + id); if (!inp) return;
  inp.value = v;
  const f = (Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min));
  inp.style.setProperty("--p", `calc(${(f * 100).toFixed(2)}% - ${(f * 16 - 8).toFixed(1)}px)`);
  if (text != null) $("o_" + id).textContent = text;
}

function buildControls() {
  const chips = $("chips");
  for (const name of [...UI_PRESETS, "Custom"]) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (name === "Custom" ? " custom" : "");
    b.textContent = name; b.dataset.preset = name; b.setAttribute("aria-pressed", "false");
    if (name !== "Custom") b.addEventListener("click", () => applyPreset(name));
    else b.tabIndex = -1;
    chips.append(b);
  }
  for (const [list, box] of [[MAIN, $("mainCtls")], [ADVANCED, $("advCtls")]]) for (const c of list) {
    const row = sliderRow(c, box, v => {
      S.sliders[c.id] = v;
      Object.assign(S.params, c.toModel(v));
      S.preset = "Custom";
      syncControls(); paramsChanged(null);
      if (c.seg) log("set " + c.id + " = " + c.seg[v] + " -> " + JSON.stringify(c.toModel(v)));
    });
    if (c.id === "respond") {                       // little plot of what the shake listens to
      const cvs = document.createElement("canvas"); cvs.id = "respPlot"; cvs.className = "mini";
      cvs.setAttribute("aria-label", "Which bass frequencies drive the shake");
      row.insertBefore(cvs, row.querySelector(".track"));
    }
  }
  // Preview: start + length (seconds, real units)
  sliderRow({ id: "pstart", label: "Start at", hint: "or tap the curve", min: 0, max: 0, step: 0.1 }, $("prevCtls"), v => setPreviewStart(v));
  sliderRow({ id: "plen", label: "Length", hint: "resets on new clip", min: 3, max: 10, step: 1 }, $("prevCtls"), v => { S.previewLen = v; setPreviewStart(Number($("c_pstart").value)); });
  $("c_plen").addEventListener("change", () => log("preview length = " + S.previewLen + " s"));
  // Output size
  const seg = $("sizeSeg");
  for (const [label, px] of OUTPUT) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.dataset.px = px;
    b.addEventListener("click", () => { S.outSize = px; syncOutSize(); paramsChanged("output size " + label); });
    seg.append(b);
  }
  syncOutSize();
  buildWatermarkControls();
  applyPreset(S.preset, true);
}
// Watermark (TEST BUILD): on/off + size / opacity / shake, to judge on real clips (BASSAPP-006).
const WM_CTLS = [
  { id: "wmsize", label: "Size", hint: "of the shorter side", min: 2, max: 6, step: 0.1, key: "size", show: v => Number(v).toFixed(1) + "%" },
  { id: "wmop", label: "Opacity", hint: "", min: 20, max: 100, step: 5, key: "opacity", show: v => Math.round(v) + "%" },
  { id: "wmshake", label: "Moves with picture", hint: "", min: 0, max: 100, step: 5, key: "shake", show: v => Math.round(v) + "%" },
];
function buildWatermarkControls() {
  const box = $("wmCtls");
  sliderRow({ id: "wm", label: "Watermark", hint: "test", seg: ["On", "Off"] }, box, i => { S.wm.on = i === 0; syncWm(); log("watermark " + (S.wm.on ? "on" : "off")); });
  for (const c of WM_CTLS) {
    sliderRow(c, box, v => { S.wm[c.key] = v; syncWm(); });
    $("c_" + c.id).addEventListener("change", () => log("watermark " + c.key + " = " + S.wm[c.key]));
  }
  syncWm();
}
function syncWm() {
  $("c_wm").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String((Number(b.dataset.i) === 0) === S.wm.on)));
  for (const c of WM_CTLS) { paintSlider(c.id, S.wm[c.key], c.show(S.wm[c.key])); $("c_" + c.id).disabled = !S.wm.on; }
}
function applyPreset(name, quiet) {
  S.preset = name; S.params = presetModel(name);
  S.sliders = {}; for (const c of ALL) S.sliders[c.id] = sliderFor(c, S.params);
  syncControls();
  if (!quiet) paramsChanged("preset " + name);
}
function syncControls() {
  for (const b of $("chips").children) b.setAttribute("aria-pressed", String(b.dataset.preset === S.preset));
  for (const c of ALL) {
    const v = S.sliders[c.id];
    if (c.seg) { $("c_" + c.id).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.i) === v))); continue; }
    paintSlider(c.id, v, c.show(v, S.params));
  }
  drawRespond();
}
// "Frequency response" mini plot. x: 25-200 Hz (log). White line: the loaded clip's own bass
// (average spectrum, amplitude; a typical mix until a clip is loaded). Amber: the same after the
// 1/f^p weighting, i.e. what the shake responds to (own peak = full height).
function drawRespond() {
  const c = $("respPlot"); if (!c) return;
  const dpr = window.devicePixelRatio || 1, W = Math.max(100, Math.round(c.clientWidth * dpr)), H = Math.max(30, Math.round(c.clientHeight * dpr));
  if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
  const g = c.getContext("2d"); g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement), accent = cs.getPropertyValue("--accent").trim(), muted = cs.getPropertyValue("--muted").trim();
  const p = S.params.p, f0 = 25, f1 = 200, top = 4 * dpr, base = H - 14 * dpr;
  const X = f => (Math.log(f / f0) / Math.log(f1 / f0)) * W;
  const src = S.clipSpec || TYPICAL_MIX;
  const amax = Math.max(...src.map(q => q[1])) || 1;
  const pts = src.map(([f, pw]) => [f, Math.sqrt(pw / amax), Math.sqrt(pw / amax * Math.pow(f / f0, -p))]);
  const wmax = Math.max(...pts.map(q => q[2])) || 1;
  const Y = v => base - v * (base - top);
  g.beginPath(); g.moveTo(X(pts[0][0]), base);
  for (const [f, , w] of pts) g.lineTo(X(f), Y(w / wmax));
  g.lineTo(X(pts[pts.length - 1][0]), base); g.closePath();
  g.fillStyle = accent; g.globalAlpha = 0.75; g.fill(); g.globalAlpha = 1;
  g.beginPath(); pts.forEach(([f, a], i) => i ? g.lineTo(X(f), Y(a)) : g.moveTo(X(f), Y(a)));
  g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1.5 * dpr; g.stroke();
  g.strokeStyle = "rgba(255,255,255,.25)"; g.beginPath(); g.moveTo(0, base); g.lineTo(W, base); g.stroke();
  g.fillStyle = muted; g.font = (10 * dpr) + "px " + cs.getPropertyValue("--mono"); g.textBaseline = "bottom";
  for (const f of [30, 50, 100, 200]) { const x = X(f); g.textAlign = f === 200 ? "right" : "center"; g.fillText(f === 200 ? "200 Hz" : String(f), Math.min(W - 1, x), H); }
}
window.addEventListener("resize", () => drawRespond());
$("adv").addEventListener("toggle", () => drawRespond());

function syncOutSize() { for (const b of $("sizeSeg").children) b.setAttribute("aria-pressed", String(Number(b.dataset.px) === S.outSize)); }

// --------------------------------------------------------------- loading ---------
$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  S.file = file; S.thumbsP = null; S.meta = null; S.an = null; S.clipSpec = null; S.bassShare = null; S.bassPeak = null; S.bassGain = 1; S.Ecache.clear(); S.curve = null; S.out = null;
  for (const id of ["shareBtn", "downloadBtn", "previewVid"]) $(id).hidden = true;
  $("previewBtn").disabled = $("exportBtn").disabled = true;
  for (const id of ["exportStatus", "saveStatus", "previewStatus", "anaStatus", "bassNote"]) setStatus(id, "", "");
  S.previewLen = PREVIEW_DEFAULT; paintSlider("plen", PREVIEW_DEFAULT, PREVIEW_DEFAULT + " s");
  drawPlot();
  if (!file) return;
  S.names.add(file.name);
  log("file: " + file.name + " (" + mb(file.size) + ", type '" + file.type + "')");
  $("clipName").textContent = "reading " + file.name + "…";
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const fmtName = (await input.getFormat()).name;
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const dur = await input.computeDuration();
    if (!v) throw new Error("no video track found");
    const stats = await v.computePacketStats(120);
    const vDec = await v.canDecode();
    const aDec = a ? await a.canDecode() : null;
    const v0 = await v.getFirstTimestamp();
    const fps = snapFps(stats.averagePacketRate), fpsF = fps.num / fps.den;
    const nFrames = Math.max(2, Math.ceil((dur - v0) * fpsF - 1e-6));
    S.meta = { format: fmtName, width: v.displayWidth, height: v.displayHeight, codec: v.codec, rotation: v.rotation, fpsMeasured: stats.averagePacketRate, fps, fpsF, v0, dur, nFrames, hasAudio: !!a, aCodec: a && a.codec, vDec, aDec };
    $("clipName").textContent = file.name + " · " + mmss(dur) + " · " + S.meta.width + "×" + S.meta.height + " · " + fmt(fpsF, fpsF % 1 ? 2 : 0) + " fps";
    log("probe: " + JSON.stringify(S.meta));
    setPreviewStart(dur > 2 * S.previewLen ? dur / 2 - S.previewLen / 2 : 0);
    await logSupport();
    if (!vDec) { setStatus("anaStatus", "bad", "This browser can't decode this video (" + (v.codec || "unknown") + ")."); return; }
    if (!a) { setStatus("anaStatus", "bad", "This clip has no sound, so there's nothing to drive the shake."); return; }
    if (!aDec) { setStatus("anaStatus", "bad", "This browser can't decode this clip's sound (" + (a.codec || "unknown") + ")."); return; }
    await analyse(a, dur);
    $("previewBtn").disabled = $("exportBtn").disabled = false;
  } catch (e) {
    log("LOAD FAILED: " + (e && (e.stack || e.message)));
    $("clipName").textContent = file.name;
    setStatus("anaStatus", "bad", "This file could not be read here: " + (e && e.message));
  }
});

// Decode the clip's own audio to mono, then run the spectral analysis once.
async function analyse(aTrack, dur) {
  const prog = $("anaProg"); prog.hidden = false; prog.value = 0;
  setStatus("anaStatus", "", "Reading the sound…");
  const t0 = performance.now();
  const sink = new AudioSampleSink(aTrack);
  const chunks = []; let total = 0, sr = 0, a0 = null, nextTs = null, gaps = 0, tmp = null;
  for await (const s of sink.samples()) {
    if (a0 === null) a0 = s.timestamp;
    if (nextTs !== null && Math.abs(s.timestamp - nextTs) > 0.002) gaps++;
    sr = s.sampleRate;
    const nf = s.numberOfFrames, nch = s.numberOfChannels;
    const mono = new Float32Array(nf);
    if (!tmp || tmp.length < nf) tmp = new Float32Array(nf);
    for (let c = 0; c < nch; c++) {
      s.copyTo(tmp, { planeIndex: c, format: "f32-planar", frameCount: nf });
      for (let i = 0; i < nf; i++) mono[i] += tmp[i];
    }
    if (nch > 1) for (let i = 0; i < nf; i++) mono[i] /= nch;
    chunks.push(mono); total += nf; nextTs = s.timestamp + nf / sr;
    s.close();
    if (chunks.length % 50 === 0) { prog.value = 0.3 * Math.min(1, s.timestamp / dur); await new Promise(r => setTimeout(r, 0)); }
  }
  const x = new Float32Array(total); let o = 0; for (const c of chunks) { x.set(c, o); o += c.length; }
  const tDec = (performance.now() - t0) / 1000;
  S.offsetSec = S.meta.v0 - a0;
  log("audio: " + total + " samples @ " + sr + " Hz (" + fmt(total / sr, 2) + " s), first ts " + fmt(a0, 4) + ", video first ts " + fmt(S.meta.v0, 4) + ", offset " + fmt(S.offsetSec, 4) + " s, gaps " + gaps + ", decoded in " + fmt(tDec, 1) + " s");
  setStatus("anaStatus", "", "Listening for the bass…");
  const t1 = performance.now();
  S.an = await analyseAudio(x, sr, { onProgress: p => { prog.value = 0.3 + 0.7 * p; setStatus("anaStatus", "", "Listening for the bass… " + Math.round(p * 100) + "%"); } });
  const tAn = (performance.now() - t1) / 1000;
  log("analysis: " + S.an.nHops + " windows, " + S.an.nb + " bins, " + fmt(tAn, 1) + " s");
  prog.hidden = true;
  setStatus("anaStatus", "ok", "Ready (" + fmt(tDec + tAn, 1) + " s to analyse).");
  // Bass presence: a clip with little bass gets a smaller shake (else its rumble is scaled to full size).
  S.bassShare = bassShare(S.an, x); S.bassPeak = bassPeakDb(S.an);
  const gShare = bassGain(S.bassShare), gLevel = levelGain(S.bassPeak);
  S.bassGain = Math.min(gShare, gLevel);
  log("bass share " + fmt(100 * S.bassShare, 1) + "% (gain " + fmt(gShare, 2) + "), loudest bass " + fmt(S.bassPeak, 1) + " dB (gain " + fmt(gLevel, 2) + ") -> shake gain " + fmt(S.bassGain, 2));
  // The message now sits ON the plot (drawPlot -> bassMessage); the line under the clip stays empty (Manager, BASSAPP-004).
  setStatus("bassNote", "", "");
  // The clip's own average bass spectrum (25-200 Hz, finer + smoothed), for the Frequency response plot.
  try { S.clipSpec = displaySpectrum(x, sr); } catch (e) { S.clipSpec = null; log("display spectrum failed: " + e.message); }
  drawRespond();
  paramsChanged("initial");
  S.thumbsP = wmThumbs();          // watermark spot finder: small grey frames, once per clip, in the background
}

// Small grey frames every second through the clip, for choosing where the watermark goes (pictures
// that are calm, not too bright, no existing text; not on letterbox bars). Cached per clip.
const THUMB_W = 144;
async function wmThumbs() {
  const m = S.meta, file = S.file, t0 = performance.now(), out = [];
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const v = await input.getPrimaryVideoTrack();
    const tw = THUMB_W, th = Math.max(16, Math.round(THUMB_W * m.height / m.width));
    const sink = new CanvasSink(v, { width: tw, height: th, fit: "fill", poolSize: 1 });
    const times = []; for (let t = m.v0 + 0.5; t < m.dur; t += 1) times.push(t);
    const cvs = new OffscreenCanvas(tw, th), g = cvs.getContext("2d", { willReadFrequently: true });
    let k = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      const t = times[k++]; if (!wc || S.file !== file) continue;
      g.drawImage(wc.canvas, 0, 0, tw, th);
      const d = g.getImageData(0, 0, tw, th).data, gr = new Uint8Array(tw * th);
      for (let i = 0, j = 0; j < gr.length; i += 4, j++) gr[j] = (77 * d[i] + 150 * d[i + 1] + 29 * d[i + 2]) >> 8;
      out.push({ t: t - m.v0, g: gr, w: tw, h: th });
    }
    log("watermark spot finder: " + out.length + " frames (" + tw + "x" + th + ") in " + fmt((performance.now() - t0) / 1000, 1) + " s");
  } catch (e) { log("watermark spot finder failed (" + (e && e.message) + "): fixed spots instead"); }
  return out;
}

async function logSupport() {
  const out = [];
  for (const [name, fn] of [["H.264 encode", () => canEncodeVideo("avc")], ["HEVC encode", () => canEncodeVideo("hevc")], ["AAC encode", () => canEncodeAudio("aac")]]) {
    let ok = false; try { ok = await fn(); } catch (e) { log(name + " check threw: " + e.message); }
    out.push(name + ": " + ok);
  }
  log(out.join(", "));
}

// ----------------------------------------------------------------- curve ---------
let logTimer = null;
function paramsChanged(why) {
  if (!S.an) { drawPlot(); return; }
  const P = S.params, m = S.meta;
  const key = P.p + "|" + P.fMin;
  let E = S.Ecache.get(key);
  if (!E) { E = energyPerFrame(S.an, m.nFrames, m.fps, S.offsetSec, P.p, P.fMin); S.Ecache.set(key, E); }
  S.curve = synth(E, S.bassGain < 1 ? Object.assign({}, P, { K: P.K * S.bassGain }) : P, m.fps);   // bass presence gain
  // For the plot: the sizes the shake and blur WOULD have without the gate, so the rows shrink by the gain
  // instead of being rescaled back up to full height.
  if (S.bassGain < 1) { const f = synth(E, P, m.fps); S.curve.fullPeak = f.peak; S.curve.fullBlurMax = colMax(f.blur, 0, f.blur.length); }
  else { S.curve.fullPeak = S.curve.peak; S.curve.fullBlurMax = colMax(S.curve.blur, 0, S.curve.blur.length); }
  // Detected bass for the plot (the INPUT): the 1/f^p-weighted energy, as an amplitude
  // (square root of power), scaled to its own peak. Only "Frequency response" changes it.
  { let mx = 0; for (let i = 0; i < E.length; i++) mx = Math.max(mx, E[i]); const b = new Float64Array(E.length); if (mx > 0) for (let i = 0; i < E.length; i++) b[i] = Math.sqrt(E[i] / mx); S.curve.bass = b; }
  const moving = S.curve.dy.reduce((n, v) => n + (Math.abs(v) > 1 ? 1 : 0), 0) / m.nFrames;
  const { w, h } = outputSize();
  const ov = overscanFor(S.curve.dy, S.curve.rot, w, h, Math.max(w, h) / REF_H);
  S.curve.overscan = ov;
  $("curveNote").textContent = (PLOT_STACKED ? "" : "Grey: the bass · amber: the shake · white: blur. ") + "Shaded: the preview section; tap to move it. Zoom " + fmt(ov, 1) + "% hides the edges.";
  drawPlot();
  const msg = "curve" + (why ? " (" + why + ")" : "") + ": preset " + S.preset + ", sliders " + JSON.stringify(S.sliders) + ", model " + JSON.stringify(P) +
    " -> peak " + fmt(S.curve.peak, 2) + " ref px, wobble " + fmt(wobbleHz(P.rate, m.fps), 2) + " Hz, moving " + Math.round(moving * 100) + "%, overscan " + ov;
  clearTimeout(logTimer);
  if (why) log(msg); else logTimer = setTimeout(() => log(msg), 600);   // sliders: log once they settle
}

// The plot: detected bass (input, grey), shake (response, amber), blur (response, white).
// Three stacked rows, each on its own scale.
const PLOT_STACKED = true;   // Manager chose stacked (BASSAPP-004); superimposed code kept below for now
if (PLOT_STACKED) document.querySelector(".curve").classList.add("stacked");
function colRange(arr, px, W, n, f) {           // per pixel column: f over the frames it covers
  const a = Math.floor(px / W * n), b = Math.max(a + 1, Math.floor((px + 1) / W * n));
  return f(arr, a, Math.min(b, n));
}
const colMax = (arr, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, arr[i]); return m; };
const colLoHi = (arr, a, b) => { let lo = 0, hi = 0; for (let i = a; i < b; i++) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); } return [lo, hi]; };
function drawPlot() {
  const c = $("plot"), dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(c.clientWidth * dpr)), H = Math.max(40, Math.round(c.clientHeight * dpr));
  if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
  const g = c.getContext("2d"); g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim(), muted = cs.getPropertyValue("--muted").trim(), mono = cs.getPropertyValue("--mono");
  if (!S.curve || !S.meta) { g.fillStyle = muted; g.font = (12 * dpr) + "px " + mono; g.fillText("no clip yet", 10 * dpr, H / 2 + 4 * dpr); return; }
  const { dy, blur, bass } = S.curve, n = dy.length, fpsF = S.meta.fpsF;
  // preview section, shaded
  const ps = Number($("c_pstart").value);
  const x0 = (ps * fpsF) / n * W, x1 = Math.min(W, ((ps + S.previewLen) * fpsF) / n * W);
  g.fillStyle = accent; g.globalAlpha = 0.14; g.fillRect(x0, 0, Math.max(2, x1 - x0), H); g.globalAlpha = 1;
  const pad = 3 * dpr;
  // Shake and blur share one px scale (both are movement on screen), so their sizes compare.
  const shakeScale = h => (h / 2 - pad) / Math.max(30, S.curve.fullPeak ?? S.curve.peak);
  const bassArea = (top, h, mirrored) => {        // grey filled area, scaled to its own peak x the bass presence gain
    g.fillStyle = "rgba(255,255,255,.16)";
    const gk = S.an ? S.bassGain : 1;              // little/no bass: the bass row shrinks with the shake (Manager, BASSAPP-005)
    for (let px = 0; px < W; px++) {
      const v = colRange(bass, px, W, n, colMax) * gk * (mirrored ? h / 2 - pad : h - 2 * pad);
      if (v > 0.3) mirrored ? g.fillRect(px, top + h / 2 - v, 1, 2 * v) : g.fillRect(px, top + h - pad - v, 1, v);
    }
  };
  const shakeBand = (top, h) => {
    const sc = shakeScale(h), mid = top + h / 2;
    g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = dpr; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
    g.fillStyle = accent;
    for (let px = 0; px < W; px++) { const [lo, hi] = colRange(dy, px, W, n, colLoHi); if (hi - lo > 0.2) g.fillRect(px, mid - hi * sc, 1, Math.max(1, (hi - lo) * sc)); }
  };
  const blurLine = (bottom, sc) => {
    g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2 * dpr; g.lineJoin = "round"; g.beginPath();
    for (let px = 0; px < W; px++) { const y = bottom - colRange(blur, px, W, n, colMax) * sc; px ? g.lineTo(px, y) : g.moveTo(px, y); }
    g.stroke();
  };
  if (!PLOT_STACKED) {
    bassArea(0, H, true);
    shakeBand(0, H);
    blurLine(H - pad, shakeScale(H) * 0.5);          // on top
  } else {
    const h = H / 3;
    bassArea(0, h, false);
    shakeBand(h, h);
    blurLine(3 * h - pad, (h - 2 * pad) / Math.max(15, S.curve.fullBlurMax ?? colMax(blur, 0, n)));   // own scale (unreduced), like the bass row
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = dpr;
    for (const y of [h, 2 * h]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = muted; g.font = (10 * dpr) + "px " + mono;
    [["bass", 0], ["shake", h], ["blur", 2 * h]].forEach(([t, y]) => g.fillText(t, 4 * dpr, y + 11 * dpr));
  }
  const msg = bassMessage();
  c.setAttribute("aria-label", "The shake over the whole clip. Tap to move the preview section." + (msg ? " " + msg + "." : ""));
  if (msg) {                                       // on the plot, centred over the shake + blur rows
    const top = PLOT_STACKED ? H / 3 : 0, cy = top + (H - top) / 2;
    let fs = 13 * dpr; g.font = "600 " + fs + "px " + mono;
    while (g.measureText(msg).width > W - 2 * 46 * dpr && fs > 9 * dpr) { fs -= dpr; g.font = "600 " + fs + "px " + mono; }
    const tw = g.measureText(msg).width, bx = (W - tw) / 2 - 8 * dpr, bh = fs + 10 * dpr;
    g.fillStyle = "rgba(0,0,0,.72)"; g.fillRect(bx, cy - bh / 2, tw + 16 * dpr, bh);
    g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(msg, (W - tw) / 2, cy); g.textBaseline = "alphabetic";
  }
}
// Bass presence message for the plot (Manager, BASSAPP-004). Empty when the shake is not reduced.
const BASS_MSG_BELOW = 0.6;   // show the message only when the shake is cut below 60 % (Manager, BASSAPP-005)
function bassMessage() {
  if (!S.an || S.bassGain >= BASS_MSG_BELOW) return "";
  return S.bassGain === 0 ? "There is pretty much no bass in this clip" : "There is not much bass in this clip";
}
$("plot").addEventListener("click", e => {
  if (!S.meta) return;
  const r = $("plot").getBoundingClientRect();
  const t = (e.clientX - r.left) / r.width * S.meta.dur;
  setPreviewStart(t - S.previewLen / 2); log("preview start set from curve: " + fmt(Number($("c_pstart").value), 1) + " s");
});
window.addEventListener("resize", () => drawPlot());
function setPreviewStart(t) {
  const max = S.meta ? Math.max(0, S.meta.dur - S.previewLen) : 0;
  $("c_pstart").max = max.toFixed(1);
  const v = Math.max(0, Math.min(max, t));
  paintSlider("pstart", v.toFixed(1), Number(v).toFixed(1) + " s");
  paintSlider("plen", S.previewLen, S.previewLen + " s");
  drawPlot();
}

// --------------------------------------------------------------- render ----------
// Output size by the SHORTER dimension (1080x1920 vertical = 1080p). Never upscales.
function outputSize() {
  const m = S.meta; if (!m) return { w: 0, h: 0 };
  let w = m.width, h = m.height;
  const short = Math.min(w, h);
  if (S.outSize && short > S.outSize) { const s = S.outSize / short; w *= s; h *= s; }
  return { w: even(w), h: even(h) };
}

// The ONE render path, used by both preview and export. The curve is computed for the
// whole clip; a frame is looked up by its time, so the preview cannot differ from the export.
async function render({ trim, onProgress }) {
  const m = S.meta, cv = S.curve, shutter = S.params.shutter ?? 180;
  const { w, h } = outputSize();
  const pxScale = Math.max(w, h) / REF_H;               // reference px are 1/1920 of the long side
  const ov = cv.overscan / 100;
  let codec = null;
  for (const c of ["avc", "hevc", "vp9", "av1"]) { if (await canEncodeVideo(c, { width: w, height: h })) { codec = c; break; } }
  if (!codec) throw new Error("this browser cannot encode video at " + w + "×" + h);
  let aCodec = null;
  if (m.hasAudio) for (const c of ["aac", "opus"]) { if (await canEncodeAudio(c)) { aCodec = c; break; } }
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext("2d");
  // Watermark: planned over the WHOLE clip (like the curve), so preview == export.
  let wm = null;
  if (S.wm.on) {
    const { font, fontPx } = wmFont(S.wm.size, w, h);
    try { await document.fonts.load(font, WM_TEXT); } catch (e) { log("watermark font load: " + e.message); }
    if (!document.fonts.check('500 20px "BS Watermark"', WM_TEXT)) log("watermark font NOT loaded: falling back to a system font");
    ctx.font = font;
    const textW = ctx.measureText(WM_TEXT).width, cands = spotsFor(w, h);
    const plan = planWatermark(cv.amp, m.fpsF);
    const cuts = [0, ...plan.moves.map(mv => mv.frame / m.fpsF), m.dur];
    const segTimes = cuts.slice(0, -1).map((a, k) => [a, cuts[k + 1]]);
    const thumbs = await (S.thumbsP || (S.thumbsP = wmThumbs()));
    const ch = chooseSpots(cands, segTimes, thumbs, textW / w, fontPx / h, h / w);
    const at = ch.spots.map(si => placeText(cands[si], textW, fontPx, w, h));
    wm = { font, fontPx, plan, at, op: S.wm.opacity / 100, follow: S.wm.shake / 100 };
    S.wmPlan = { moves: plan.moves, textW, fontPx, at, spots: ch.spots, costs: ch.costs, letterbox: ch.lb, w, h };
    if (ch.lb.top > 0 || ch.lb.bottom < 1 || ch.lb.left > 0 || ch.lb.right < 1) log("watermark: letterbox bars found, picture " + JSON.stringify(Object.fromEntries(Object.entries(ch.lb).map(([k, v]) => [k, +v.toFixed(3)]))));
    log("watermark spots per segment: " + ch.spots.map((s, k) => s + " (" + fmt(ch.costs[k], 1) + ")").join(", "));
    log("watermark: " + WM_TEXT + ", " + fmt(fontPx, 1) + " px (" + fmt(S.wm.size, 1) + "% of short side), text " + fmt(textW, 0) + " px wide, opacity " + S.wm.opacity + "%, moves with picture " + S.wm.shake + "%, " +
      plan.moves.length + " moves at " + plan.moves.map(mv => fmt(mv.frame / m.fpsF, 1) + "s" + (mv.onHit ? "*" : "")).join(" ") + " (* = on a bass hit)");
  } else S.wmPlan = null;
  const src = new OffscreenCanvas(w, h), sctx = src.getContext("2d");
  let frames = 0, firstTs = null, tsShift = 0, maxDraws = 0, idxMin = Infinity, idxMax = -Infinity;
  const input = new Input({ source: new BlobSource(S.file), formats: ALL_FORMATS });
  // A trimmed render restarts timestamps: later frames come out as (source - start), but the
  // first one (the frame SHOWING at `start`) is clamped to 0. So its true source time is
  // looked up from the file itself, rather than assumed.
  let firstSrc = null;
  if (trim) {
    const pkt = await new EncodedPacketSink(await input.getPrimaryVideoTrack()).getPacket(trim.start);
    firstSrc = pkt ? pkt.timestamp : trim.start;
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const conv = await Conversion.init({
    input, output, trim,
    video: {
      codec, quality: QUALITY_HIGH, forceTranscode: true, allowTransformationMetadata: false,
      width: w, height: h, fit: "fill", processedWidth: w, processedHeight: h,
      process: (sample) => {
        if (firstTs === null) {
          firstTs = sample.timestamp;
          // Check the restart-at-0 assumption rather than trusting it.
          if (trim && trim.start > 0 && Math.abs(firstTs) < Math.abs(firstTs - trim.start)) tsShift = trim.start;
          log("first frame ts " + fmt(firstTs, 4) + (trim ? " (trim start " + fmt(trim.start, 4) + ", source frame at " + fmt(firstSrc, 4) + ", shift " + fmt(tsShift, 4) + ")" : ""));
        }
        const tSrc = (trim && frames === 0 && tsShift) ? firstSrc : sample.timestamp + tsShift;
        const i = Math.max(0, Math.min(cv.dy.length - 1, Math.round((tSrc - m.v0) * m.fpsF)));
        idxMin = Math.min(idxMin, i); idxMax = Math.max(idxMax, i);
        const dy = cv.dy[i] * pxScale, rot = cv.rot[i] * Math.PI / 180;
        const prev = cv.dy[Math.max(0, i - 1)] * pxScale;
        // Blur: shutter trail back towards the previous position + centred directional smear.
        const { lo, hi } = blurRange(prev, dy, cv.blur[i] * pxScale, shutter), span = hi - lo;
        const draws = span < 0.75 ? 1 : Math.min(MAX_BLUR_DRAWS, Math.ceil(span / 2) + 1);
        maxDraws = Math.max(maxDraws, draws);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        if (draws === 1) {
          ctx.translate(w / 2, h / 2 + dy + (lo + hi) / 2); ctx.rotate(rot); ctx.scale(ov, ov);
          sample.draw(ctx, -w / 2, -h / 2, w, h);
        } else {
          sctx.setTransform(1, 0, 0, 1, 0, 0); sample.draw(sctx, 0, 0, w, h);
          for (let j = 0; j < draws; j++) {
            const off = lo + span * (j / (draws - 1));
            ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 / (j + 1);   // running average
            ctx.translate(w / 2, h / 2 + dy + off); ctx.rotate(rot); ctx.scale(ov, ov);
            ctx.drawImage(src, -w / 2, -h / 2, w, h);
          }
          ctx.globalAlpha = 1;
        }
        if (wm && wm.plan.alpha[i] > 0.003) {
          const p = wm.at[wm.plan.seg[i]];
          drawWatermark(ctx, wm.font, wm.fontPx, p.x, p.y + wm.follow * dy, wm.op * wm.plan.alpha[i]);
        }
        frames++;
        return canvas;
      }
    },
    audio: aCodec ? { codec: aCodec } : { discard: true },
    showWarnings: false
  });
  if (conv.discardedTracks.length) log("discarded tracks: " + conv.discardedTracks.map(d => d.track.type + ":" + d.reason).join(", "));
  if (!conv.isValid) throw new Error("conversion not possible: " + conv.discardedTracks.map(d => d.reason).join(", "));
  log("render start: " + w + "×" + h + " " + codec + "/" + (aCodec || "no-audio") + ", zoom " + fmt(cv.overscan, 1) + "%, shutter " + fmt(shutter, 0) + "°" + (trim ? ", " + fmt(trim.start, 1) + "–" + fmt(trim.end, 1) + " s" : ", full clip"));
  conv.onProgress = p => onProgress && onProgress(p, frames);
  S.running = conv;
  const t0 = performance.now();
  try { await conv.execute(); } finally { S.running = null; }
  const secs = (performance.now() - t0) / 1000;
  const blob = new Blob([output.target.buffer], { type: "video/mp4" });
  log("render done: " + frames + " frames (curve frames " + idxMin + "–" + idxMax + ", max " + maxDraws + " blur draws) in " + fmt(secs, 1) + " s (" + fmt(frames / secs, 1) + " fps), " + mb(blob.size));
  return { blob, frames, secs, w, h, codec };
}

// ---------------------------------------------------------------- preview --------
$("previewBtn").addEventListener("click", async () => {
  // Start half-way through frame k, so frame k is unambiguously the one showing at `start`.
  const m = S.meta, k = Math.round((Number($("c_pstart").value) - m.v0) * m.fpsF);
  const start = m.v0 + (k + 0.5) / m.fpsF, end = Math.min(m.dur, start + S.previewLen);
  const prog = $("previewProg"), vid = $("previewVid");
  setBusy(true); prog.hidden = false; prog.value = 0; setStatus("previewStatus", "", "Rendering…");
  try {
    const r = await render({ trim: { start, end }, onProgress: p => { prog.value = p; setStatus("previewStatus", "", "Rendering… " + Math.round(p * 100) + "%"); } });
    if (vid.src) URL.revokeObjectURL(vid.src);
    vid.src = URL.createObjectURL(r.blob); vid.hidden = false;
    vid.onerror = () => log("PREVIEW PLAYBACK ERROR: " + (vid.error && (vid.error.message || vid.error.code)));
    vid.onloadedmetadata = () => log("preview playable: " + fmt(vid.duration, 2) + " s, " + vid.videoWidth + "×" + vid.videoHeight);
    setStatus("previewStatus", "ok", r.frames + " frames in " + fmt(r.secs, 1) + " s · " + fmt((end - start) / r.secs, 2) + "× real time");
    try { await vid.play(); } catch (e) { log("autoplay refused (" + e.name + "); tap play"); }
  } catch (e) { fail("previewStatus", "Preview", e); }
  finally { setBusy(false); prog.hidden = true; }
});

// ----------------------------------------------------------------- export --------
// Leaving the page mid-export kills the encode (seen on iPhone). So: say so up front, keep
// the screen awake, warn on closing the tab, and give a clean message if it happens.
let wakeLock = null, hiddenDuringRun = false;
document.addEventListener("visibilitychange", () => {
  if (S.running && document.visibilityState === "hidden") { hiddenDuringRun = true; log("page hidden during render"); }
});
window.addEventListener("beforeunload", e => { if (S.running) { e.preventDefault(); e.returnValue = ""; } });
if (window.__lastExportInterrupted) setStatus("exportStatus", "bad", "Your last export didn't finish — the page was closed or reloaded. Load the clip again and keep this page on screen while it exports.");

$("exportBtn").addEventListener("click", async () => {
  const prog = $("exportProg");
  setBusy(true); $("cancelBtn").hidden = false; $("keepOpen").hidden = false; prog.hidden = false; prog.value = 0;
  $("shareBtn").hidden = $("downloadBtn").hidden = true; setStatus("saveStatus", "", ""); S.out = null;
  setStatus("exportStatus", "", "Exporting…");
  hiddenDuringRun = false;
  try { sessionStorage.setItem("bs_export_running", "1"); } catch {}
  try { if (navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); log("screen wake lock on"); } } catch (e) { log("wake lock unavailable: " + e.name); }
  const t0 = performance.now();
  try {
    const r = await render({ trim: undefined, onProgress: p => {
      prog.value = p; const el = (performance.now() - t0) / 1000, eta = p > 0.02 ? el / p - el : NaN;
      setStatus("exportStatus", "", "Exporting… " + Math.round(p * 100) + "% · " + (Number.isFinite(eta) ? Math.ceil(eta) + " s left" : "estimating"));
    } });
    const name = S.file.name.replace(/\.[^.]+$/, "") + " - bass shake.mp4";
    S.out = { blob: r.blob, name, file: new File([r.blob], name, { type: "video/mp4" }) };
    setStatus("exportStatus", "ok", "Done: " + r.w + "×" + r.h + ", " + r.frames + " frames, " + mb(r.blob.size) + ", " + fmt(S.meta.dur / r.secs, 2) + "× real time.");
    // Phones/tablets: share sheet ("Save Video" -> Photos) + plain download. Desktop: one
    // "Save video" button that downloads (the desktop share panel has no Photos option).
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [S.out.file] }));
    const mobile = IS_MOBILE && canShare;
    log("share sheet with file: " + (canShare ? "available" : "not available") + ", " + (IS_MOBILE ? "phone/tablet" : "desktop") + " -> " + (mobile ? "share + download" : "download only"));
    $("shareBtn").hidden = !mobile; $("downloadBtn").hidden = false;
    $("downloadBtn").textContent = mobile ? "Download" : "Save video";
    $("downloadBtn").classList.toggle("primary", !mobile);
  } catch (e) {
    if (hiddenDuringRun) {
      setStatus("exportStatus", "bad", "Interrupted — the page went into the background, which stops the export. Keep it open and on screen, then export again.");
      log("EXPORT INTERRUPTED (page was hidden): " + (e && e.message));
    } else if (e && /cancel/i.test(e.name + " " + e.message)) {
      setStatus("exportStatus", "", "Cancelled."); log("export cancelled");
    } else fail("exportStatus", "Export", e);
  } finally {
    try { sessionStorage.removeItem("bs_export_running"); } catch {}
    if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
    setBusy(false); $("cancelBtn").hidden = true; $("keepOpen").hidden = true; prog.hidden = true;
  }
});
$("cancelBtn").addEventListener("click", () => { if (S.running) { S.running.cancel(); log("cancel pressed"); } });

// ------------------------------------------------------------------- save ---------
const inClaudeFrame = !!(window.claude && window.claude.use);
// iPadOS reports a Mac user agent: a touch-capable "Macintosh" is an iPad.
const IS_MOBILE = (navigator.userAgentData && navigator.userAgentData.mobile) || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
$("shareBtn").addEventListener("click", async () => {
  if (!S.out) return;
  try {
    await navigator.share({ files: [S.out.file] });
    setStatus("saveStatus", "ok", "Shared. On iPhone, choose “Save Video” to put it in Photos."); log("share: completed");
  } catch (e) {
    if (e && e.name === "AbortError") { setStatus("saveStatus", "", "Share cancelled."); log("share: cancelled"); }
    else { setStatus("saveStatus", "bad", "Share failed (" + (e && e.name) + "). Use Download instead."); log("share failed: " + (e && (e.name + " " + e.message))); }
  }
});
$("downloadBtn").addEventListener("click", () => {
  if (!S.out) return;
  const a = document.createElement("a"); a.href = URL.createObjectURL(S.out.blob); a.download = S.out.name;
  document.body.append(a); a.click(); a.remove();
  if (inClaudeFrame) setStatus("saveStatus", "bad", "Saving may be blocked inside Claude's preview — use the live site.");
  else setStatus("saveStatus", "ok", IS_MOBILE ? "Download started. On iPhone it goes to Files › Downloads." : "Saved to your Downloads folder.");
  log("download started" + (inClaudeFrame ? " (inside Claude's frame)" : ""));
});

// --------------------------------------------------------------- feedback ---------
// Shows exactly what will be sent; sends only on tap; never video or audio. File names are
// replaced with "[name removed].<ext>" so nothing personal goes with the report.
const FB_WORKED = ["Yes", "Partly", "No"], FB_LOOK = ["Great", "OK", "Not right"];
function fbSeg(boxId, opts, key) {
  const box = $(boxId);
  opts.forEach(o => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = o; b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => { S.fb[key] = S.fb[key] === o ? null : o; for (const x of box.children) x.setAttribute("aria-pressed", String(x.textContent === S.fb[key])); fbRefresh(); });
    box.append(b);
  });
}
function redact(text) {
  let t = text;
  for (const n of S.names) { const ext = (n.match(/\.[^.]+$/) || [""])[0]; const stem = n.replace(/\.[^.]+$/, ""); t = t.split(n).join("[name removed]" + ext); if (stem.length >= 4) t = t.split(stem).join("[name removed]"); }
  return t;
}
function technicalReport() {
  const m = S.meta;
  const lines = ["build " + window.BUILD, "browser " + navigator.userAgent,
    "settings: preset " + S.preset + ", sliders " + JSON.stringify(S.sliders) + ", output " + (S.outSize || "original") + ", preview " + S.previewLen + " s",
    "model: " + JSON.stringify(S.params),
    "watermark: " + (S.wm.on ? "on, size " + S.wm.size + "%, opacity " + S.wm.opacity + "%, moves with picture " + S.wm.shake + "%" : "off"),
    "bass: " + (S.bassShare == null ? "n/a" : "share " + fmt(100 * S.bassShare, 1) + "%, loudest " + fmt(S.bassPeak, 1) + " dB, shake gain " + fmt(S.bassGain, 2)),
    m ? "clip: " + m.format + ", " + m.width + "x" + m.height + ", " + fmt(m.fpsF, 3) + " fps, " + fmt(m.dur, 2) + " s, video " + m.codec + ", audio " + m.aCodec : "clip: none loaded",
    "--- log ---", ...window.__log];
  return redact(lines.join("\n"));
}
function fbPayload() {
  return { worked: S.fb.worked || "", look: S.fb.look || "", text: $("fbText").value.trim(), report: $("fbReport").checked ? technicalReport() : "" };
}
function fbRefresh() {
  const p = fbPayload();
  $("fbPreview").value = "Did it work? " + (p.worked || "—") + "\nHow did the shake look? " + (p.look || "—") + "\nAnything else: " + (p.text || "—") +
    "\n\nTechnical report: " + (p.report ? "\n" + p.report : "not included");
}
window.__onLog = () => { if ($("s-feedback").querySelector("details.sent").open) fbRefresh(); };
fbSeg("fbWorked", FB_WORKED, "worked"); fbSeg("fbLook", FB_LOOK, "look");
$("fbText").addEventListener("input", fbRefresh); $("fbReport").addEventListener("change", fbRefresh);
$("s-feedback").querySelector("details.sent").addEventListener("toggle", fbRefresh);
$("fbSend").addEventListener("click", async () => {
  const p = fbPayload(); fbRefresh();
  if (!p.worked && !p.look && !p.text) { setStatus("fbStatus", "bad", "Pick an answer or write something first."); return; }
  if (!FEEDBACK_FORM.action) {
    try { await navigator.clipboard.writeText($("fbPreview").value); setStatus("fbStatus", "", "Sending isn't switched on in this test build yet. Your feedback is copied: paste it into a message to us."); }
    catch { setStatus("fbStatus", "bad", "Sending isn't switched on in this test build yet. Open “What will be sent”, copy it, and send it to us."); }
    log("feedback: no form configured, copied instead"); return;
  }
  const body = new URLSearchParams();
  for (const k of ["worked", "look", "text", "report"]) if (FEEDBACK_FORM.fields[k]) body.append(FEEDBACK_FORM.fields[k], p[k]);
  $("fbSend").disabled = true; setStatus("fbStatus", "", "Sending…");
  try {
    await fetch(FEEDBACK_FORM.action, { method: "POST", mode: "no-cors", body });
    setStatus("fbStatus", "ok", "Sent — thank you."); log("feedback sent");
  } catch (e) { setStatus("fbStatus", "bad", "Couldn't send (" + (e && e.message) + "). Use Copy report instead."); log("feedback send failed: " + (e && e.message)); }
  finally { $("fbSend").disabled = false; }
});
// Fallbacks: clipboard first; if the browser blocks it, offer a .txt download.
$("copyBtn").addEventListener("click", async () => {
  fbRefresh();
  try { await navigator.clipboard.writeText($("fbPreview").value); setStatus("fbStatus", "ok", "Copied."); }
  catch { const d = $("s-feedback").querySelector("details.sent"); d.open = true; const ta = $("fbPreview"); ta.focus(); ta.select(); setStatus("fbStatus", "bad", "Couldn't copy automatically: the text is selected, use Copy — or Download report."); }
});
$("reportDlBtn").addEventListener("click", () => {
  fbRefresh();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("fbPreview").value], { type: "text/plain" }));
  a.download = "bass-shake-report.txt"; document.body.append(a); a.click(); a.remove();
  setStatus("fbStatus", "ok", "Report download started.");
});

// ------------------------------------------------------------------ misc ----------
function setBusy(b) { $("previewBtn").disabled = $("exportBtn").disabled = b || !S.curve; $("file").disabled = b; }
function setStatus(id, cls, text) { const el = $(id); el.className = "status" + (cls ? " " + cls : ""); el.textContent = text; }
function fail(id, what, e) { setStatus(id, "bad", what + " failed: " + (e && e.message)); log(what.toUpperCase() + " FAILED: " + (e && (e.stack || e.message))); }

buildControls();
setPreviewStart(0);
drawPlot();
window.__ready = true;
log("ready");
