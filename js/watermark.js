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

// Spots: [x, y, align] in fractions of the frame; y = text baseline. Order alternates sides and
// heights so consecutive spots are far apart. No corners.
// Vertical (9:16-ish): inside the usual Reels / TikTok / Shorts safe zone, roughly
// x 6-84 %, y 14-66 % (top ~14 % header, bottom ~1/3 captions + buttons, right ~15 % buttons).
export const SPOTS_VERTICAL = [
  [0.07, 0.24, "left"], [0.45, 0.64, "center"], [0.83, 0.38, "right"], [0.07, 0.54, "left"], [0.45, 0.17, "center"],
];
// Landscape / square: posted letterboxed or cropped; keep a plain margin, still no corners.
export const SPOTS_WIDE = [
  [0.06, 0.24, "left"], [0.5, 0.86, "center"], [0.94, 0.38, "right"], [0.06, 0.72, "left"], [0.5, 0.15, "center"],
];
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

// The plan: move frames, and per frame { spot index, alpha 0..1 }.
// amp: the shake envelope per frame (curve.amp); fpsF: frames per second.
export function planWatermark(amp, fpsF, nSpots = SPOTS_VERTICAL.length) {
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
  const spot = new Uint8Array(n), alpha = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < moves.length && i >= moves[k].frame) k++;
    spot[i] = k % nSpots;
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
  return { moves, spot, alpha, thr };
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
// Draw the handle: white, soft dark shadow, no box. Shared by the renderer and the contact sheet.
export function drawWatermark(ctx, font, fontPx, x, y, alpha) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.font = font; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 0.18 * fontPx; ctx.shadowOffsetY = 0.05 * fontPx;
  ctx.fillStyle = "#fff"; ctx.fillText(WM_TEXT, x, y);
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.globalAlpha = 1;
}
