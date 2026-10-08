// Per-control tests: every control does what it says, on the CURVE (the model), with
// synthetic sounds that have a known right answer. Pixel-level checks are in
// tests/pixel_controls.py (renders through the page).
//   node tests/controls.mjs
import { analyseAudio, energyPerFrame, synth, blurRange, wobbleHz, bassShare, bassGain, BASS_FULL, BASS_NONE, bassPeakDb, levelGain, PEAK_FULL_DB, PEAK_NONE_DB } from "../js/shake.js";
import { MAIN, ADVANCED, ALL, UI_PRESETS, presetModel, sliderFor, msFromDecay, BLUR_MARK, WOBBLE } from "../js/controls.js";

const SR = 48000;
let fails = 0, checks = 0;
function check(ok, what, detail = "") { checks++; if (!ok) fails++; console.log((ok ? "  ok   " : "  FAIL ") + what + (detail ? "  — " + detail : "")); }
const ctl = id => ALL.find(c => c.id === id);
const f2 = x => Number.isFinite(x) ? x.toFixed(3) : String(x);

// ---------------------------------------------------------------- signals ----------
function kick(x, t0, gain = 1, f0 = 45, f1 = 75) {
  const i0 = Math.round(t0 * SR), m = Math.round(0.18 * SR); let ph = 0;
  for (let i = 0; i < m && i0 + i < x.length; i++) { const t = i / SR; const f = f0 + (f1 - f0) * Math.exp(-t / 0.03); ph += 2 * Math.PI * f / SR; x[i0 + i] += gain * 0.8 * Math.sin(ph) * Math.exp(-t / 0.06); }
}
function tone(x, t0, t1, f, gain) {
  const a = Math.round(t0 * SR), b = Math.round(t1 * SR), r = 0.02 * SR;
  for (let i = a; i < b && i < x.length; i++) { const e = Math.min(1, (i - a) / r, (b - i) / r); x[i] += gain * e * Math.sin(2 * Math.PI * f * (i - a) / SR); }
}
const sig = {};
{ const x = new Float64Array(12 * SR); for (let k = 0; k < 6; k++) kick(x, 0.5 + 2 * k); sig.sparse = x; }                   // isolated kicks, 2 s apart
{ const x = new Float64Array(12 * SR); for (let k = 0; k < 24; k++) kick(x, 0.25 + 0.5 * k); tone(x, 4, 8, 50, 0.4); sig.held = x; } // kicks + held bass 4-8 s
{ const x = new Float64Array(12 * SR); for (let k = 0; k < 12; k++) kick(x, 0.5 + k, k % 2 ? 0.25 : 1); sig.loudsoft = x; }   // alternating loud / -12 dB
{ const x = new Float64Array(16 * SR); for (let k = 0; k < 16; k++) kick(x, 0.5 + k, k < 8 ? 1 : 0.5); sig.sections = x; }    // loud half, quiet half (-6 dB: energy above the 0.15 floor)
{ const x = new Float64Array(12 * SR); for (let k = 0; k < 6; k++) { tone(x, 0.5 + 2 * k, 0.8 + 2 * k, 35, 0.5); tone(x, 1.5 + 2 * k, 1.8 + 2 * k, 90, 0.5); } sig.subkick = x; }
const AN = {};
for (const [k, x] of Object.entries(sig)) AN[k] = await analyseAudio(x, SR, { yieldEvery: 1e9 });

