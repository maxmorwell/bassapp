// app.js — the page. Load clip -> decode its audio -> analyse -> shake curve -> render.
// The model itself lives in shake.js (golden-tested against the reference generator).
import { analyseAudio, energyPerFrame, synth, overscanFor, snapFps, PRESETS, presetParams, REF_H } from "./shake.js";

const log = window.log;
const $ = id => document.getElementById(id);
const PREVIEW_LEN = 4;            // seconds
const MAX_BLUR_DRAWS = 10;        // blur = averaged copies of the frame; cap per frame for speed

let MB;
try {
  MB = await import("../vendor/mediabunny-1.61.3.min.mjs");
  log("library loaded (mediabunny 1.61.3, hosted with the page)");
} catch (e) {
  log("LIBRARY LOAD FAILED: " + (e && e.message));
  $("info").innerHTML = "<dt>error</dt><dd>The video library could not load. Copy the report below.</dd>";
  throw e;
}
const { Input, Output, BlobSource, BufferTarget, Mp4OutputFormat, Conversion, ALL_FORMATS, AudioSampleSink, EncodedPacketSink, canEncodeVideo, canEncodeAudio, QUALITY_HIGH } = MB;

// ---------------------------------------------------------------- state ----------
const S = {
  file: null, meta: null,          // probe results
  an: null, offsetSec: 0,          // audio analysis (the expensive part, once per file)
  Ecache: new Map(),               // "p|fMin" -> energy per frame
  params: presetParams(0), presetIndex: 0,
  curve: null,                     // { dy, rot, blur, amp, peak } in reference px
  out: null,                       // { blob, name, file } after export
  running: null,                   // active Conversion
};
window.__app = S;                  // for automated checks

const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : "?";
const mb = b => (b / 1048576).toFixed(1) + " MB";
const even = n => Math.max(2, Math.round(n / 2) * 2);

// ------------------------------------------------------------- controls ----------
// [key, label, min, max, step, format, hint]. Meanings and statuses: SOP-03 register.
const MAIN = [
  ["K", "Strength", 0, 50, 1, v => v + " px", "Peak movement. Scales everything: shake, tilt, blur."],
  ["blurK", "Motion blur", 0, 0.4, 0.01, v => v.toFixed(2), "Extra smear on each jolt."],
  ["blurSustain", "Bass smear", 0, 0.6, 0.01, v => v.toFixed(2), "Smear while deep bass is held — makes long 808s visible."],
  ["rate", "Speed", 7.5, 15, 7.5, v => v === 15 ? "fast" : "slow", "Fast flips every frame; slow every two."],
];
const MORE = [
  ["decay", "Ring-down", 0.2, 0.8, 0.01, v => v.toFixed(2), "How long each hit keeps shaking. Lower = shorter, more rests."],
  ["knee", "Ceiling", 0.3, 1.0, 0.05, v => v >= 1 ? "hard" : v.toFixed(2), "Softens the biggest hits. 1.0 = hard limit."],
  ["gamma", "Response", 0.25, 1.5, 0.05, v => v.toFixed(2), "Low = small hits shake almost as much as big ones."],
  ["t", "Threshold", 0, 0.6, 0.02, v => v.toFixed(2), "Ignore hits below this."],
  ["p", "Bass focus", 1, 6, 0.5, v => v.toFixed(1), "Higher = only the deepest bass moves it."],
  ["fMin", "Low cut", 15, 60, 1, v => v + " Hz", "Lowest frequency that counts."],
  ["normWindow", "Context", 1, 10, 0.5, v => v + " s", "Each hit is judged against the loudest bass this close by."],
];

function buildControls() {
  const sel = $("preset");
  PRESETS.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.name; sel.append(o); });
  const o = document.createElement("option"); o.value = "custom"; o.textContent = "Custom"; o.disabled = true; sel.append(o);
  sel.addEventListener("change", () => { S.presetIndex = Number(sel.value); S.params = presetParams(S.presetIndex); syncControls(); paramsChanged("preset " + PRESETS[S.presetIndex].name); });
  for (const [list, box] of [[MAIN, $("mainCtls")], [MORE, $("moreCtls")]]) for (const [key, label, min, max, step, f, hint] of list) {
    const d = document.createElement("div"); d.className = "ctl";
    d.innerHTML = `<label for="c_${key}">${label}</label><input type="range" id="c_${key}" min="${min}" max="${max}" step="${step}"><output id="o_${key}"></output><p class="hint">${hint}</p>`;
    box.append(d);
    const inp = d.querySelector("input");
    inp.addEventListener("input", () => { S.params[key] = Number(inp.value); $("o_" + key).textContent = f(S.params[key]); sel.value = "custom"; paramsChanged(null); });
    inp.addEventListener("change", () => log("set " + key + " = " + S.params[key]));
  }
  $("resetBtn").addEventListener("click", () => { S.params = presetParams(S.presetIndex); sel.value = S.presetIndex; syncControls(); paramsChanged("reset to " + PRESETS[S.presetIndex].name); });
  syncControls();
}
function syncControls() {
  for (const [key, , , , , f] of [...MAIN, ...MORE]) { $("c_" + key).value = S.params[key]; $("o_" + key).textContent = f(S.params[key]); }
}

