#!/usr/bin/env python3
"""Golden test: the app's model (js/shake.js) must reproduce the reference generator
(bass_shake_gen.py, VIDEO project) per frame.

  python3 tests/golden.py [--ref tests/reference/bass_shake_gen.py] [--audio clip.wav ...]
                          [--shipped <presets .intended.json> --source-dir <VIDEO reference/source>
                           --work tests/reference/work_areas.json]

Checks, for every signal x parameter set:
  1. 30 fps, frame by frame: energy E, displacement dy, rotation, blur, peak, overscan.
     Same algorithm in float64 on both sides, so tolerances are tight.
  2. Other frame rates (29.97, 25, 60): the reference is 30 fps only, so the app's curve is
     compared to the reference's AGAINST TIME (not frame index): envelope correlation.
     Informational thresholds; reported, not a per-frame identity.

  3. (with --shipped) the curves of presets actually shipped and approved by eye in the VIDEO
     project, read from a generator sidecar (.intended.json), with the work areas in --work.
     Sidecar values are rounded to 6 dp, so the tolerance is 1e-5 px.

Signals: synthetic files with a known character (generated here, nothing to download), plus
any real audio passed with --audio (mono-mixed, first 40 s).

The reference file is fingerprinted: its md5 must equal REF_MD5 (the VIDEO project's
tools/bass_shake_gen.py at the time it was copied). A mismatch is reported and the test
FAILS: re-copy and re-check, never silently update the fingerprint.
"""
import argparse, hashlib, importlib.util, json, math, os, subprocess, sys, tempfile, wave
import numpy as np

REF_MD5 = "b98c0672a0db86772c8ce68f74aad503"   # VIDEO tools/bass_shake_gen.py, 2026-10-06
HERE = os.path.dirname(os.path.abspath(__file__))

BASE = dict(p=4.0, fMin=25.0, gamma=0.5, decay=0.40, normWindow=4.0, knee=0.5, t=0.0, rate=15.0)
PRESETS = [("Slam", 26, .18, .35, 15), ("Punch", 26, .10, .18, 15), ("Swell", 18, .26, .50, 15),
           ("Nudge", 18, .10, .18, 15), ("Breath", 12, .08, .15, 15), ("Slam slow", 26, .18, .35, 7.5),
           ("Slam hard", 34, .18, .35, 15)]
CASES = [dict(BASE, name=n, K=K, blurK=bk, blurSustain=bs, rate=r) for n, K, bk, bs, r in PRESETS]
SLAM = CASES[0]
CASES += [dict(SLAM, name="edge: hard clip knee 1.0", knee=1.0),
          dict(SLAM, name="edge: threshold t 0.2", t=0.2),
          dict(SLAM, name="edge: decay 0.6", decay=0.6),
          dict(SLAM, name="edge: p2 fmin50 g1", p=2.0, fMin=50.0, gamma=1.0),
          dict(SLAM, name="edge: global norm", normWindow=None),
          dict(SLAM, name="edge: level-driven (no decay)", decay=None)]


def load_ref(path):
    md5 = hashlib.md5(open(path, "rb").read()).hexdigest()
    spec = importlib.util.spec_from_file_location("bsg", path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod, md5


# ------------------------------------------------------------ signals ---------
def synth_signals(sr):
    rng = np.random.default_rng(1)
    D = 24.0; n = int(D * sr); t = np.arange(n) / sr; sig = {}
    beat = 60.0 / 160.0                                   # the material is 160 BPM
    # lone kicks: 55 Hz with a fast pitch drop and exponential decay, on a syncopated grid
    x = np.zeros(n)
    for k, on in enumerate(np.arange(0.5, D - 1, beat)):
        if k % 8 in (3, 6): continue                     # rests, so the shake must rest
        i0 = int(on * sr); tt = t[: n - i0][: int(0.6 * sr)]
        f = 55 + 60 * np.exp(-tt / 0.02)
        ph = 2 * np.pi * np.cumsum(f) / sr
        x[i0:i0 + len(tt)] += (0.4 + 0.5 * (k % 4 == 0)) * np.sin(ph) * np.exp(-tt / 0.15)
    sig["kicks160"] = x
    # descending 808s: 60 -> 30 Hz glides, long sustain (the case the hand-made shake missed)
    x = np.zeros(n)
    for on in np.arange(1.0, D - 2, 4 * beat):
        i0 = int(on * sr); tt = t[: int(1.4 * sr)]
        f = 30 + 30 * np.exp(-tt / 0.5)
        x[i0:i0 + len(tt)] += 0.7 * np.tanh(2 * np.sin(2 * np.pi * np.cumsum(f) / sr)) * np.exp(-tt / 1.2)
    sig["808glide"] = x
    # tone bursts 50 Hz, 2 s on / 1 s off, with a loud section in the middle (tests norm window)
    g = ((t % 3) < 2).astype(float) * (1 + 2 * ((t > 9) & (t < 13)))
    sig["tone50"] = 0.2 * g * np.sin(2 * np.pi * 50 * t)
    # a mix: kicks + hats (noise) + an 800 Hz melody: the top end must not move it
    hats = np.zeros(n)
    for on in np.arange(0.25, D, beat / 2):
        i0 = int(on * sr); m = min(int(0.03 * sr), n - i0)
        hats[i0:i0 + m] += 0.3 * rng.standard_normal(m)
    sig["mix"] = sig["kicks160"] + hats + 0.2 * np.sin(2 * np.pi * 800 * t) * (np.sin(2 * np.pi * 0.5 * t) > 0)
    # near-silence: noise only. NORM_FLOOR keeps it from being auto-gained to full shake.
    sig["noise"] = 0.001 * rng.standard_normal(n)
    return sig


def load_audio_any(path, max_s=40.0):
    p = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-t", str(max_s), "-f", "f64le", "-ac", "1",
                        "-ar", "48000", "-"], capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("ffmpeg could not decode " + path)
    return np.frombuffer(p.stdout, dtype=np.float64).copy(), 48000


