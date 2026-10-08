// watermark.js — the free-tier watermark (TEST BUILD: behind a switch, not yet tied to tiers).
// Pure: no DOM. Plans WHERE and HOW VISIBLE the handle is on every frame of the whole clip,
// so the preview (a trimmed render) and the export look up the same plan and cannot differ.
//
// Agreed design (BASSAPP-006):
//  - creator-style text only ("@bass_shake_app"), no logo / glyph, no backing box;
//  - changes place now and then (~5-8 s), never in corners, always inside the 9:16 social
//    safe zone (platform header at the top, captions at the bottom, buttons on the right);
//  - moves with a short, plain fade (no effect), landing on a bass hit when one is close;
//  - shakes a little with the picture (a fraction of the picture's movement).

export const WM_TEXT = "@bass_shake_app";
export const WM_DEFAULTS = { on: true, size: 3.5, opacity: 70, shake: 25 };   // size: % of the SHORT side
export const WM_EVERY = [5, 8];          // seconds between moves (target = middle)
export const WM_FADE_OUT = 0.25, WM_GAP = 0.05, WM_FADE_IN = 0.2;   // seconds
export const WM_MIN_TAIL = 2;            // don't move if less than this is left of the clip

// Candidate spots: [x, y, align] in fractions of the frame; y = text baseline. None in corners.
// Portrait: inside the usual Reels / TikTok / Shorts safe zone, roughly x 6-84 %, y 14-66 %
// (top ~14 % header, bottom ~1/3 captions + buttons, right ~15 % buttons).
// Landscape / square: a plain margin; the four corner positions are left out.
const grid = (xs, ys, skip = () => false) => ys.flatMap(y => xs.filter(([x, a]) => !skip(x, y)).map(([x, a]) => [x, y, a]));
export const SPOTS_VERTICAL = grid([[0.07, "left"], [0.45, "center"], [0.83, "right"]], [0.20, 0.31, 0.42, 0.53, 0.64]);
export const SPOTS_WIDE = grid([[0.06, "left"], [0.5, "center"], [0.94, "right"]], [0.15, 0.32, 0.5, 0.68, 0.86],
  (x, y) => x !== 0.5 && (y === 0.15 || y === 0.86));
// Portrait clips (9:16, 3:4, 4:5 ...) use the vertical safe zone: conservative for 4:5 / 3:4, which
// the Reels viewer shows smaller than full screen, so the overlays cover less of them.
export const spotsFor = (w, h) => (h >= 1.15 * w ? SPOTS_VERTICAL : SPOTS_WIDE);

const smooth = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// Frames where the shake jumps up (a bass hit as SEEN in the picture): rise of the envelope.
export function hitStrength(amp) {
  const n = amp.length, on = new Float64Array(n);
  for (let i = 2; i < n; i++) on[i] = Math.max(0, amp[i] - Math.max(amp[i - 1], amp[i - 2]));
  return on;
}

// The plan: move frames, and per frame { segment index, alpha 0..1 }. Segment k runs from move k-1
// (or the start) to move k; WHICH spot each segment uses is chosen separately (chooseSpots).
// amp: the shake envelope per frame (curve.amp); fpsF: frames per second.
export function planWatermark(amp, fpsF) {
  const n = amp.length, on = hitStrength(amp);
  // A "hit" must be a real jump: at least 35 % of the clip's typical big jump (95th percentile).
  const pos = Array.from(on).filter(v => v > 0).sort((a, b) => a - b);
  const thr = pos.length ? 0.35 * pos[Math.min(pos.length - 1, Math.floor(0.95 * pos.length))] : Infinity;
  const moves = [];                       // { frame, onHit }
  let last = 0;
  for (;;) {
    const a = Math.round(last + WM_EVERY[0] * fpsF), b = Math.round(last + WM_EVERY[1] * fpsF);
    const target = Math.round(last + (WM_EVERY[0] + WM_EVERY[1]) / 2 * fpsF);
    if (target > n - 1 - WM_MIN_TAIL * fpsF) break;
    // "When convenient": the qualifying hit NEAREST the target time (stronger wins a tie).
    let best = -1, bd = Infinity;
    for (let i = a; i <= Math.min(b, n - 1 - Math.round(WM_MIN_TAIL * fpsF)); i++) {
      if (on[i] < thr) continue;
      const d = Math.abs(i - target) - 1e-6 * on[i];
      if (d < bd) { bd = d; best = i; }
    }
    const f = best >= 0 ? best : target;
    moves.push({ frame: f, onHit: best >= 0 });
    last = f;
  }
  const seg = new Uint8Array(n), alpha = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < moves.length && i >= moves[k].frame) k++;
    seg[i] = k;
    const t = i / fpsF;
    let al = 1;
    if (k < moves.length) {                                   // fading out before the next move
      const tm = moves[k].frame / fpsF;
      al = Math.min(al, smooth((tm - WM_GAP - t) / WM_FADE_OUT));
    }
    if (k > 0) {                                              // fading in after the last move
      const tm = moves[k - 1].frame / fpsF;
      al = Math.min(al, smooth((t - tm) / WM_FADE_IN + 1 / (WM_FADE_IN * fpsF)));   // the move frame itself is partly visible
    }
    alpha[i] = al;
  }
  return { moves, seg, alpha, thr };
}

