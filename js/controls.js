// controls.js — what the sliders SHOW vs the model values underneath. Pure, no DOM: the page
// and the per-control tests (tests/controls.mjs) both import this file.
//
// Rule (BASSAPP-003): sliders are shown 0-100 % (main) or in real units where they help
// (Advanced), mapped onto the tuned ranges, curved where needed so the middle feels like the
// middle, and "more effect to the right". DISPLAY ONLY: presets, the report and the golden
// test use the real values. A preset sets real values exactly; the sliders are moved to the
// nearest step, and a value only changes once its own slider is moved.

import { BASE, PRESETS } from "./shake.js";

// Tuned ranges (widened from v1: the Manager needed the top of Strength and blur, BASSAPP-002).
export const K_MAX = 100;           // reference px (1/1920 of the long side) at 100 %; v1 max was 50
export const BLURK_MAX = 1.0;       // extra motion blur at 100 %; v1 max 0.4
export const SMEAR_MAX = 1.2;       // bass smear at 100 %; v1 max 0.6
export const BLUR_MARK = 40;        // Motion blur slider: 0..40 = realistic shutter 0..180 deg; 40..100 = extra
export const CURVE = 1.5;           // power curve for the % sliders (50 % ~ a third of the range)
export const WOBBLE = [["Fast", 15], ["Slow", 7.5]];   // Hz, by time (Ultra-slow 3.75 dropped BASSAPP-004: too slow to read as bass)

// Frequency response range (no longer shown as a readout): in a typical mix, ~90 % of the bass energy the shake responds to
// lies below this frequency. Measured on four real club mixes (the VIDEO project's EDIT 01-04
// audio), Welch spectra 25-500 Hz, geometric mean across tracks; rounded to 5 Hz when shown.
// An approximation for orientation only: the model is the 1/f^p weighting, unchanged.
const RESP_P = [0.7, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 8, 10, 14, 20];
const RESP_HZ = [111, 103, 90, 76, 64, 62, 56, 53, 51, 49, 48, 48, 45, 40, 39, 34, 31];
export const RESP_PMAX = 20, RESP_PMIN = 0.7;
// Typical-mix bass spectrum (power, peak 1), 25-200 Hz: geometric mean of the same four mixes' Welch
// spectra. Used by the Frequency response plot until a clip is loaded.
export const TYPICAL_MIX = [[26.9,0.1],[32.3,0.415],[37.7,0.897],[43.1,1],[48.4,0.636],[53.8,0.469],[59.2,0.474],[64.6,0.436],[70,0.26],[75.4,0.259],[80.7,0.276],[86.1,0.213],[91.5,0.142],[96.9,0.121],[102.3,0.109],[107.7,0.0878],[113,0.0832],[118.4,0.0787],[123.8,0.117],[129.2,0.152],[134.6,0.118],[140,0.0693],[145.3,0.044],[150.7,0.039],[156.1,0.0399],[161.5,0.0333],[166.9,0.0301],[172.3,0.0284],[177.6,0.0268],[183,0.0241],[188.4,0.022],[193.8,0.027],[199.2,0.027]];
export function respondHz(p) {
  if (p <= RESP_P[0]) return RESP_HZ[0];
  for (let i = 1; i < RESP_P.length; i++) if (p <= RESP_P[i]) {
    const f = (p - RESP_P[i - 1]) / (RESP_P[i] - RESP_P[i - 1]);
    return Math.exp(Math.log(RESP_HZ[i - 1]) * (1 - f) + Math.log(RESP_HZ[i]) * f);
  }
  return RESP_HZ[RESP_HZ.length - 1];
}

// Ring-down shown in ms = time for one isolated hit's shake to fall to 1/10, at natural
// Dynamics (gamma 0.5). decay is per 30 fps frame (the model rescales it for other rates).
// Shake ~ decay^(gamma * frames), so 0.1 = decay^(0.5 * 30 * T)  =>  decay = 0.1^(2 / (30 T)).
const RING_GAMMA = 0.5;
export const decayFromMs = ms => Math.pow(0.1, 1 / (RING_GAMMA * 30 * ms / 1000));
export const msFromDecay = d => 1000 * Math.log(0.1) / (RING_GAMMA * 30 * Math.log(d));

const pow = (s, c = CURVE) => Math.pow(Math.max(0, s) / 100, c);
const unpow = (x, c = CURVE) => 100 * Math.pow(Math.max(0, x), 1 / c);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = v => Math.round(v) + "%";

