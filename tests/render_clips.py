#!/usr/bin/env python3
"""Judge by eye: export real clips through the page (headless Chromium), for the Manager to watch.

  python3 tests/render_clips.py SRC_DIR OUT_DIR [--tag v5] [--size 720p] [--set wmop=35 ...] [--start S --dur D]

Each .mp4/.mov in SRC_DIR is converted to VP9/Opus WebM (the test browser has no H.264/HEVC/AAC),
loaded, exported with the given settings, then re-encoded to H.264/AAC MP4 so it plays anywhere:
OUT_DIR/<name> - <tag>.mp4. The page log's watermark lines are printed. --set takes control ids as in
e2e.py (sliders: value; segment buttons: index). Note: a tool call is capped at 10 min — run long
batches in the background and poll.
"""
import argparse, base64, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import serve

B64 = "async () => { const b = await window.__app.out.blob.arrayBuffer(); let s=''; const u=new Uint8Array(b); for (let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); }"


def apply_set(pg, sets):
    for kv in sets:
        k, v = kv.split("=")
        if pg.locator("#c_%s button" % k).count(): pg.click("#c_%s button[data-i='%s']" % (k, v))
        else: pg.evaluate("([k, v]) => { const e = document.getElementById('c_' + k); e.value = v; e.dispatchEvent(new Event('input')); }", [k, v])


def export(pg, port, webm, size, sets):
    pg.goto("http://127.0.0.1:%d/index.html?t=%d" % (port, time.time())); pg.wait_for_function("window.__ready === true")
    pg.set_input_files("#file", webm)
    pg.wait_for_function("document.getElementById('anaStatus').textContent.startsWith('Ready') || document.getElementById('anaStatus').className.includes('bad')", timeout=300000)
    if size: pg.click("#sizeSeg button:text-is('%s')" % size)
    apply_set(pg, sets)
    pg.click("#exportBtn"); pg.wait_for_function("document.getElementById('exportStatus').className.match(/ok|bad/)", timeout=900000)
    return base64.b64decode(pg.evaluate(B64)), pg.inner_text("#exportStatus"), [l for l in pg.input_value("#log").split("\n") if "watermark" in l]


def to_webm(src, dst, start=None, dur=None):
    cut = (["-ss", str(start)] if start is not None else []) + (["-t", str(dur)] if dur else [])
    subprocess.run(["ffmpeg", "-v", "error", "-y", *cut, "-i", src, "-c:v", "libvpx-vp9", "-b:v", "3M", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", dst], check=True)


def to_h264(src, dst):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", dst], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out"); ap.add_argument("--tag", default="render"); ap.add_argument("--size", default="720p")
    ap.add_argument("--set", action="append", default=[]); ap.add_argument("--start", type=float); ap.add_argument("--dur", type=float)
    ap.add_argument("--port", type=int, default=8795)
    a = ap.parse_args(); work = os.path.join(a.out, "work"); os.makedirs(work, exist_ok=True)
    serve(a.port)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        for f in sorted(os.listdir(a.src)):
            if not f.lower().endswith((".mp4", ".mov", ".m4v", ".webm")): continue
            stem = os.path.splitext(f)[0]; wb = os.path.join(work, stem + ".webm")
            to_webm(os.path.join(a.src, f), wb, a.start, a.dur)
            pg = br.new_page()
            data, status, wlog = export(pg, a.port, wb, a.size, a.set); pg.close()
            raw = os.path.join(work, stem + ".out.mp4"); open(raw, "wb").write(data)
            to_h264(raw, os.path.join(a.out, "%s - %s.mp4" % (stem, a.tag)))
            print(stem, "|", status, "|", wlog[-3:], flush=True)
        br.close()
    print("DONE")


if __name__ == "__main__":
    main()
