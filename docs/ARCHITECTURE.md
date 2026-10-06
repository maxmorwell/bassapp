# Architecture and tests

Technical notes for whoever works on the code next. Project decisions live outside the repo.

## What runs where

Everything runs in the visitor's browser; nothing is uploaded. No build step: the page is
plain HTML + ES modules, served as-is by GitHub Pages.

| File | Role |
|---|---|
| `index.html` | The page. A small classic script sets up the report log first, so even a failed module load is reported. |
| `css/app.css` | Styles. Light/dark via tokens. |
| `js/app.js` | UI and media: load clip → decode its audio → analyse → curve → render (preview / export) → save. |
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
   - Blur: averaged copies of the frame (≤ 10) spread over a directional smear (the curve's
     `blur`, centred) plus a shutter trail half-way back to the previous frame's position
     (shutter angle 180°). The image's centroid therefore sits at `dy + trail/2` — the e2e
     pixel check compares against that.
   - Trimmed renders (preview) restart timestamps at 0 and clamp the first frame to 0; the
     preview starts mid-frame and the first frame's true time is read from the file
     (`EncodedPacketSink.getPacket`).
6. **Save**: Web Share with the file (iPhone: "Save Video" → Photos) when available, plus a plain
   download.

## Frame rates

The reference generator is 30 fps only. Here: anything in seconds follows time; the ring-down
is rescaled to the same decay per second; the oscillation stays frame-locked (15 Hz at 30 fps =
flip every frame). At exactly 30 fps all of these are the identity — that is what the golden
test's per-frame identity checks.

## Tests

```
python3 tests/golden.py            # model vs reference generator (needs tests/reference/, see its README)
python3 tests/golden.py --quick    # 48 kHz synthetic signals only (~1 min)
python3 tests/e2e.py clip.webm ... # the page in headless Chromium (Playwright)
```

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
