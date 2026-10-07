#!/usr/bin/env python3
"""Per-control checks ON THE RENDERED PIXELS: renders the synthetic clips through the page
(tests/e2e.py) with different settings and checks each control moves the picture as it should.

  python3 tests/make_synth.py --out /tmp/bassapp-clips     # once
  python3 tests/pixel_controls.py [--clips /tmp/bassapp-clips]

Every run also passes e2e.py's own checks (curve vs reference, preview == export, measured
shake vs curve incl. the shutter trail). On top, comparing runs:
  Strength   100 % moves the picture further than the preset
  Motion blur 0 % -> 40 % (natural) -> 100 % (extra): moving frames get progressively softer;
             at 0 % moving frames are as sharp as still ones
  Bass smear 0 % vs 100 %: the held-bass stretch gets softer
  Wobble     Slow at 60 fps and Fast at 25 fps still track the curve on the pixels
  Output size 720p gives a 720-wide portrait output
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = [  # tag, clip, extra args
    ("default", "synth_30", []),
    ("strength100", "synth_30", ["--set", "strength=100"]),
    ("blur0", "synth_30", ["--set", "blur=0", "--set", "smear=0"]),
    ("blur40", "synth_30", ["--set", "blur=40", "--set", "smear=0"]),
    ("blur100", "synth_30", ["--set", "blur=100", "--set", "smear=0"]),
    ("smear100", "synth_30", ["--set", "blur=0", "--set", "smear=100"]),
    ("slow60", "synth_60", ["--set", "wobble=1"]),
    ("fast25", "synth_25", []),
    ("size720", "synth_2997", ["--size", "720p"]),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default="/tmp/bassapp-clips")
    ap.add_argument("--out", default="/tmp/bassapp-pixels")
    ap.add_argument("--only", default=None, help="comma-separated tags")
    a = ap.parse_args()
    S, ok = {}, True
    for tag, clip, extra in RUNS:
        if a.only and tag not in a.only.split(","): continue
        print("\n##", tag, flush=True)
        r = subprocess.run([sys.executable, os.path.join(HERE, "e2e.py"), os.path.join(a.clips, clip + ".webm"), "--out", a.out, "--tag", "." + tag] + extra,
                           capture_output=True, text=True)
        print("\n".join(l for l in r.stdout.splitlines() if l.strip()))
        if r.returncode: ok = False; print("FAIL e2e (" + tag + ")"); print(r.stderr[-2000:])
        p = os.path.join(a.out, clip + ".webm." + tag + ".summary.json")
        if os.path.exists(p): S[tag] = json.load(open(p))

    def chk(cond, what, detail):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + what + "  — " + detail)
        if not cond: ok = False

    print("\n== comparisons")
    if {"default", "strength100"} <= S.keys():
        chk(S["strength100"]["measured_peak"] > 1.5 * S["default"]["measured_peak"], "strength 100% moves the picture further than Slam (41%)",
            "%.1f vs %.1f px" % (S["strength100"]["measured_peak"], S["default"]["measured_peak"]))
    if {"blur0", "blur40", "blur100"} <= S.keys():
        m = [S[k]["sharp_moving"] for k in ("blur0", "blur40", "blur100")]
        chk(m[0] > m[1] > m[2], "motion blur 0 -> 40 -> 100%: moving frames get softer", "sharpness %.2f > %.2f > %.2f" % tuple(m))
        st = S["blur0"]["sharp_still"]
        chk(st and abs(m[0] - st) / st < 0.05, "motion blur 0%: moving frames as sharp as still ones", "%.2f vs %.2f" % (m[0], st or -1))
    if {"blur0", "smear100"} <= S.keys():
        chk(S["smear100"]["sharp_held"] < 0.9 * S["blur0"]["sharp_held"], "bass smear 100%: the held-bass stretch gets softer",
            "%.2f vs %.2f" % (S["smear100"]["sharp_held"], S["blur0"]["sharp_held"]))
    for k in ("slow60", "fast25"):
        if k in S: chk(S[k]["corr"] > 0.9 and S[k]["lag"] == 0, k + ": shake on the pixels tracks the curve", "corr %.3f, lag %d" % (S[k]["corr"], S[k]["lag"]))
    if "size720" in S:
        chk(min(S["size720"]["out_w"], S["size720"]["out_h"]) == 720, "output size 720p = shorter side 720", "%dx%d" % (S["size720"]["out_w"], S["size720"]["out_h"]))
    print("\nRESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