const FPS = { 30: { num: 30, den: 1 }, 60: { num: 60, den: 1 }, 25: { num: 25, den: 1 }, 2997: { num: 30000, den: 1001 } };
function curve(name, P, fps = FPS[30]) {
  const an = AN[name], fpsF = fps.num / fps.den, n = Math.floor(an.nSamples / SR * fpsF) - 1;
  const E = energyPerFrame(an, n, fps, 0, P.p, P.fMin);
  return synth(E, P, fps);
}
function withSlider(base, id, v) { const P = Object.assign({}, base); Object.assign(P, ctl(id).toModel(v)); return P; }
const slam = presetModel("Slam");
const range = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const mono = (arr, dir = 1, strict = false) => arr.every((v, i) => i === 0 || (strict ? dir * (v - arr[i - 1]) > 0 : dir * (v - arr[i - 1]) >= -1e-9));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const maxAbs = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// ---------------------------------------------------------------- 1. mappings ----------
console.log("\n1. Slider <-> model mappings");
for (const c of ALL) {
  if (c.seg) continue;
  const xs = range(c.min, c.max, 41), key = Object.keys(c.toModel(c.min));
  const ys = xs.map(s => c.toModel(s)[key[key.length - 1]]);
  let rt = 0; for (const s of xs) { const P = Object.assign({}, slam, c.toModel(s)); rt = Math.max(rt, Math.abs(c.fromModel(P) - s)); }
  check(rt < 1e-6, c.id + ": slider -> model -> slider round trip", "max error " + rt.toExponential(1));
  check(xs.every(s => typeof c.show(s, Object.assign({}, slam, c.toModel(s))) === "string"), c.id + ": readout for every position");
}
check(mono(range(0, 100, 101).map(s => ctl("strength").toModel(s).K), 1, true), "strength: K rises strictly");
check(ctl("strength").toModel(0).K === 0, "strength 0% = no shake");
{
  const b = ctl("blur"), xs = range(0, 100, 101);
  const sh = xs.map(s => b.toModel(s).shutter), bk = xs.map(s => b.toModel(s).blurK);
  check(mono(sh) && mono(bk), "motion blur: shutter and extra blur never fall as the slider rises");
  check(sh[0] === 0 && b.toModel(BLUR_MARK).shutter === 180 && bk.slice(0, BLUR_MARK + 1).every(v => v === 0), "motion blur: 0..mark = shutter 0..180 deg, no extra", "mark at " + BLUR_MARK);
  check(b.toModel(BLUR_MARK + 1).blurK > 0 && b.toModel(BLUR_MARK + 1).blurK < 0.01, "motion blur: extra starts from zero just past the mark (no jump)", "blurK at mark+1 = " + f2(b.toModel(BLUR_MARK + 1).blurK));
}
check(mono(range(0, 100, 101).map(s => ctl("smear").toModel(s).blurSustain), 1, true), "bass smear rises strictly");
check(mono(range(50, 350, 61).map(s => ctl("ring").toModel(s).decay), 1, true), "ring-down: longer ms = slower decay");
check(mono(range(0, 100, 101).map(s => ctl("respond").toModel(s).p), -1, true), "respond to: right = flatter weighting (lower p)");
check(Math.abs(ctl("dynamics").toModel(50).gamma - 0.5) < 1e-12, "dynamics: natural (gamma 0.5) exactly in the middle");
check(mono(range(0, 100, 101).map(s => ctl("dynamics").toModel(s).gamma), 1, true), "dynamics: right = more expanded (higher gamma)");
console.log("  presets (slider positions after snapping to steps; real values kept exactly until a slider moves):");
for (const name of UI_PRESETS) {
  const P = presetModel(name);
  console.log("    " + name.padEnd(7) + ALL.map(c => c.id + " " + (c.seg ? c.seg[sliderFor(c, P)] : c.show(sliderFor(c, P), P))).join(" · "));
  // snapping a preset onto the sliders, then moving nothing, must not change the curve: the page keeps
  // the preset's real values. Check the error IF the snapped sliders were applied is small anyway.
  let worst = 0, worstId = "";
  for (const c of ALL) { if (c.seg) continue; const Q = Object.assign({}, P, c.toModel(sliderFor(c, P))); const k = Object.keys(c.toModel(c.min)).pop(); const rel = Math.abs(Q[k] - P[k]) / Math.max(1e-9, Math.abs(P[k]) || 1); if (rel > worst) { worst = rel; worstId = c.id; } }
  check(worst < 0.05, name + ": snapped sliders within 5 % of the preset's values", "worst " + worstId + " " + (100 * worst).toFixed(1) + "%");
}