// --------------------------------------------------------------- loading ---------
$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  S.file = file; S.meta = null; S.an = null; S.Ecache.clear(); S.curve = null; S.out = null;
  for (const id of ["shareBtn", "downloadBtn", "previewVid"]) $(id).hidden = true;
  $("previewBtn").disabled = $("exportBtn").disabled = true;
  $("exportStatus").textContent = $("saveStatus").textContent = $("previewStatus").textContent = "";
  drawPlot();
  if (!file) return;
  log("file: " + file.name + " (" + mb(file.size) + ", type '" + file.type + "')");
  const info = $("info"); info.innerHTML = "<dt>clip</dt><dd>reading…</dd>";
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
    S.meta = { width: v.displayWidth, height: v.displayHeight, codec: v.codec, rotation: v.rotation, fpsMeasured: stats.averagePacketRate, fps, fpsF, v0, dur, nFrames, hasAudio: !!a, aCodec: a && a.codec, vDec, aDec };
    const rows = [
      ["file", file.name], ["format", fmtName], ["video", (v.codec || "unknown") + (vDec ? "" : "  (cannot decode here)")],
      ["size", S.meta.width + " × " + S.meta.height + (v.rotation ? "  (rotated " + v.rotation + "°)" : "")],
      ["frame rate", fmt(stats.averagePacketRate, 3) + " fps → using " + fmt(fpsF, 3)], ["duration", fmt(dur, 2) + " s"],
      ["audio", a ? (a.codec || "unknown") + (aDec ? "" : "  (cannot decode here)") : "none"]
    ];
    info.innerHTML = "";
    for (const [k, val] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = val; info.append(dt, dd); }
    log("probe: " + JSON.stringify(S.meta));
    $("pstart").max = Math.max(0, dur - PREVIEW_LEN).toFixed(1);
    setPreviewStart(dur > 2 * PREVIEW_LEN ? dur / 2 - PREVIEW_LEN / 2 : 0);
    await showSupport();
    if (!vDec) { setStatus("anaStatus", "bad", "This browser can't decode this video."); return; }
    if (!a) { setStatus("anaStatus", "bad", "This clip has no sound, so there's nothing to drive the shake."); return; }
    if (!aDec) { setStatus("anaStatus", "bad", "This browser can't decode this clip's sound."); return; }
    await analyse(a, dur);
    $("previewBtn").disabled = $("exportBtn").disabled = false;
  } catch (e) {
    log("LOAD FAILED: " + (e && (e.stack || e.message)));
    info.innerHTML = "<dt>error</dt><dd></dd>"; info.querySelector("dd").textContent = "This file could not be read here: " + (e && e.message);
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
  paramsChanged("initial");
}

async function showSupport() {
  const box = $("support"); box.innerHTML = "";
  const checks = [["H.264 encode", () => canEncodeVideo("avc")], ["HEVC encode", () => canEncodeVideo("hevc")], ["AAC encode", () => canEncodeAudio("aac")]];
  for (const [name, fn] of checks) {
    let ok = false; try { ok = await fn(); } catch (e) { log(name + " check threw: " + e.message); }
    const p = document.createElement("span"); p.className = "pill " + (ok ? "ok" : "bad"); p.textContent = name + (ok ? " ✓" : " ✗");
    box.append(p); log(name + ": " + ok);
  }
}

