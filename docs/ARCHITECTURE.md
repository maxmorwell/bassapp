# Architecture and tests

Technical notes for whoever works on the code next. Project decisions live outside the repo.

## What runs where

Everything runs in the visitor's browser; nothing is uploaded. No build step: the page is
plain HTML + ES modules, served as-is by GitHub Pages.

| File | Role |
|---|---|
| `index.html` | The page. A small classic script sets up the report log first, so even a failed module load is reported. |
| `css/app.css` | Styles. Dark "club" look: treated bass-cone photo (`img/bg-cone.jpg`, Pexels, free licence), amber accent, fade column. |
| `js/app.js` | UI and media: load clip → decode its audio → analyse → curve → render (preview / export) → save; feedback box. |
| `js/controls.js` | What the sliders SHOW vs the model values: 0–100 % / real-unit mappings, marks, presets as chips. Pure, tested by `tests/controls.mjs`. |
| `js/shake.js` | **The model.** Pure maths, no DOM. Golden-tested against the reference generator. |
| `vendor/mediabunny-1.61.3.min.mjs` | Video/audio demux, decode, encode, mux (MPL-2.0, licence alongside). Hosted here, not from a CDN — the CDN load took ~11 s on a phone. |

## The pipeline

1. **Probe** (`Input`): size, rotation, frame rate (average packet rate, snapped to a standard
   rational rate within 0.5 %), first video timestamp `v0`, duration.
2. **Decode audio** (`AudioSampleSink`) to mono Float32. `offsetSec = v0 − first audio timestamp`.
3. **Analyse** (`analyseAudio`): STFT, NFFT 8192 / hop 256, symmetric Hann, power spectrum, kept
   only for bins in 10–500 Hz. Done once per file; the expensive step.
4. **Curve** (`energyPerFrame` + `synth`): cheap, recomputed on every slider move. Energy per
   frame is cached per (p, f_min). Output in *reference px* (frame 1920 high).
5. **Render** (`render()` in app.js): ONE path for preview and export. Every frame is looked up in
   the whole-clip curve by its source time, so the preview cannot differ from the export.
   - px scale: reference px × (long side / 1920).
   - Zoom (overscan): derived from the curve for the actual output size (`overscanFor`).
   - Blur: averaged copies of the frame (≤ 12) spread over a directional smear (the curve's
     `blur`, centred) plus a shutter trail back towards the previous frame's position:
     `shutter/360` of the move (`blurRange` in shake.js; 180° = half). The image's centroid
     therefore sits at `dy + trail/2` — the e2e pixel check compares against that.
   - Output size by the SHORTER side: 720p / 1080p (default) / Original; never upscales.
   - Trimmed renders (preview) restart timestamps at 0 and clamp the first frame to 0; the
     preview starts mid-frame and the first frame's true time is read from the file
     (`EncodedPacketSink.getPacket`).
6. **Save**: Web Share with the file (iPhone: "Save Video" → Photos) when available, plus a plain
   download.

## Frame rates

The reference generator is 30 fps only. Here: anything in seconds follows time; the ring-down
is rescaled to the same decay per second; the oscillation (Wobble: Fast 15 / Slow 7.5 Hz) follows time too, capped at half the frame rate (= flip every frame; at
25 fps Fast is 12.5 Hz). At exactly 30 fps all of these are the identity — that is what the
golden test's per-frame identity checks.

## Bass presence

The model scales the shake to the clip's own loudest bass, so a clip with almost no bass would still
shake fully. `bassShare` (shake.js) = power in 25–150 Hz / total power (level-independent);
`bassGain` = 0 at ≤ 5 %, 1 at ≥ 25 %, smoothstep on a log scale between. Also an absolute level
check: `bassPeakDb` = 25–150 Hz power reached in the loudest 0.3 s (dB re full scale; full-scale
sine = −3), `levelGain` = 0 at ≤ −55 dB, 1 at ≥ −42 dB (to calibrate on a phone filming a home
stereo). The page multiplies Strength (K) by the lower of the two gains. The plot shows it: the shake and blur rows keep their UNREDUCED scale (`curve.fullPeak`, `curve.fullBlurMax`, from a second ungated `synth`), so they shrink by the gain; a message sits on the plot ("There is not much bass in this clip" when gain < 0.995, "There is pretty much no bass in this clip" at 0) and in the canvas aria-label. Nothing under the clip. Music measured 48–87 %; no-bass test clip 0.1 %.
e2e.py multiplies K by the page's gain before comparing with the reference.