// Each control: id, label, hint, slider min/max/step, toModel(slider) -> {key: value},
// fromModel(params) -> slider position, show(slider, params) -> readout text.
// Optional: scale [left, right] end labels, marks [{at, label}] or crossover {at, labels}.
export const MAIN = [
  { id: "strength", label: "Strength", hint: "", min: 0, max: 100, step: 1,
    toModel: s => ({ K: K_MAX * pow(s) }),
    fromModel: P => unpow(P.K / K_MAX),
    show: s => pct(s) },
  { id: "wobble", label: "Wobble", hint: "", seg: WOBBLE.map(w => w[0]),
    toModel: i => ({ rate: WOBBLE[i][1] }),
    fromModel: P => { let b = 0; WOBBLE.forEach((w, i) => { if (Math.abs(w[1] - P.rate) < Math.abs(WOBBLE[b][1] - P.rate)) b = i; }); return b; } },
  { id: "blur", label: "Motion blur", hint: "", min: 0, max: 100, step: 1,
    crossover: { at: BLUR_MARK, labels: ["natural", "extra"] },
    toModel: s => s <= BLUR_MARK ? { shutter: 180 * s / BLUR_MARK, blurK: 0 }
                                 : { shutter: 180, blurK: BLURK_MAX * pow(100 * (s - BLUR_MARK) / (100 - BLUR_MARK)) },
    fromModel: P => (P.blurK > 0) ? BLUR_MARK + (100 - BLUR_MARK) * unpow(P.blurK / BLURK_MAX) / 100
                                  : BLUR_MARK * clamp(P.shutter ?? 180, 0, 180) / 180,
    show: s => pct(s) },
  { id: "smear", label: "Bass smear", hint: "blur while bass is held", min: 0, max: 100, step: 1,
    toModel: s => ({ blurSustain: SMEAR_MAX * pow(s) }),
    fromModel: P => unpow(P.blurSustain / SMEAR_MAX),
    show: s => pct(s) },
];

// "Soften peaks" (knee) removed BASSAPP-004: the level is already normalised to the loudest bass
// nearby, so the soft ceiling only trimmed the top ~9 % at most. knee stays at the preset value (0.5).
export const ADVANCED = [
  { id: "ring", label: "Ring-down", hint: "how long hits keep shaking", min: 50, max: 350, step: 5,
    toModel: ms => ({ decay: decayFromMs(ms) }),
    fromModel: P => msFromDecay(P.decay),
    show: ms => Math.round(ms) + " ms" },
  { id: "respond", label: "Frequency response", hint: "", min: 0, max: 100, step: 1, scale: ["sub only", "kick + bass"],
    // p on a log scale from 20 (~30 Hz, sub only) to 0.7 (~110 Hz, kick + bass); the shipped p = 4
    // sits near the middle (48 %). Range widened BASSAPP-004 (was p 6..1 = ~45..90 Hz).
    toModel: r => ({ p: Math.exp(Math.log(RESP_PMAX) + (Math.log(RESP_PMIN) - Math.log(RESP_PMAX)) * r / 100) }),
    fromModel: P => 100 * (Math.log(P.p) - Math.log(RESP_PMAX)) / (Math.log(RESP_PMIN) - Math.log(RESP_PMAX)),
    // Shown as 0-100 % like the other sliders (BASSAPP-004); its plot shows what it means in Hz.
    show: r => Math.round(r) + "%" },
  { id: "threshold", label: "Threshold", hint: "", min: 0, max: 60, step: 1, scale: ["off", "% of the loudest nearby"],
    toModel: v => ({ t: v / 100 }),
    fromModel: P => 100 * P.t,
    show: v => Math.round(v) === 0 ? "off" : "below " + Math.round(v) + "%" },
  { id: "dynamics", label: "Dynamics", hint: "", min: 0, max: 100, step: 1, scale: ["compressed", "expanded"],
    marks: [{ at: 50, label: "natural" }],
    // natural (gamma 0.5) in the MIDDLE; log steps: 0 -> 0.25, 100 -> 1.5
    toModel: d => ({ gamma: d <= 50 ? 0.5 * Math.pow(2, (d - 50) / 50) : 0.5 * Math.pow(3, (d - 50) / 50) }),
    fromModel: P => P.gamma <= 0.5 ? 50 + 50 * Math.log2(P.gamma / 0.5) : 50 + 50 * Math.log(P.gamma / 0.5) / Math.log(3),
    show: d => d < 44 ? "compressed" : d > 56 ? "expanded" : "natural" },
  { id: "context", label: "Context", hint: "time window that sets ‘loud’", min: 1, max: 10, step: 0.5,
    toModel: v => ({ normWindow: v }),
    fromModel: P => P.normWindow,
    show: v => "± " + Number(v).toFixed(1) + " s" },
];

export const ALL = [...MAIN, ...ADVANCED];

// Presets shown as chips (BASSAPP-003 mockup: five + Custom). The model's PRESETS list keeps
// all seven for the golden test; "Slam slow" / "Slam hard" are now Slam + Wobble / Strength.
export const UI_PRESETS = PRESETS.slice(0, 5).map(p => p.name);
export function presetModel(name) { return Object.assign({}, BASE, PRESETS.find(p => p.name === name)); }

// Slider position for a control from model params, snapped to the slider's step and range.
export function sliderFor(c, P) {
  const v = c.fromModel(P);
  if (c.seg) return v;
  return clamp(Math.round((v - c.min) / c.step) * c.step + c.min, c.min, c.max);
}