// ----------------------------------------------------------------- curve ---------
let logTimer = null;
function paramsChanged(why) {
  if (!S.an) { drawPlot(); return; }
  const P = S.params, m = S.meta;
  const key = P.p + "|" + P.fMin;
  let E = S.Ecache.get(key);
  if (!E) { E = energyPerFrame(S.an, m.nFrames, m.fps, S.offsetSec, P.p, P.fMin); S.Ecache.set(key, E); }
  S.curve = synth(E, P, m.fps);
  const moving = S.curve.dy.reduce((n, v) => n + (Math.abs(v) > 1 ? 1 : 0), 0) / m.nFrames;
  const { w, h } = outputSize();
  const ov = overscanFor(S.curve.dy, S.curve.rot, w, h, Math.max(w, h) / REF_H);
  S.curve.overscan = ov;
  $("curveStatus").textContent = "peak " + fmt(S.curve.peak, 1) + " px · moving " + Math.round(moving * 100) + "% of frames · zoom " + fmt(ov, 1) + "%";
  drawPlot();
  const msg = "curve" + (why ? " (" + why + ")" : "") + ": " + JSON.stringify(P) + " -> peak " + fmt(S.curve.peak, 2) + " px, moving " + Math.round(moving * 100) + "%, overscan " + ov;
  clearTimeout(logTimer);
  if (why) log(msg); else logTimer = setTimeout(() => log(msg), 600);   // sliders: log once they settle
}

function drawPlot() {
  const c = $("plot"), dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(c.clientWidth * dpr)), H = Math.round(130 * dpr);
  if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
  const g = c.getContext("2d"); g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim(), soft = cs.getPropertyValue("--accent-soft").trim(), muted = cs.getPropertyValue("--muted").trim();
  if (!S.curve || !S.meta) { g.fillStyle = muted; g.font = (12 * dpr) + "px system-ui"; g.fillText("no clip yet", 10 * dpr, H / 2); return; }
  const { dy, blur } = S.curve, n = dy.length, fpsF = S.meta.fpsF;
  // preview window
  const ps = Number($("pstart").value);
  const x0 = (ps * fpsF) / n * W, x1 = Math.min(W, ((ps + PREVIEW_LEN) * fpsF) / n * W);
  g.fillStyle = soft; g.fillRect(x0, 0, Math.max(2, x1 - x0), H);
  const scale = (H / 2 - 6 * dpr) / Math.max(30, S.curve.peak);
  g.strokeStyle = muted; g.globalAlpha = 0.5; g.lineWidth = dpr; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); g.globalAlpha = 1;
  // shake: per pixel column, the range of dy
  g.fillStyle = accent;
  for (let px = 0; px < W; px++) {
    const a = Math.floor(px / W * n), b = Math.max(a + 1, Math.floor((px + 1) / W * n));
    let lo = 0, hi = 0; for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, dy[i]); hi = Math.max(hi, dy[i]); }
    if (hi - lo > 0.2) g.fillRect(px, H / 2 - hi * scale, 1, Math.max(1, (hi - lo) * scale));
  }
  // blur as a thin line along the bottom
  g.strokeStyle = muted; g.lineWidth = dpr; g.beginPath();
  for (let px = 0; px < W; px++) {
    const a = Math.floor(px / W * n), b = Math.max(a + 1, Math.floor((px + 1) / W * n));
    let m = 0; for (let i = a; i < b && i < n; i++) m = Math.max(m, blur[i]);
    const y = H - 2 * dpr - m * scale * 0.5; px ? g.lineTo(px, y) : g.moveTo(px, y);
  }
  g.stroke();
}
$("plot").addEventListener("click", e => {
  if (!S.meta) return;
  const r = $("plot").getBoundingClientRect();
  const t = (e.clientX - r.left) / r.width * S.meta.dur;
  setPreviewStart(t - PREVIEW_LEN / 2); log("preview start set from curve: " + fmt(Number($("pstart").value), 1) + " s");
});
window.addEventListener("resize", () => drawPlot());
function setPreviewStart(t) {
  const max = Number($("pstart").max);
  $("pstart").value = Math.max(0, Math.min(max, t)).toFixed(1);
  $("pstartOut").textContent = Number($("pstart").value).toFixed(1) + " s";
  drawPlot();
}
$("pstart").addEventListener("input", () => setPreviewStart(Number($("pstart").value)));
$("fullres").addEventListener("change", () => paramsChanged("resolution " + ($("fullres").checked ? "full" : "capped")));

// --------------------------------------------------------------- render ----------
function outputSize() {
  const m = S.meta; if (!m) return { w: 0, h: 0 };
  let w = m.width, h = m.height;
  if (!$("fullres").checked) { const s = Math.min(1, 1920 / Math.max(w, h)); w *= s; h *= s; }
  return { w: even(w), h: even(h) };
}

