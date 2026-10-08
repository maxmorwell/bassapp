// shake.js — the bass-shake model. Pure maths, no DOM: runs in the browser and in Node
// (the golden test imports this exact file).
//
// A port of the VIDEO project's reference generator, bass_shake_gen.py. The golden test
// (tests/golden.py) checks that, at 30 fps, every curve here matches the reference per frame.
// Do not change the maths here without re-running it. Parameter meanings, status
// (derived / fitted / taste) and defaults come from the VIDEO project's SOP-03 register.
//
// The one deliberate generalisation: the reference is 30 fps only. Here the frame rate is a
// parameter. Anything defined in SECONDS (analysis windows, norm window) follows time; the
// ring-down is rescaled so it decays at the same rate per SECOND; the oscillation ("rate", Hz)
// follows TIME too (BASSAPP-002: the 60 fps "slow" look = the 30 fps "fast" look), capped at
// half the frame rate (= flip every frame; anything faster would alias). At exactly 30 fps
// every rescaling is the identity.

export const NFFT = 8192, HOP = 256;     // 5.4 Hz bins at 44.1k. Not free: see SOP-03.
export const F_MAX_COMPUTE = 500;        // not a parameter; bounds the sum for compute only
export const SPEC_F_LO = 10;             // lowest bin we keep (f_min slider goes down to 15)
export const NORM_FLOOR = 0.15;          // guard: rolling reference >= this x global max
export const ROT_PER_PX = 0.0375;        // CALIBRATED deg/px (a fit, not physics)
export const REF_FPS = 30;               // the reference generator's frame rate
export const REF_H = 1920, REF_W = 1080; // reference frame (portrait); px are in these units

// Shared by every preset (the shipped model, VIDEO-004 BLENDS).
export const BASE = { p: 4.0, fMin: 25, gamma: 0.5, decay: 0.40, normWindow: 4, knee: 0.5, t: 0.0, rate: 15, shutter: 180 };
// shutter (deg, 0-180) is render-only: it never changes the curve (see blurRange).
// The BLENDS palette (eye-approved and posted). K = peak px, blurK = motion-blur
// exaggeration, blurSustain = smear driven by bass level.
export const PRESETS = [
  { name: "Slam",      K: 26, blurK: 0.18, blurSustain: 0.35 },
  { name: "Punch",     K: 26, blurK: 0.10, blurSustain: 0.18 },
  { name: "Swell",     K: 18, blurK: 0.26, blurSustain: 0.50 },
  { name: "Nudge",     K: 18, blurK: 0.10, blurSustain: 0.18 },
  { name: "Breath",    K: 12, blurK: 0.08, blurSustain: 0.15 },
  { name: "Slam slow", K: 26, blurK: 0.18, blurSustain: 0.35, rate: 7.5 },
  { name: "Slam hard", K: 34, blurK: 0.18, blurSustain: 0.35 },
];
export function presetParams(i) { return Object.assign({}, BASE, PRESETS[i]); }