// ---------------------------------------------------------------- 2. effects on the curve ----------
console.log("\n2. Each control's effect on the shake curve (synthetic sounds)");
// Strength
{
  const xs = [0, 10, 25, 41, 60, 80, 100], pk = xs.map(s => curve("held", withSlider(slam, "strength", s)).peak);
  check(pk[0] === 0 && mono(pk, 1, true), "strength: peak shake rises with the slider, 0 at 0%", pk.map(v => v.toFixed(1)).join(" "));
  const a = curve("held", withSlider(slam, "strength", 50)), b = curve("held", withSlider(slam, "strength", 100));
  const r = b.peak / a.peak, rb = maxAbs(b.blur) / maxAbs(a.blur);
  check(Math.abs(r - rb) < 1e-6, "strength is the master: shake and blur scale together", "shake x" + r.toFixed(3) + ", blur x" + rb.toFixed(3));
}
// Wobble: the oscillation follows TIME, capped at half the frame rate
for (const [fk, label] of [[30, "30"], [60, "60"], [25, "25"], [2997, "29.97"]]) {
  const fps = FPS[fk], fpsF = fps.num / fps.den;
  for (let i = 0; i < WOBBLE.length; i++) {
    const P = withSlider(slam, "wobble", i), c = curve("held", P, fps);
    const want = Math.min(WOBBLE[i][1], fpsF / 2);
    // recover the phase step from dy/amp on frames with real movement
    let err = 0, used = 0;
    for (let j = 1; j < c.dy.length - 1; j++) if (c.amp[j] > 2) { const expect = c.amp[j] * Math.cos(2 * Math.PI * want * j / fpsF); err = Math.max(err, Math.abs(c.dy[j] - expect)); used++; }
    check(err < 1e-6 && used > 50 && Math.abs(wobbleHz(P.rate, fps) - want) < 1e-12, "wobble " + WOBBLE[i][0] + " @ " + label + " fps = " + want.toFixed(2) + " Hz", used + " frames, max err " + err.toExponential(1) + " px");
  }
}
// Motion blur: shutter (render-only) then extra blur on the curve. Measure the total blur span per frame.
{
  const xs = range(0, 100, 21), spans = [];
  for (const s of xs) {
    const P = withSlider(withSlider(slam, "blur", s), "smear", 0), c = curve("held", P); let tot = 0;
    for (let j = 1; j < c.dy.length; j++) { const r = blurRange(c.dy[j - 1], c.dy[j], c.blur[j], P.shutter); tot += r.hi - r.lo; }
    spans.push(tot / c.dy.length);
  }
  check(spans[0] < 1e-9, "motion blur 0% = sharp (no trail, no extra smear; bass smear 0)", "mean span " + f2(spans[0]) + " ref px");
  check(mono(spans, 1, true), "motion blur: average blur span rises across the whole slider", spans.map(v => v.toFixed(1)).join(" "));
  const P = withSlider(slam, "blur", BLUR_MARK - 5), Q = withSlider(slam, "blur", BLUR_MARK);
  check(curve("held", P).blur.every((v, j) => v === curve("held", Q).blur[j]), "motion blur below the mark changes only the shutter, not the curve");
}
// blurRange itself: centroid = dy + trail/2, trail = shutter/360 of the move
{
  const r = blurRange(10, 0, 0, 180), r0 = blurRange(10, 0, 0, 0), r2 = blurRange(10, 0, 4, 90);
  check(r.lo === 0 && r.hi === 5 && r0.hi - r0.lo === 0 && Math.abs((r2.lo + r2.hi) / 2 - 1.25) < 1e-12 && Math.abs(r2.hi - r2.lo - 6.5) < 1e-12, "blur range: 180 deg trails half the move; 0 deg none; smear centred");
}
// Bass smear: blur while the held bass plays (4-8 s), relative to kicks-only stretches
{
  const xs = [0, 25, 44, 70, 100], held = [];
  for (const s of xs) { const P = withSlider(withSlider(slam, "blur", 0), "smear", s), c = curve("held", P); held.push(mean(Array.from(c.blur.slice(5 * 30, 7 * 30)))); }
  check(held[0] < 1e-9 && mono(held, 1, true), "bass smear: blur during held bass rises with the slider, none at 0%", held.map(v => v.toFixed(1)).join(" "));
}
// Ring-down: an isolated hit's shake falls to 1/10 after the time shown (natural dynamics, no softening)
for (const fk of [30, 60, 25]) {
  const fps = FPS[fk], fpsF = fps.num / fps.den, rows = [];
  let ok = true;
  for (const ms of [50, 100, 170, 250, 350]) {
    const P = Object.assign(withSlider(withSlider(slam, "ring", ms), "context", 10), { knee: 1 }), c = curve("sparse", P, fps);
    const hits = [];
    for (let k = 1; k < 5; k++) {                     // kicks 2..5 (away from the ends)
      const a = Math.round((0.5 + 2 * k - 0.1) * fpsF), b = Math.round((0.5 + 2 * k + 1.5) * fpsF);
      let pi = a; for (let j = a; j < b; j++) if (c.amp[j] > c.amp[pi]) pi = j;
      let j = pi; while (j < b && c.amp[j] > 0.1 * c.amp[pi]) j++;
      // interpolate the crossing (geometric decay between frames)
      const t = (j - 1 - pi) + Math.log(0.1 * c.amp[pi] / c.amp[j - 1]) / Math.log(c.amp[j] / c.amp[j - 1]);
      hits.push(1000 * t / fpsF);
    }
    const got = mean(hits); rows.push(ms + "->" + got.toFixed(0));
    if (Math.abs(got - ms) > 1000 / fpsF) ok = false;
  }
  check(ok, "ring-down @ " + fk + " fps: time to 1/10 = the ms shown (within one frame)", rows.join(" "));
}
// Respond to: kick-range (90 Hz) vs sub (35 Hz) tones of equal level
{
  const xs = [0, 25, 40, 60, 80, 100], ratio = [];
  for (const r of xs) {
    const P = withSlider(withSlider(withSlider(slam, "respond", r), "ring", 350), "context", 10), c = curve("subkick", P);
    const sub = [], kk = [];
    for (let k = 1; k < 5; k++) { sub.push(Math.max(...c.amp.slice(Math.round((0.5 + 2 * k) * 30), Math.round((0.9 + 2 * k) * 30)))); kk.push(Math.max(...c.amp.slice(Math.round((1.5 + 2 * k) * 30), Math.round((1.9 + 2 * k) * 30)))); }
    ratio.push(mean(kk) / mean(sub));
  }
  check(mono(ratio, 1, true) && ratio[0] < 0.5, "respond to: moving right makes 90 Hz count more relative to 35 Hz", ratio.map(f2).join(" "));
}
// Threshold: quieter bass stops moving the picture
{
  const xs = [0, 10, 20, 30, 45, 60], moving = [];
  for (const v of xs) { const c = curve("loudsoft", withSlider(slam, "threshold", v)); moving.push(c.dy.filter(d => Math.abs(d) > 0.5).length); }
  check(mono(moving, -1) && moving[moving.length - 1] < moving[0], "threshold: fewer moving frames as it rises", moving.join(" "));
  // the soft kicks (-12 dB) sit near 25 % of the loud ones: they should vanish by ~30 %
  const soft = v => { const c = curve("loudsoft", withSlider(withSlider(slam, "threshold", v), "context", 1)); let m = 0; for (let k = 1; k < 11; k += 2) m = Math.max(m, ...c.amp.slice(Math.round((0.4 + k) * 30), Math.round((0.9 + k) * 30))); return m; };
  check(soft(0) > 1 && soft(60) === 0, "threshold: soft hits shake at 'off', are ignored at 60 %", "soft-hit peak " + soft(0).toFixed(1) + " -> " + soft(60).toFixed(1) + " px");
}
// Dynamics: soft hits relative to loud ones
{
  const xs = [0, 25, 50, 75, 100], ratio = [];
  for (const d of xs) {
    const c = curve("loudsoft", Object.assign(withSlider(withSlider(slam, "dynamics", d), "context", 10), { knee: 1 }));
    const pk = k => Math.max(...c.amp.slice(Math.round((0.4 + k) * 30), Math.round((0.9 + k) * 30)));
    ratio.push(mean([1, 3, 5, 7, 9].map(pk)) / mean([2, 4, 6, 8, 10].map(pk)));
  }
  check(mono(ratio, -1, true), "dynamics: towards 'expanded' the soft hits shrink relative to the loud", ratio.map(f2).join(" "));
}
check(!ALL.some(c => c.id === "soften"), "soften peaks removed from the controls (knee stays at the preset value)");
// Context: a quiet section after a loud one
{
  const xs = [1, 2, 4, 6, 10], ratio = [];
  for (const v of xs) {
    const c = curve("sections", Object.assign(withSlider(slam, "context", v), { knee: 1 }));
    const sec = (a, b) => { const r = []; for (let k = a; k < b; k++) r.push(Math.max(...c.amp.slice(Math.round((0.4 + k) * 30), Math.round((0.9 + k) * 30)))); return mean(r); };
    ratio.push(sec(11, 15) / sec(1, 6));             // quiet (well inside its half) vs loud
  }
  check(mono(ratio, -1) && ratio[0] > 0.9 && ratio[ratio.length - 1] < 0.9, "context: a short window lifts quiet passages; a long one keeps them quieter", ratio.map(f2).join(" "));
}