// The ONE render path, used by both preview and export. The curve is computed for the
// whole clip; a frame is looked up by its time, so the preview cannot differ from the export.
async function render({ trim, onProgress }) {
  const m = S.meta, cv = S.curve;
  const { w, h } = outputSize();
  const pxScale = Math.max(w, h) / REF_H;               // reference px are 1/1920 of the long side
  const ov = cv.overscan / 100;
  let codec = null;
  for (const c of ["avc", "hevc", "vp9", "av1"]) { if (await canEncodeVideo(c, { width: w, height: h })) { codec = c; break; } }
  if (!codec) throw new Error("this browser cannot encode video at " + w + "×" + h);
  let aCodec = null;
  if (m.hasAudio) for (const c of ["aac", "opus"]) { if (await canEncodeAudio(c)) { aCodec = c; break; } }
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext("2d");
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
        // Blur: shutter (half the move since the last frame, trailing) + directional smear (centred).
        const L = cv.blur[i] * pxScale, trail = 0.5 * (prev - dy);
        const lo = Math.min(0, trail) - L / 2, hi = Math.max(0, trail) + L / 2, span = hi - lo;
        const draws = span < 0.75 ? 1 : Math.min(MAX_BLUR_DRAWS, Math.ceil(span / 2) + 1);
        maxDraws = Math.max(maxDraws, draws);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
        if (draws === 1) {
          ctx.translate(w / 2, h / 2 + dy); ctx.rotate(rot); ctx.scale(ov, ov);
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
        frames++;
        return canvas;
      }
    },
    audio: aCodec ? { codec: aCodec } : { discard: true },
    showWarnings: false
  });
  if (conv.discardedTracks.length) log("discarded tracks: " + conv.discardedTracks.map(d => d.track.type + ":" + d.reason).join(", "));
  if (!conv.isValid) throw new Error("conversion not possible: " + conv.discardedTracks.map(d => d.reason).join(", "));
  log("render start: " + w + "×" + h + " " + codec + "/" + (aCodec || "no-audio") + ", zoom " + fmt(cv.overscan, 1) + "%" + (trim ? ", " + fmt(trim.start, 1) + "–" + fmt(trim.end, 1) + " s" : ", full clip"));
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
  const m = S.meta, k = Math.round((Number($("pstart").value) - m.v0) * m.fpsF);
  const start = m.v0 + (k + 0.5) / m.fpsF, end = Math.min(m.dur, start + PREVIEW_LEN);
  const prog = $("previewProg"), vid = $("previewVid");
  setBusy(true); prog.hidden = false; prog.value = 0; setStatus("previewStatus", "", "Rendering…");
  try {
    const r = await render({ trim: { start, end }, onProgress: (p, f) => { prog.value = p; setStatus("previewStatus", "", "Rendering… " + Math.round(p * 100) + "%"); } });
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
  $("shareBtn").hidden = $("downloadBtn").hidden = true; $("saveStatus").textContent = ""; S.out = null;
  setStatus("exportStatus", "", "Exporting…");
  hiddenDuringRun = false;
  try { sessionStorage.setItem("bs_export_running", "1"); } catch {}
  try { if (navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); log("screen wake lock on"); } } catch (e) { log("wake lock unavailable: " + e.name); }
  const t0 = performance.now();
  try {
    const r = await render({ trim: undefined, onProgress: (p, f) => {
      prog.value = p; const el = (performance.now() - t0) / 1000, eta = p > 0.02 ? el / p - el : NaN;
      setStatus("exportStatus", "", "Exporting… " + Math.round(p * 100) + "% · " + (Number.isFinite(eta) ? Math.ceil(eta) + " s left" : "estimating"));
    } });
    const name = S.file.name.replace(/\.[^.]+$/, "") + " - bass shake.mp4";
    S.out = { blob: r.blob, name, file: new File([r.blob], name, { type: "video/mp4" }) };
    setStatus("exportStatus", "ok", "Done: " + r.frames + " frames, " + mb(r.blob.size) + ", " + fmt(S.meta.dur / r.secs, 2) + "× real time.");
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [S.out.file] }));
    log("share sheet with file: " + (canShare ? "available" : "not available"));
    $("shareBtn").hidden = !canShare; $("downloadBtn").hidden = false;
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
  else setStatus("saveStatus", "ok", "Download started. On iPhone it goes to Files › Downloads.");
  log("download started" + (inClaudeFrame ? " (inside Claude's frame)" : ""));
});

// ------------------------------------------------------------------ misc ----------
function setBusy(b) { $("previewBtn").disabled = $("exportBtn").disabled = $("file").disabled = b || !S.curve; $("file").disabled = b; }
function setStatus(id, cls, text) { const el = $(id); el.className = "status" + (cls ? " " + cls : ""); el.textContent = text; }
function fail(id, what, e) { setStatus(id, "bad", what + " failed: " + (e && e.message)); log(what.toUpperCase() + " FAILED: " + (e && (e.stack || e.message))); }

buildControls();
drawPlot();
window.__ready = true;
log("ready");