// Python semantics, so integer arithmetic matches the reference exactly.
const floorDiv = (a, b) => Math.floor(a / b);
const ceilDiv = (a, b) => -Math.floor(-a / b);
export function pyRound(x) {                       // round half to even, like Python 3
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

// ------------------------------------------------------------------ FFT -----------
// Real FFT of length N via one complex FFT of length N/2. Only the bins we need are
// unpacked. Float64 throughout.
function makeFFT(M) {                               // complex radix-2, size M
  const levels = Math.log2(M);
  if (!Number.isInteger(levels)) throw new Error("FFT size must be a power of 2");
  const rev = new Uint32Array(M);
  for (let i = 0; i < M; i++) { let r = 0, x = i; for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cos = new Float64Array(M / 2), sin = new Float64Array(M / 2);
  for (let i = 0; i < M / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / M); sin[i] = Math.sin(2 * Math.PI * i / M); }
  return function (re, im) {                        // in place, forward (e^-i)
    for (let i = 0; i < M; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1, step = M / size;
      for (let i = 0; i < M; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

// np.hanning: symmetric Hann, 0.5 - 0.5 cos(2 pi n / (N-1))
function hann(N) { const w = new Float64Array(N); for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)); return w; }

// ------------------------------------------------------------- analysis -----------
// STFT power spectrum of the WHOLE track, kept only for bins in [SPEC_F_LO, F_MAX_COMPUTE].
// Windows start at sample k*HOP (the reference's hop grid with slice start 0).
// Expensive part; done once per file. Everything after this is cheap.
export async function analyseAudio(x, sr, { onProgress, yieldEvery = 256 } = {}) {
  const M = NFFT / 2;
  const fft = makeFFT(M);
  const win = hann(NFFT);
  const klo = Math.ceil(SPEC_F_LO * NFFT / sr), khi = Math.floor(F_MAX_COMPUTE * NFFT / sr);
  const nb = khi - klo + 1;
  const nHops = x.length >= NFFT ? 1 + floorDiv(x.length - NFFT, HOP) : 0;
  const spec = new Float64Array(nHops * nb);
  const re = new Float64Array(M), im = new Float64Array(M);
  const tw = new Float64Array(2 * nb);              // e^{-2 pi i k / N} for the bins we keep
  for (let b = 0; b < nb; b++) { const k = klo + b; tw[2 * b] = Math.cos(2 * Math.PI * k / NFFT); tw[2 * b + 1] = -Math.sin(2 * Math.PI * k / NFFT); }
  for (let h = 0; h < nHops; h++) {
    const s = h * HOP;
    for (let n = 0; n < M; n++) { re[n] = x[s + 2 * n] * win[2 * n]; im[n] = x[s + 2 * n + 1] * win[2 * n + 1]; }
    fft(re, im);
    for (let b = 0; b < nb; b++) {
      const k = klo + b, mk = (M - k) % M;
      const zr = re[k], zi = im[k], cr = re[mk], ci = -im[mk];     // Z[k], conj(Z[M-k])
      const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);            // even part
      const or_ = 0.5 * (zr - cr), oi = 0.5 * (zi - ci);           // odd part (times -i below)
      const wr = tw[2 * b], wi = tw[2 * b + 1];
      // X[k] = E + (-i) * W * O
      const pr = wr * or_ - wi * oi, pi = wr * oi + wi * or_;
      const xr = er + pi, xi = ei - pr;
      spec[h * nb + b] = xr * xr + xi * xi;
    }
    if (h % yieldEvery === yieldEvery - 1) {
      if (onProgress) onProgress((h + 1) / nHops);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(1);
  return { sr, klo, khi, nb, nHops, spec, nSamples: x.length };
}

// 1/f^p weighted energy, peak-held down to the video frame rate.
// fps is a rational {num, den} so integer sample arithmetic stays exact (30 = {30,1}).
export function energyPerFrame(an, nFrames, fps, offsetSec, p, fMin) {
  const { sr, klo, nb, nHops, spec } = an;
  const wgt = new Float64Array(nb);
  for (let b = 0; b < nb; b++) { const f = (klo + b) * sr / NFFT; wgt[b] = (f >= fMin && f <= F_MAX_COMPUTE) ? Math.pow(f, -p) : 0; }
  const fine = new Float64Array(nHops);
  for (let h = 0; h < nHops; h++) { let s = 0; const o = h * nb; for (let b = 0; b < nb; b++) s += spec[o + b] * wgt[b]; fine[h] = s; }
  const base = pyRound(offsetSec * sr) - NFFT / 2;   // window-delay compensation
  const out = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const smp0 = base + floorDiv(i * sr * fps.den, fps.num);
    const smp1 = base + floorDiv((i + 1) * sr * fps.den, fps.num);
    const a = Math.max(floorDiv(smp0, HOP), 0);
    const b = Math.min(Math.max(ceilDiv(smp1, HOP), a + 1), nHops);
    let m = 0;
    if (b > a) { m = -Infinity; for (let k = a; k < b; k++) if (fine[k] > m) m = fine[k]; }
    out[i] = m;
  }
  return out;
}

// --------------------------------------------------------------- synthesis --------
function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
function normMax(E) { const m = maxOf(E); const o = new Float64Array(E.length); for (let i = 0; i < E.length; i++) o[i] = m > 0 ? E[i] / m : E[i]; return o; }

function strikeAndRing(E, decay) {
  const e = normMax(E), n = e.length;
  const A = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const onset = Math.max(0, e[i] - (i === 0 ? e[0] : e[i - 1]));
    acc = Math.max(onset, acc * decay);          // peak-hold, not additive
    A[i] = acc;
  }
  return normMax(A);
}

function softCeiling(x, knee) {
  const o = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    if (knee >= 1) o[i] = Math.min(1, x[i]);
    else o[i] = x[i] > knee ? knee + (1 - knee) * Math.tanh((x[i] - knee) / (1 - knee)) : x[i];
  }
  return o;
}

function adaptiveNormalise(A, windowS, knee, fpsF) {
  if (windowS == null) return softCeiling(normMax(A), knee);
  const n = A.length, w = Math.trunc(windowS * fpsF), g = maxOf(A);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity; const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    for (let k = lo; k < hi; k++) if (A[k] > m) m = A[k];
    m = Math.max(m, NORM_FLOOR * g);
    r[i] = A[i] / Math.max(m, 1e-12);
  }
  return softCeiling(r, knee);
}

