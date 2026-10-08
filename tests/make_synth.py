#!/usr/bin/env python3
"""Make the synthetic e2e test clips (VP9/Opus WebM) and the still texture they show.

  python3 tests/make_synth.py [--out /tmp/bassapp-clips] [--dur 8]

Writes:
  tex.pgm                 1080x1920 grey still texture (portrait). e2e.py reads it to measure
                          the shake on the output pixels, so it must sit next to the clips.
  synth_30.webm           30 fps      kicks at 120 BPM + a sustained 50 Hz bass in the middle third
  synth_2997.webm         29.97 fps   same audio
  synth_25.webm           25 fps      same audio
  synth_60.webm           60 fps      same audio
  synth_quiet.webm        30 fps      same, but the middle third 20 dB quieter (quiet-passage case)
  nobass.webm             30 fps      melody + hi-hats only, no bass (the page should not shake it)

Deterministic (fixed seed): rerunning gives the same pictures and sounds.
"""
import argparse, os, subprocess
import numpy as np

SR = 48000
W, H = 1080, 1920


def texture(seed=1):
    rng = np.random.default_rng(seed)
    # Blobs at several scales: lots of vertical structure for the correlation in e2e.py.
    img = np.zeros((H, W), np.float32)
    for scale in (8, 24, 64, 160):
        g = rng.standard_normal((H // scale + 2, W // scale + 2)).astype(np.float32)
        up = np.kron(g, np.ones((scale, scale), np.float32))[:H, :W]
        k = max(1, scale // 2)                              # box smooth, separable
        c = np.cumsum(np.pad(up, ((k, k), (0, 0)), mode="edge"), axis=0); up = (c[2 * k:] - c[:-2 * k]) / (2 * k)
        c = np.cumsum(np.pad(up, ((0, 0), (k, k)), mode="edge"), axis=1); up = (c[:, 2 * k:] - c[:, :-2 * k]) / (2 * k)
        img += up / up.std()
    img = (img - img.min()) / (img.max() - img.min())
    return (img * 220 + 18).astype(np.uint8)


def audio(dur, quiet_mid=False):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.zeros(n)
    beat = 60 / 120
    for k in range(int(dur / beat)):                       # kick: 55 Hz -> 45 Hz, 180 ms
        t0 = 0.25 + k * beat
        i0 = int(t0 * SR); m = min(n - i0, int(0.18 * SR))
        if m <= 0: break
        tt = np.arange(m) / SR
        f = 45 + 30 * np.exp(-tt / 0.03)
        x[i0:i0 + m] += 0.8 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.06)
    a, b = int(dur / 3 * SR), int(2 * dur / 3 * SR)        # held bass in the middle third
    env = np.minimum(1, np.minimum(np.arange(b - a), np.arange(b - a)[::-1]) / (0.05 * SR))
    x[a:b] += 0.35 * np.sin(2 * np.pi * 50 * t[a:b]) * env
    x += 0.05 * np.sin(2 * np.pi * 880 * t) * (np.sin(2 * np.pi * 2 * t) > 0)   # a little melody, not bass
    if quiet_mid: x[a:b] *= 0.1
    return (x / np.abs(x).max() * 0.9).astype(np.float32)


def audio_nobass(dur):
    """Melody + hi-hats only: no bass. The page should give (almost) no shake (bass-presence gain)."""
    n = int(dur * SR); t = np.arange(n) / SR
    rng = np.random.default_rng(3)
    x = 0.2 * np.sin(2 * np.pi * 440 * t) * (np.sin(2 * np.pi * 1.5 * t) > 0)
    x += 0.15 * rng.standard_normal(n) * ((t % 0.25) < 0.03)
    return (x / np.abs(x).max() * 0.9).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/bassapp-clips")
    ap.add_argument("--dur", type=float, default=8.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tex = texture()
    pgm = os.path.join(a.out, "tex.pgm")
    with open(pgm, "wb") as f: f.write(b"P5\n%d %d\n255\n" % (W, H)); f.write(tex.tobytes())
    for name, fps, quiet in [("synth_30", "30", False), ("synth_2997", "30000/1001", False),
                             ("synth_25", "25", False), ("synth_60", "60", False), ("synth_quiet", "30", True)]:
        wav = os.path.join(a.out, name + ".f32")
        audio(a.dur, quiet).tofile(wav)
        out = os.path.join(a.out, name + ".webm")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", fps, "-i", pgm,
                        "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", wav, "-t", str(a.dur),
                        "-c:v", "libvpx-vp9", "-b:v", "4M", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p",
                        "-c:a", "libopus", "-b:a", "128k", out], check=True)
        os.remove(wav)
        print("wrote", out)
    wav = os.path.join(a.out, "nobass.f32"); audio_nobass(a.dur).tofile(wav)
    out = os.path.join(a.out, "nobass.webm")        # not "synth*": no pixel-shake check (there is no shake)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-i", pgm, "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", wav,
                    "-t", str(a.dur), "-c:v", "libvpx-vp9", "-b:v", "4M", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p",
                    "-c:a", "libopus", "-b:a", "128k", out], check=True)
    os.remove(wav); print("wrote", out)
    print("wrote", pgm)


if __name__ == "__main__":
    main()