// Where to draw the text on a w x h output: left x of the text and baseline y, kept inside the frame.
export function placeText(spotXYA, textW, fontPx, w, h) {
  const [fx, fy, align] = spotXYA;
  let x = align === "left" ? fx * w : align === "right" ? fx * w - textW : fx * w - textW / 2;
  x = Math.min(w - textW - 0.02 * w, Math.max(0.02 * w, x));
  const y = Math.min(h - 0.4 * fontPx, Math.max(fontPx, fy * h));
  return { x, y };
}

// The font for a w x h output at `size` % of the short side.
export function wmFont(size, w, h) {
  const fontPx = Math.max(10, size / 100 * Math.min(w, h));
  return { fontPx, font: "500 " + fontPx.toFixed(1) + 'px "BS Watermark", "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif' };
}
// Draw the handle: white with a thin black outline and soft shadow, no box.
export const WM_OUTLINE = 0.14;   // stroke width / font px (half of it shows outside the letters) Shared by the renderer and the contact sheet.
export function drawWatermark(ctx, font, fontPx, x, y, alpha) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.font = font; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  // Black outline (Manager: "helps everywhere") with a soft shadow under it, then the white fill.
  ctx.lineJoin = "round"; ctx.miterLimit = 2; ctx.lineWidth = WM_OUTLINE * fontPx; ctx.strokeStyle = "#000";
  ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 0.18 * fontPx; ctx.shadowOffsetY = 0.04 * fontPx;
  ctx.strokeText(WM_TEXT, x, y);
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.fillStyle = "#fff"; ctx.fillText(WM_TEXT, x, y);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ choosing good spots ----------
// Thumbs: small grey frames sampled through the clip, [{ t (s), g: Uint8Array, w, h }].
// For each candidate box (padded, so it keeps clear of nearby text): cost = clutter (mean |gradient|: busy picture or existing text/graphics)
// + brightness penalty (white text on bright ground). Boxes touching letterbox bars (rows/columns
// that are flat black in nearly every thumb) are excluded: the picture is elsewhere, and bars are
// easy to crop off.
export const WM_COST = { brightFrom: 110, brightW: 0.35, pad: 0.6, recent: 3 };

// Text box in fractions of the frame for a spot: [x0, y0, x1, y1], padded.
export function boxFor(spot, textWFrac, fontFrac, aspect /* h/w */) {
  // fontFrac: font px / frame height; textWFrac: text width / frame width
  const fy = fontFrac, fx = fontFrac / (1 / aspect);       // font size as a fraction of the WIDTH
  const p = placeText(spot, textWFrac, fy, 1, 1);           // in fractions (w = h = 1)
  const padX = WM_COST.pad * fx, padY = WM_COST.pad * fy;
  return [p.x - padX, p.y - 1.0 * fy - padY, p.x + textWFrac + padX, p.y + 0.3 * fy + padY];
}