// E -> per-frame curves, in reference px (frame 1920 high). Returns
// { amp, dy, rot, blur, peak } — rot in degrees. fps = {num, den}.
export function synth(E, P, fps = { num: 30, den: 1 }) {
  const n = E.length, fpsF = fps.num / fps.den;
  const { K, gamma, rate, t = 0, decay = null, normWindow = null, blurSustain = 0, knee = 1, blurK = 0.18 } = P;
  let e;
  if (decay != null) {
    const d = (fps.num === REF_FPS * fps.den) ? decay : Math.pow(decay, REF_FPS / fpsF);  // same decay per second
    e = strikeAndRing(E, d);
  } else e = normMax(E);
  e = adaptiveNormalise(e, normWindow, knee, fpsF);
  if (t > 0) for (let i = 0; i < n; i++) e[i] = Math.max(0, (e[i] - t) / (1 - t));
  const amp = new Float64Array(n);
  for (let i = 0; i < n; i++) amp[i] = K * Math.pow(e[i], gamma);

  // Cosine phase accumulator (NOT sine: at 15 Hz/30 fps a sine samples every zero crossing).
  // By TIME, capped at Nyquist (fps/2 = flip every frame).
  const dy = new Float64Array(n);
  let phase = 0; const dphase = 2 * Math.PI * wobbleHz(rate, fps) / fpsF;
  for (let i = 0; i < n; i++) { dy[i] = amp[i] * Math.cos(phase); phase += dphase; }
  dy[0] = 0; dy[n - 1] = 0;                         // must return home: no snap at the end

  const rot = new Float64Array(n), blur = new Float64Array(n);
  const lvl = normMax(E);
  for (let i = 0; i < n; i++) {
    rot[i] = ROT_PER_PX * dy[i];
    const d = Math.abs(dy[i] - (i === 0 ? dy[0] : dy[i - 1]));
    blur[i] = blurK * d;                             // (1) motion blur exaggeration
    if (blurSustain > 0) blur[i] = blur[i] + blurSustain * K * lvl[i];  // (2) sustain smear
  }
  blur[0] = 0; blur[n - 1] = 0;
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(dy[i]));
  return { amp, dy, rot, blur, peak };
}

// The oscillation frequency actually used: the requested Hz, capped at half the frame rate.
// At exactly 30 fps this returns `rate` unchanged for rate <= 15 (the reference's range).
export function wobbleHz(rate, fps = { num: 30, den: 1 }) {
  const nyq = fps.num / (2 * fps.den);
  return Math.min(rate, nyq);
}

// Motion blur on screen, per frame, in px (any unit, as long as all three agree):
// a SHUTTER trail back towards the previous frame's position (shutterDeg/360 of the move,
// physical: 180 deg = half a frame interval) plus a centred directional smear of length
// `smear` (the curve's blur: taste exaggeration + bass smear). Returns the range of offsets
// [lo, hi] relative to dy over which copies of the frame are averaged. The image's
// centroid sits at dy + (lo + hi) / 2 = dy + trail / 2.
export function blurRange(dyPrev, dy, smear, shutterDeg = 180) {
  const trail = (shutterDeg / 360) * (dyPrev - dy);
  return { lo: Math.min(0, trail) - smear / 2, hi: Math.max(0, trail) + smear / 2, trail };
}

// DERIVED overscan (Scale, %) for a W x H frame: the rotated + translated bounding box,
// max over frames, rounded UP to 0.1 %. pxScale converts reference px to output px.
export function overscanFor(dy, rot, W = REF_W, H = REF_H, pxScale = 1) {
  let need = 1;
  for (let i = 0; i < dy.length; i++) {
    const th = Math.abs(rot[i] * Math.PI / 180), c = Math.cos(th), s = Math.sin(th);
    const hh = H + 2 * Math.abs(dy[i] * pxScale);
    need = Math.max(need, (W * c + hh * s) / W, (W * s + hh * c) / H);
  }
  return Math.ceil(need * 1000) / 10;
}