## Controls (controls.js)

Display only; the model keeps real values. Main: Strength 0–100 % → K = 100·s^1.5 ref px;
Wobble (stepped); Motion blur 0–40 % = shutter 0–180°, 40–100 % = extra blur
blurK = 1.0·x^1.5; Bass smear → blurSustain = 1.2·s^1.5. Advanced: Ring-down in ms (time for
an isolated hit's shake to fall to 1/10 at gamma 0.5; exact to within a frame for ≥ 100 ms);
Frequency response (was Respond to) 0–100 % → p from 20 to 0.7 on a log scale (~30 to ~110 Hz in a typical mix); a mini plot shows the clip's own bass spectrum and the weighted part (Hz = 90th percentile of the weighted
bass energy in four real mixes); Threshold → t; Dynamics → gamma, 0.5 in the middle
(0.25…1.5, log steps); Context → normWindow s. Low cut is fixed
at 25 Hz and the soft ceiling (knee) at 0.5 — neither in the UI (Soften peaks removed: almost no effect). A preset sets real values exactly; sliders snap to the nearest step.

## Tests

```
python3 tests/golden.py            # model vs reference generator (needs tests/reference/, see its README)
python3 tests/golden.py --quick    # 48 kHz synthetic signals only (~1 min)
node tests/controls.mjs            # every control's mapping and its effect on the curve (~3 s)
python3 tests/make_synth.py        # synthetic e2e clips (+ nobass.webm) + tex.pgm into /tmp/bassapp-clips
python3 tests/e2e.py clip.webm ... # the page in headless Chromium (Playwright); --set id=value, --size 720p
python3 tests/pixel_controls.py    # e2e under different settings; controls checked on rendered pixels (~6 min)
```

**controls.mjs**: slider↔model round trips, monotonic "more effect to the right", presets,
then each control on synthetic sounds with known answers: Strength scales shake and blur
together; Wobble frequency exact at 25/29.97/30/60 fps; Motion blur span rises, sharp at 0;
Bass smear only during held bass; Ring-down ms measured on isolated hits; Frequency response shifts
weight from 35 Hz to 90 Hz; Threshold drops soft hits; Dynamics, Context.

**pixel_controls.py**: Strength, Motion blur (0/40/100 %), Bass smear, Slow at 60 fps,
Fast at 25 fps and 720p output, measured on the output pixels of the synthetic clips.

**golden.py**: synthetic signals (kicks at 160 BPM, descending 808 glides, tone bursts with a
loud middle, a mix with hats and an 800 Hz melody, near-silence) at 48 and 44.1 kHz, × the 7
presets + 6 edge settings. 30 fps: per-frame identity (E 1e-9 relative, dy/rot/blur 1e-6 px,
overscan exact). Other rates: envelope correlation against the 30 fps reference, by time.
`--audio` adds real audio; `--shipped` checks the curves of presets that were shipped and
approved by eye. A deliberately broken window function fails all checks (mutation-tested).

**e2e.py**: needs VP9/Opus WebM copies (the container's Chromium has no H.264/HEVC/AAC; the
real H.264 path is only proven on device). Per clip: the page's curve vs the reference run on
ffmpeg's decode of the same audio (alignment, lag must be 0); preview and export render; frame
count and audio kept; preview frames == export frames at the same times; and for `synth*`
clips (a still texture), the shake measured on the output pixels vs the curve.

Make test clips with e.g.
`ffmpeg -i in.mov -c:v libvpx-vp9 -b:v 3M -deadline realtime -cpu-used 8 -c:a libopus out.webm`.
