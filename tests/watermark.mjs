// node tests/watermark.mjs — checks the watermark plan (js/watermark.js) on synthetic envelopes.
import { planWatermark, placeText, spotsFor, SPOTS_VERTICAL, WM_EVERY, WM_MIN_TAIL, chooseSpots, boxFor, letterbox } from "../js/watermark.js";

let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };

function env(dur, fps, hits) {           // decaying hits at the given times (s) on a low bed
  const n = Math.round(dur * fps), a = new Float64Array(n).fill(2);
  for (const t of hits) { const i0 = Math.round(t * fps); for (let i = i0; i < n; i++) a[i] = Math.max(a[i], 30 * Math.exp(-(i - i0) / (0.15 * fps))); }
  return a;
}

for (const fps of [30, 25, 60]) {
  console.log(`== ${fps} fps`);
  // 1. no hits: moves on the timer, every 6.5 s
  { const p = planWatermark(new Float64Array(60 * fps).fill(5), fps);
    const gaps = p.moves.map((m, k) => (m.frame - (k ? p.moves[k - 1].frame : 0)) / fps);
    const mid = (WM_EVERY[0] + WM_EVERY[1]) / 2;
    check(p.moves.length >= 4 && gaps.every(g => Math.abs(g - mid) < 0.05) && p.moves.every(m => !m.onHit), `steady clip: ${p.moves.length} timed moves, gaps ${gaps.map(g => g.toFixed(2)).join(",")}`); }
  // 2. hits every 0.5 s (kick): every move on a hit, gaps within 5-8 s
  { const hits = []; for (let t = 0.25; t < 60; t += 0.5) hits.push(t);
    const a = env(60, fps, hits), p = planWatermark(a, fps);
    const gaps = p.moves.map((m, k) => (m.frame - (k ? p.moves[k - 1].frame : 0)) / fps);
    const onHit = p.moves.every(m => hits.some(t => Math.abs(m.frame - Math.round(t * fps)) <= 0));
    check(p.moves.every(m => m.onHit) && onHit, `kick clip: all ${p.moves.length} moves land on a hit frame`);
    check(gaps.every(g => g >= WM_EVERY[0] - 1e-9 && g <= WM_EVERY[1] + 1e-9), `kick clip: gaps ${Math.min(...gaps).toFixed(2)}-${Math.max(...gaps).toFixed(2)} s within ${WM_EVERY}`); }
  // 3. a hit that is too weak (5 % of the big ones) is ignored
  { const a = env(30, fps, [0.5, 1, 1.5, 2, 2.5]); const i0 = Math.round(9.7 * fps); a[i0] = 3.5;
    const p = planWatermark(a, fps);
    check(!p.moves[0].onHit, `weak bump ignored (first move ${(p.moves[0].frame / fps).toFixed(2)} s, timed)`); }
  // 4. alpha: 1 most of the time, 0 just before each move, back up after; never jumps by > 0.6 per frame
  { const hits = []; for (let t = 0.25; t < 40; t += 0.5) hits.push(t);
    const p = planWatermark(env(40, fps, hits), fps);
    const full = p.alpha.filter(v => v > 0.999).length / p.alpha.length;
    let maxStep = 0; for (let i = 1; i < p.alpha.length; i++) if (p.seg[i] === p.seg[i - 1]) maxStep = Math.max(maxStep, Math.abs(p.alpha[i] - p.alpha[i - 1]));
    const zeroBefore = p.moves.every(m => p.alpha[m.frame - 1] < 0.02);
    const backAfter = p.moves.every(m => p.alpha[Math.min(p.alpha.length - 1, m.frame + Math.ceil(0.25 * fps))] > 0.99);
    const switchHidden = p.moves.every(m => p.seg[m.frame] !== p.seg[m.frame - 1] && p.alpha[m.frame - 1] < 0.02);
    check(full > 0.9, `visible at full strength ${(100 * full).toFixed(1)} % of frames`);
    check(zeroBefore && backAfter && switchHidden, "hidden on the frame before each move; spot changes only while hidden; back to full within 0.25 s");
    check(maxStep < 0.75, `fade steps per frame <= ${maxStep.toFixed(2)} (plain fade, no pop)`);
    check(p.moves.every((m, k) => p.seg[m.frame] === k + 1), "each move starts the next segment");
    check(p.alpha[0] === 1, "visible from the very first frame");
    const lastMove = p.moves[p.moves.length - 1].frame / fps;
    check(40 - lastMove >= WM_MIN_TAIL, `no move in the last ${WM_MIN_TAIL} s (last at ${lastMove.toFixed(1)} s)`); }
}
// 5. short clip (4 s): never moves
{ const p = planWatermark(new Float64Array(120).fill(5), 30); check(p.moves.length === 0 && p.alpha.every(v => v === 1), "4 s clip: no moves, always visible"); }
// 6. silent clip (all zero): timed moves, no NaN
{ const p = planWatermark(new Float64Array(900), 30); check(p.moves.length > 0 && p.alpha.every(Number.isFinite), `silent clip: ${p.moves.length} timed moves, alpha finite`); }
// 7. placement: inside the frame, inside the vertical safe zone, never in a corner
for (const [w, h] of [[1080, 1920], [720, 1280], [1920, 1080], [1080, 1080], [1178, 1476]]) {
  const fs = 0.035 * Math.min(w, h), tw = 7.4 * fs;           // ~width of "@bass_shake_app" in Plex Sans 500
  const at = spotsFor(w, h).map(s => placeText(s, tw, fs, w, h));
  const inFrame = at.every(p => p.x >= 0 && p.x + tw <= w && p.y - fs >= 0 && p.y <= h);
  const vertical = h >= 1.15 * w;
  const safe = !vertical || at.every(p => p.x >= 0.05 * w && p.x + tw <= 0.85 * w && p.y - fs >= 0.13 * h && p.y <= 0.67 * h);
  const middle = at.some(p => p.x > 0.2 * w && p.x + tw < 0.8 * w && p.y > 0.3 * h && p.y < 0.6 * h);
  check(inFrame && safe && !middle, `${w}x${h}: ${at.length} spots in frame${vertical ? ", in the 9:16 safe zone" : ""}, none in the middle`);
}
// 8. choosing spots on synthetic frames (144 x 256 grey thumbs, portrait)
{
  const W = 144, H = 256, cands = SPOTS_VERTICAL, tw = 0.30, ff = 0.035 * 1080 / 1920, asp = H / W;
  const mk = (f) => { const g = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y); return g; };
  const rnd = (x, y) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
  const inBox = (b, x, y) => x >= b[0] * W && x <= b[2] * W && y >= b[1] * H && y <= b[3] * H;
  const boxes = cands.map(s => boxFor(s, tw, ff, asp));
  // (a) mid-grey busy texture everywhere, except one calm dark patch around candidate 7 -> pick 7
  { const b = boxes[7], g = mk((x, y) => inBox(b, x, y) ? 40 : 60 + 120 * rnd(x, y));
    const th = [0.5, 1.5, 2.5].map(t => ({ t, g, w: W, h: H }));
    const r = chooseSpots(cands, [[0, 3]], th, tw, ff, asp);
    check(r.spots[0] === 7, `calm dark patch chosen (got ${r.spots[0]}, want 7)`); }
  // (b) calm everywhere, but a caption (stripes of text-like edges) over candidate 7's area -> avoid it, and a bright half -> avoid
  { const b = boxes[7], g = mk((x, y) => inBox(b, x, y) ? ((x >> 1) % 2 ? 250 : 20) : (x > W / 2 ? 235 : 70));
    const th = [{ t: 0.5, g, w: W, h: H }];
    const r = chooseSpots(cands, [[0, 1]], th, tw, ff, asp);
    const bx = boxes[r.spots[0]];
    check(r.spots[0] !== 7 && bx[2] * W <= W / 2 + 4, `caption and bright side avoided (got spot ${r.spots[0]}, box x ${(bx[0] * 100).toFixed(0)}-${(bx[2] * 100).toFixed(0)} %)`); }
  // (c) letterbox: flat black top and bottom 22 %, picture between -> every chosen box inside the picture
  { const g = mk((x, y) => (y < 0.22 * H || y > 0.78 * H) ? 0 : 80 + 100 * rnd(x, y));
    const th = Array.from({ length: 30 }, (_, i) => ({ t: i + 0.5, g, w: W, h: H }));
    const lb = letterbox(th);
    const segs = Array.from({ length: 5 }, (_, k) => [6 * k, 6 * k + 6]);
    const r = chooseSpots(cands, segs, th, tw, ff, asp);
    const inside = r.spots.every(s => boxes[s][1] >= lb.top && boxes[s][3] <= lb.bottom);
    check(Math.abs(lb.top - 0.22) < 0.01 && Math.abs(lb.bottom - 0.78) < 0.01 && inside, `letterbox found (${(100 * lb.top).toFixed(0)}-${(100 * lb.bottom).toFixed(0)} %), all ${r.spots.length} spots inside the picture`); }
  // (d) uniform calm frames: the spot still moves every segment, never overlapping the previous one
  { const g = mk(() => 60), th = Array.from({ length: 40 }, (_, i) => ({ t: i + 0.5, g, w: W, h: H }));
    const segs = Array.from({ length: 6 }, (_, k) => [6.5 * k, 6.5 * k + 6.5]);
    const r = chooseSpots(cands, segs, th, tw, ff, asp);
    const ov = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    check(r.spots.every((s, k) => !k || (s !== r.spots[k - 1] && !ov(boxes[s], boxes[r.spots[k - 1]]))), `calm clip: moves every segment, no overlap (${r.spots.join(",")})`);
    check(r.spots.every((s, k) => k < 2 || s !== r.spots[k - 2]), "no ping-pong between two spots"); }
  // (e) no thumbs (spot finder failed): still moves, no overlaps
  { const segs = Array.from({ length: 8 }, (_, k) => [k, k + 1]);
    const r = chooseSpots(cands, segs, [], tw, ff, asp);
    const ov = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    check(r.spots.every((s, k) => s >= 0 && (!k || !ov(boxes[s], boxes[r.spots[k - 1]]))), `no thumbs: fallback spots move without overlap (${r.spots.join(",")})`); }
}
console.log(fails ? `\nRESULT: FAIL (${fails})` : "\nRESULT: PASS");
process.exit(fails ? 1 : 0);