// Snap a measured average frame rate to a standard rational one (within 0.5 %).
export function snapFps(f) {
  const std = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1], [120, 1]];
  let best = null, bd = Infinity;
  for (const [num, den] of std) { const d = Math.abs(f - num / den) / (num / den); if (d < bd) { bd = d; best = { num, den }; } }
  if (bd < 0.005) return best;
  return { num: Math.round(f * 1000), den: 1000 };
}

// ------------------------------------------------------------- display only -------
// A smooth average bass spectrum for the "Frequency response" plot. NOT used by the model.
// Welch average of up to `maxSegs` Hann windows of NFFT_DISPLAY samples (~0.7 s at 48 kHz,
// ~1.5 Hz bins), spread evenly over the clip; then smoothed with a Gaussian of `smoothOct`
// octaves (s.d.) on a log-frequency axis and sampled every 1/24 octave from fLo to fHi.
// Returns [[f, power], ...] (power in arbitrary units; callers normalise).
export const NFFT_DISPLAY = 32768;
export function displaySpectrum(x, sr, { fLo = 25, fHi = 200, maxSegs = 48, smoothOct = 1 / 12 } = {}) {
  const N = NFFT_DISPLAY;
  if (x.length < N) return null;
  const fft = makeFFT(N), win = hann(N);
  const kHi = Math.min(N / 2, Math.ceil(fHi * 2 * N / sr));
  const psd = new Float64Array(kHi);
  const nSeg = Math.min(maxSegs, 1 + Math.floor((x.length - N) / (N / 2)));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s < nSeg; s++) {
    const o = nSeg === 1 ? 0 : Math.round(s * (x.length - N) / (nSeg - 1));
    for (let n = 0; n < N; n++) { re[n] = x[o + n] * win[n]; im[n] = 0; }
    fft(re, im);
    for (let k = 0; k < kHi; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  const out = [];
  for (let lf = Math.log2(fLo); lf <= Math.log2(fHi) + 1e-9; lf += 1 / 24) {
    let s = 0, wsum = 0;
    for (let k = 1; k < kHi; k++) {
      const d = (Math.log2(k * sr / N) - lf) / smoothOct;
      if (d < -3 || d > 3) continue;
      const w = Math.exp(-0.5 * d * d); s += w * psd[k]; wsum += w;
    }
    out.push([Math.pow(2, lf), wsum > 0 ? s / wsum / nSeg : 0]);
  }
  return out;
}

// ------------------------------------------------------------- bass presence ------
// The shake is scaled to the clip's OWN loudest bass, so a clip with almost no bass would still
// shake fully (BASSAPP-004). bassShare = power in 25-150 Hz (from the analysis spectrum) as a
// fraction of the clip's total power (time domain, all frequencies). Independent of recording level.
// Expected (BASSAPP-004 research, mostly modelled): club 40-65 %, pop/rock 25-40 %, acoustic 8-15 %,
// speech 3-20 %, pink noise ~26 %; real mixes and clips measured 48-87 %.
export const BASS_FULL = 0.25, BASS_NONE = 0.05;
export function bassShare(an, x) {
  const { spec, nb, nHops, klo, sr } = an;
  if (!nHops) return 0;
  let bass = 0;
  for (let h = 0; h < nHops; h++) for (let b = 0; b < nb; b++) { const f = (klo + b) * sr / NFFT; if (f >= 25 && f <= 150) bass += spec[h * nb + b]; }
  let w2 = 0; for (let n = 0; n < NFFT; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (NFFT - 1)); w2 += w * w; }
  const bassPow = 2 * bass / (nHops * NFFT * w2);          // one-sided periodogram -> mean square per sample
  let tot = 0; for (let i = 0; i < x.length; i++) tot += x[i] * x[i];
  const totPow = tot / Math.max(1, x.length);
  return totPow > 0 ? Math.min(1, bassPow / totPow) : 0;
}
// Shake gain from bass share: 0 at <= 5 %, 1 at >= 25 %, smooth (smoothstep on a log scale) between.
export function bassGain(share) {
  if (!(share > BASS_NONE)) return 0;
  if (share >= BASS_FULL) return 1;
  const u = Math.log(share / BASS_NONE) / Math.log(BASS_FULL / BASS_NONE);
  return u * u * (3 - 2 * u);
}