// ---------------------------------------------------------------- 3. bass presence ----------
console.log("\n3. Bass presence (clips with little bass get a smaller shake)");
{
  const tone = f => new Float64Array(6 * SR).map((_, i) => Math.sin(2 * Math.PI * f * i / SR));
  const s60 = bassShare(await analyseAudio(tone(60), SR, { yieldEvery: 1e9 }), tone(60));
  const s1k = bassShare(await analyseAudio(tone(1000), SR, { yieldEvery: 1e9 }), tone(1000));
  check(Math.abs(s60 - 1) < 0.02 && s1k < 0.001, "bass share: a 60 Hz tone is all bass, a 1 kHz tone none", (100 * s60).toFixed(1) + "% / " + (100 * s1k).toFixed(2) + "%");
  const sMusic = bassShare(AN.held, sig.held);
  check(sMusic > BASS_FULL && bassGain(sMusic) === 1, "kicks + held bass: full shake", (100 * sMusic).toFixed(1) + "%");
  const g = range(0, 0.4, 81).map(bassGain);
  check(bassGain(BASS_NONE) === 0 && bassGain(BASS_FULL) === 1 && mono(g), "gain: 0 at <=5 %, 1 at >=25 %, never falls as bass share rises",
    [0.05, 0.08, 0.12, 0.15, 0.2, 0.25].map(s => (100 * s) + "%->" + bassGain(s).toFixed(2)).join(" "));
}

