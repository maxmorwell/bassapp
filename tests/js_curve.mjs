// Golden-test helper: run the app's model (js/shake.js) on raw audio and print the curves.
// Called by tests/golden.py — not meant to be run by hand.
//   node tests/js_curve.mjs <job.json>
// job: { pcm: "<path to float64 little-endian mono>", sr, nFrames, fps: {num, den},
//        offset, cases: [ {p, fMin, K, gamma, rate, t, decay, normWindow, blurSustain, knee, blurK} ] }
import { readFileSync } from "node:fs";
import { analyseAudio, energyPerFrame, synth, overscanFor } from "../js/shake.js";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const buf = readFileSync(job.pcm);
const x = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
const an = await analyseAudio(x, job.sr, { yieldEvery: 1e9 });
const out = [];
for (const c of job.cases) {
  const E = energyPerFrame(an, job.nFrames, job.fps, job.offset, c.p, c.fMin);
  const s = synth(E, c, job.fps);
  out.push({ E: Array.from(E), amp: Array.from(s.amp), dy: Array.from(s.dy), rot: Array.from(s.rot),
             blur: Array.from(s.blur), peak: s.peak, overscan: overscanFor(s.dy, s.rot) });
}
process.stdout.write(JSON.stringify(out));