# ------------------------------------------------------------ runners ---------
def run_js(x, sr, n_frames, fps, cases):
    with tempfile.TemporaryDirectory() as d:
        pcm = os.path.join(d, "x.f64"); np.asarray(x, dtype="<f8").tofile(pcm)
        job = dict(pcm=pcm, sr=sr, nFrames=n_frames, fps=fps, offset=0.0, cases=cases)
        jp = os.path.join(d, "job.json"); json.dump(job, open(jp, "w"))
        r = subprocess.run(["node", os.path.join(HERE, "js_curve.mjs"), jp], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("js_curve failed:\n" + r.stderr)
        return json.loads(r.stdout)


def run_ref(ref, x, sr, n_frames, c):
    E = ref.energy_per_frame(x, sr, n_frames, 0.0, p=c["p"], f_min=c["fMin"])
    dy, rot, blur, peak, ov = ref.synth(E, c["K"], c["gamma"], c["rate"], c["t"], c["decay"],
                                       c["normWindow"], c["blurSustain"], c["knee"], c["blurK"])
    return dict(E=E, dy=dy, rot=rot, blur=blur, peak=peak, overscan=ov)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=os.path.join(HERE, "reference", "bass_shake_gen.py"))
    ap.add_argument("--audio", nargs="*", default=[])
    ap.add_argument("--quick", action="store_true", help="synthetic signals at 48 kHz only")
    ap.add_argument("--shipped", default=None, help="a .intended.json sidecar from the VIDEO project")
    ap.add_argument("--source-dir", default=None, help="VIDEO reference/source (the audio of the shipped edits)")
    ap.add_argument("--work", default=os.path.join(HERE, "reference", "work_areas.json"),
                    help='local JSON {"<frames>": ["<audio file>", <offset s>], ...}')
    a = ap.parse_args()

    ref, md5 = load_ref(a.ref)
    ok_all = True
    print("reference: %s\n  md5 %s %s" % (a.ref, md5, "OK" if md5 == REF_MD5 else "MISMATCH (expected %s)" % REF_MD5))
    if md5 != REF_MD5:
        ok_all = False

    signals = []
    for sr in ([48000] if a.quick else [48000, 44100]):
        for k, x in synth_signals(sr).items():
            signals.append(("%s@%dk" % (k, sr // 1000), x, sr))
    for p in a.audio:
        x, sr = load_audio_any(p); signals.append((os.path.basename(p), x, sr))

    print("\n1. 30 fps, per frame (tolerance: E 1e-9 relative, dy/rot/blur 1e-6 px, overscan exact)")
    worst = dict(E=0.0, dy=0.0, rot=0.0, blur=0.0)
    n_checks = 0
    for name, x, sr in signals:
        n_frames = int(len(x) / sr * 30) - 2
        js = run_js(x, sr, n_frames, dict(num=30, den=1), CASES)
        for c, j in zip(CASES, js):
            r = run_ref(ref, x, sr, n_frames, c)
            Emax = max(float(np.max(r["E"])), 1e-300)
            d = dict(E=float(np.max(np.abs(np.array(j["E"]) - r["E"]))) / Emax,
                     dy=float(np.max(np.abs(np.array(j["dy"]) - r["dy"]))),
                     rot=float(np.max(np.abs(np.array(j["rot"]) - r["rot"]))),
                     blur=float(np.max(np.abs(np.array(j["blur"]) - r["blur"]))))
            for k in worst: worst[k] = max(worst[k], d[k])
            bad = d["E"] > 1e-9 or d["dy"] > 1e-6 or d["rot"] > 1e-6 or d["blur"] > 1e-6 \
                or abs(j["overscan"] - r["overscan"]) > 1e-9 or abs(j["peak"] - r["peak"]) > 1e-6
            n_checks += 1
            if bad:
                ok_all = False
                print("  FAIL %-14s %-30s %s overscan js %.1f ref %.1f" % (name, c["name"], d, j["overscan"], r["overscan"]))
    print("  %d signal x parameter checks, %d frames each (approx). Worst: E %.1e  dy %.1e px  rot %.1e deg  blur %.1e px"
          % (n_checks, n_frames, worst["E"], worst["dy"], worst["rot"], worst["blur"]))

    print("\n2. Other frame rates vs the 30 fps reference, compared against TIME (Slam preset)")
    for name, x, sr in signals:
        if not (name.startswith(("kicks160", "808glide", "mix")) and "@48k" in name) and name not in [os.path.basename(p) for p in a.audio]:
            continue
        n30 = int(len(x) / sr * 30) - 2
        r = run_ref(ref, x, sr, n30, SLAM)
        env30 = np.abs(r["dy"]); t30 = np.arange(n30) / 30.0       # rate 15: |cos| = 1 every frame
        row = []
        for fps in (dict(num=30000, den=1001), dict(num=25, den=1), dict(num=60, den=1)):
            f = fps["num"] / fps["den"]; n = int(len(x) / sr * f) - 2
            j = run_js(x, sr, n, fps, [SLAM])[0]
            tj = np.arange(n) / f; amp = np.array(j["amp"])
            ref_at = np.interp(tj, t30, env30)
            m = (tj > 0.2) & (tj < tj[-1] - 0.2)
            corr = float(np.corrcoef(amp[m], ref_at[m])[0, 1])
            row.append("%.2f fps: corr %.3f, peak %.1f vs %.1f px" % (f, corr, float(amp.max()), float(env30.max())))
            if corr < 0.9:
                ok_all = False; row[-1] += "  LOW"
        print("  %-14s %s" % (name, " | ".join(row)))

    if a.shipped:
        # Work areas (frames -> audio file, offset s), from the VIDEO project's reference/source/README.md.
        # Kept in a local file next to the reference copy, not in the repo.
        work = {int(k): tuple(v) for k, v in json.load(open(a.work)).items()}
        print("\n3. Shipped, eye-approved preset curves (tolerance 1e-5 px; overscan differs by design:")
        print("   the shipped sets were locked to one Scale, the app derives it per clip)")
        pairs = json.loads(open(a.shipped).read(), object_pairs_hook=lambda p: p)
        for pname, v in pairs:
            v = dict(v); n = v["frames"]
            if n not in work: continue
            fn, off = work[n]; path = os.path.join(a.source_dir, fn)
            if not os.path.exists(path):
                print("  skip %-34s (no %s)" % (pname, fn)); continue
            x, sr = ref.load_audio(path)
            c = dict(name=pname, p=v["p"], fMin=v["f_min"], K=v["K"], gamma=v["gamma"], rate=v["rate"], t=v["t"],
                     decay=v["decay"], normWindow=v["norm_window"], blurSustain=v["blur_sustain"], knee=v["knee"], blurK=v["blur_k"])
            with tempfile.TemporaryDirectory() as d:
                pcm = os.path.join(d, "x.f64"); np.asarray(x, dtype="<f8").tofile(pcm)
                jp = os.path.join(d, "j.json"); json.dump(dict(pcm=pcm, sr=sr, nFrames=n, fps=dict(num=30, den=1), offset=off, cases=[c]), open(jp, "w"))
                r = subprocess.run(["node", os.path.join(HERE, "js_curve.mjs"), jp], capture_output=True, text=True)
                j = json.loads(r.stdout)[0]
            dd = max(float(np.max(np.abs(np.array(j[k]) - np.array(v[k])))) for k in ("dy", "rot", "blur"))
            bad = dd > 1e-5
            ok_all = ok_all and not bad
            print("  %s %-34s max |diff| %.1e  (overscan app %.1f, shipped %.1f)" % ("FAIL" if bad else "ok  ", pname, dd, j["overscan"], v["overscan"]))

    print("\nRESULT:", "PASS" if ok_all else "FAIL")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
