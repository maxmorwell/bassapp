#!/usr/bin/env python3
"""Judge by eye: one control at several values, tiled side by side (2 or 4 tiles, labelled).

  python3 tests/render_variants.py SRC_DIR OUT_DIR --control wmop --values 35,50,65,80 [--start 2 --dur 12] [--names "a.mp4|b.mp4"]

For each clip: a --dur s excerpt is exported through the page once per value (see render_clips.py),
then tiled (2 values: side by side; 4: 2x2) with the value in each tile's corner -> "<name> - <control> <values>.mp4".
"""
import argparse, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import serve
from render_clips import export, to_webm

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out"); ap.add_argument("--control", required=True); ap.add_argument("--values", required=True)
    ap.add_argument("--start", type=float, default=2); ap.add_argument("--dur", type=float, default=12); ap.add_argument("--size", default="720p")
    ap.add_argument("--names", default=None, help="'|'-separated file names in SRC_DIR (default: all)"); ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--unit", default="pc", help="label suffix (ffmpeg drawtext: avoid %)")
    a = ap.parse_args(); vals = a.values.split(","); assert len(vals) in (2, 4)
    work = os.path.join(a.out, "work"); os.makedirs(work, exist_ok=True)
    names = a.names.split("|") if a.names else sorted(f for f in os.listdir(a.src) if f.lower().endswith((".mp4", ".mov", ".m4v", ".webm")))
    serve(a.port)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        for f in names:
            stem = os.path.splitext(f)[0]; wb = os.path.join(work, stem + ".webm"); to_webm(os.path.join(a.src, f), wb, a.start, a.dur)
            outs = []
            for v in vals:
                pg = br.new_page(); data, status, wlog = export(pg, a.port, wb, a.size, ["%s=%s" % (a.control, v)]); pg.close()
                p = os.path.join(work, "%s_%s.mp4" % (stem, v)); open(p, "wb").write(data); outs.append(p)
                print(stem, v, "|", status, "|", (wlog or [""])[-1][:160], flush=True)
            lab = "".join("[%d:v]drawtext=fontfile=%s:expansion=none:text='%s %s':x=w-tw-14:y=h-th-14:fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=6[v%d];" % (k, FONT, v, a.unit, k) for k, v in enumerate(vals))
            tile = "[v0][v1]hstack[out]" if len(vals) == 2 else "[v0][v1]hstack[t];[v2][v3]hstack[b];[t][b]vstack[out]"
            subprocess.run(["ffmpeg", "-v", "error", "-y", *sum([["-i", o] for o in outs], []), "-filter_complex", lab + tile, "-map", "[out]", "-map", "0:a",
                            "-c:v", "libx264", "-crf", "21", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
                            os.path.join(a.out, "%s - %s %s.mp4" % (stem, a.control, "-".join(vals)))], check=True)
        br.close()
    print("DONE")


if __name__ == "__main__":
    main()