{
  const tone = (f, a) => new Float64Array(6 * SR).map((_, i) => a * Math.sin(2 * Math.PI * f * i / SR));
  const pk = async a => bassPeakDb(await analyseAudio(tone(60, a), SR, { yieldEvery: 1e9 }));
  const p0 = await pk(1), p40 = await pk(0.01), p60 = await pk(0.001);
  check(Math.abs(p0 + 3.01) < 0.3 && Math.abs(p40 - (p0 - 40)) < 0.3 && Math.abs(p60 - (p0 - 60)) < 0.3, "loudest bass: a full-scale 60 Hz tone reads -3 dB, and tracks level exactly", [p0, p40, p60].map(v => v.toFixed(1)).join(" / ") + " dB");
  check(levelGain(p0) === 1 && levelGain(p60) === 0 && levelGain((PEAK_FULL_DB + PEAK_NONE_DB) / 2) > 0.4 && levelGain((PEAK_FULL_DB + PEAK_NONE_DB) / 2) < 0.6, "level gain: full at >= " + PEAK_FULL_DB + " dB, none at <= " + PEAK_NONE_DB + " dB",
    [-30, -42, -46, -50, -55].map(d => d + "->" + levelGain(d).toFixed(2)).join(" "));
  const x = new Float64Array(20 * SR); for (let i = 0; i < 0.5 * SR; i++) x[10 * SR + i] = 0.5 * Math.sin(2 * Math.PI * 50 * i / SR);   // one bass event in 20 s of silence
  check(levelGain(bassPeakDb(await analyseAudio(x, SR, { yieldEvery: 1e9 }))) === 1, "one loud bass event in a long silent clip still counts (peak, not average)");
}

console.log("\n" + checks + " checks, " + fails + " failed\nRESULT: " + (fails ? "FAIL" : "PASS"));
process.exit(fails ? 1 : 0);