export function letterbox(thumbs) {
  if (!thumbs.length) return { top: 0, bottom: 1, left: 0, right: 1 };
  const { w, h } = thumbs[0];
  // A bar row/column is mostly near-black — "mostly", so a caption printed IN the bar still counts.
  const flatRow = (g, y) => { let d = 0; for (let x = 0; x < w; x++) if (g[y * w + x] < 28) d++; return d >= 0.6 * w; };
  const flatCol = (g, x) => { let d = 0; for (let y = 0; y < h; y++) if (g[y * w + x] < 28) d++; return d >= 0.6 * h; };
  const always = (f, k) => thumbs.filter(th => f(th.g, k)).length >= 0.9 * thumbs.length;
  // Walk in from an edge; the bar ends at the last bar line before a run of picture lines longer
  // than 4 % of the frame (a caption inside the bar is a SHORT run, so it stays part of the bar).
  const extent = (f, from, to, step, size) => {
    let last = from - step, gap = 0;
    for (let k = from; k !== to; k += step) {
      if (always(f, k)) { last = k; gap = 0; } else if (++gap > 0.04 * size) break;
    }
    return last;
  };
  const top = extent(flatRow, 0, Math.floor(h / 2), 1, h) + 1, bot = extent(flatRow, h - 1, Math.floor(h / 2), -1, h);
  const left = extent(flatCol, 0, Math.floor(w / 2), 1, w) + 1, right = extent(flatCol, w - 1, Math.floor(w / 2), -1, w);
  return { top: top / h, bottom: bot / h, left: left / w, right: right / w };
}

export function boxCost(th, box) {
  const { g, w, h } = th;
  const x0 = Math.max(1, Math.floor(box[0] * w)), x1 = Math.min(w - 1, Math.ceil(box[2] * w));
  const y0 = Math.max(1, Math.floor(box[1] * h)), y1 = Math.min(h - 1, Math.ceil(box[3] * h));
  let s = 0, gs = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = g[y * w + x]; s += v; n++;
    gs += Math.abs(v - g[y * w + x - 1]) + Math.abs(v - g[(y - 1) * w + x]);
  }
  if (!n) return Infinity;
  const mean = s / n, clutter = gs / n;
  return clutter + WM_COST.brightW * Math.max(0, mean - WM_COST.brightFrom);
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// One spot per segment. segTimes: [[t0, t1], ...] (s). Returns { spots: [index per segment], costs, lb }.
// Rule: a new spot never overlaps the previous one (it always visibly moves); among the rest, the
// lowest cost over the thumbs in that segment (mean + half the worst, so a caption that appears
// half-way still counts). Without thumbs: a fixed order that alternates sides.
export function chooseSpots(candidates, segTimes, thumbs, textWFrac, fontFrac, aspect) {
  const boxes = candidates.map(s => boxFor(s, textWFrac, fontFrac, aspect));
  const lb = letterbox(thumbs);
  const inPicture = b => b[1] >= lb.top - 1e-9 && b[3] <= lb.bottom + 1e-9 && b[0] >= lb.left - 1e-9 && b[2] <= lb.right + 1e-9;
  const spots = [], costs = [];
  let prev = -1;
  segTimes.forEach(([t0, t1], k) => {
    let ths = thumbs.filter(th => th.t >= t0 && th.t <= t1);
    if (!ths.length && thumbs.length) ths = [thumbs.reduce((a, b) => Math.abs(b.t - (t0 + t1) / 2) < Math.abs(a.t - (t0 + t1) / 2) ? b : a)];
    let best = -1, bc = Infinity;
    candidates.forEach((s, i) => {
      if (prev >= 0 && (i === prev || overlaps(boxes[i], boxes[prev]))) return;
      let c;
      if (!ths.length) c = (i * 7 + k * 5) % candidates.length;            // no thumbs: deterministic spread
      else {
        if (!inPicture(boxes[i])) return;
        const cs = ths.map(th => boxCost(th, boxes[i]));
        const m = cs.reduce((a, b) => a + b, 0) / cs.length;
        c = m + 0.5 * (Math.max(...cs) - m);
        if (spots.slice(-3).includes(i)) c += WM_COST.recent;   // variety: don't ping-pong between two spots
      }
      if (c < bc) { bc = c; best = i; }
    });
    if (best < 0) best = candidates.findIndex((s, i) => i !== prev);       // everything excluded: any other spot
    spots.push(best); costs.push(bc); prev = best;
  });
  return { spots, costs, lb, boxes };
}
