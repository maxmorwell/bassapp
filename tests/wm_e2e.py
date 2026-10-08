#!/usr/bin/env python3
"""Watermark check on rendered pixels (BASSAPP-006 test build).

  python3 tests/make_synth.py --out /tmp/bassapp-wm --dur 20
  python3 tests/wm_e2e.py /tmp/bassapp-wm/synth_30.webm [--size 720p]

Exports the clip twice in headless Chromium — watermark Off, then On — and compares the frames:
  - outside the planned text box (plus the shadow and the shake it follows) the two exports
    must match (only encoder noise);
  - inside it, the text must be there while it is fully visible, and gone on the frame before
    each move (the hidden switch-over);
  - the plan's moves are 5-8 s apart and none in the last 2 s;
  - preview == export with the watermark ON (same plan for a trimmed render).
"""
import argparse, base64, json, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import serve, frames_gray, probe

B64 = "async (expr) => { const b = await (await (expr === 'preview' ? fetch(document.getElementById('previewVid').src) : Promise.resolve(new Response(window.__app.out.blob)))).arrayBuffer(); let s=''; const u=new Uint8Array(b); for (let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); }"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip"); ap.add_argument("--out", default="/tmp/bassapp-wm-out"); ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--size", default=None)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    from playwright.sync_api import sync_playwright
    serve(a.port); ok = True
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = br.new_page(viewport=dict(width=420, height=900))
        pg.goto("http://127.0.0.1:%d/index.html?t=%d" % (a.port, time.time()))
        pg.wait_for_function("window.__ready === true", timeout=30000)
        pg.set_input_files("#file", a.clip)
        pg.wait_for_function("document.getElementById('anaStatus').textContent.startsWith('Ready')", timeout=300000)
        if a.size: pg.click("#sizeSeg button:text-is('%s')" % a.size)
        outs = {}
        for label, idx in (("off", 1), ("on", 0)):
            pg.click("#c_wm button[data-i='%d']" % idx)
            pg.click("#exportBtn")
            pg.wait_for_function("document.getElementById('exportStatus').className.match(/ok|bad/)", timeout=600000)
            print("export (watermark %s):" % label, pg.inner_text("#exportStatus"))
            p = os.path.join(a.out, "wm_%s.mp4" % label); open(p, "wb").write(base64.b64decode(pg.evaluate(B64, "export"))); outs[label] = p
        plan = pg.evaluate("() => window.__app.wmPlan")
        c = pg.evaluate("() => { const S = window.__app; return { dy: Array.from(S.curve.dy), fpsF: S.meta.fpsF, dur: S.meta.dur, wm: S.wm, ov: S.curve.overscan } }")
        # preview with the watermark on, around the first move
        mv0 = plan["moves"][0]["frame"] / c["fpsF"] if plan["moves"] else 1.0
        ps = max(0.0, mv0 - 1.5)
        pg.evaluate("v => { const e = document.getElementById('c_pstart'); e.value = v; e.dispatchEvent(new Event('input')); }", str(ps))
        ps = float(pg.input_value("#c_pstart"))
        pg.click("#previewBtn")
        pg.wait_for_function("document.getElementById('previewStatus').className.match(/ok|bad/)", timeout=300000)
        pvp = os.path.join(a.out, "wm_preview.mp4"); open(pvp, "wb").write(base64.b64decode(pg.evaluate(B64, "preview")))
        open(os.path.join(a.out, "wm_log.txt"), "w").write(pg.input_value("#log"))
        br.close()

    W, H = plan["w"], plan["h"]; fps = c["fpsF"]; fs = plan["fontPx"]; tw = plan["textW"]
    moves = [m["frame"] for m in plan["moves"]]
    print("plan: %dx%d, font %.1f px, text %.0f px wide, moves at %s s" % (W, H, fs, tw, ", ".join("%.2f%s" % (f / fps, "*" if m["onHit"] else "") for f, m in zip(moves, plan["moves"]))))
    gaps = np.diff([0] + moves) / fps
    if len(moves) == 0 or gaps.min() < 5 - 1e-6 or gaps.max() > 8 + 1e-6 or (c["dur"] - moves[-1] / fps) < 2: ok = False; print("FAIL move timing", gaps)
    off = frames_gray(outs["off"], 0, 0, W, H); on = frames_gray(outs["on"], 0, 0, W, H)      # uint8: memory
    n = min(len(off), len(on))
    diff = lambda i: np.abs(on[i].astype(np.int16) - off[i].astype(np.int16)).astype(np.float32)
    pxs = max(W, H) / 1920.0; follow = c["wm"]["shake"] / 100.0
    spot_of = lambda i: sum(1 for f in moves if i >= f) % len(plan["at"])
    inside, outside, before = [], [], []
    for i in range(0, n):
        s = spot_of(i); p = plan["at"][s]; y = p["y"] + follow * c["dy"][i] * pxs
        m = int(round(0.5 * fs))                            # shadow + antialiasing margin
        x0, x1 = int(max(0, p["x"] - m)), int(min(W, p["x"] + tw + m)); y0, y1 = int(max(0, y - 1.1 * fs - m)), int(min(H, y + 0.35 * fs + m))
        mask = np.zeros((H, W), bool); mask[y0:y1, x0:x1] = True
        # the previous spot's box too, during a fade (text there fading out)
        di = diff(i)
        outside.append(float(di[~mask].mean()))
        tight = di[int(y - 0.75 * fs):int(y), int(p["x"]):int(p["x"] + tw)]
        if any(i == f - 1 for f in moves): before.append(float(tight.mean()))
        elif all(abs(i - f) > 0.3 * fps for f in moves): inside.append(float(tight.mean()))
    outside, inside = np.array(outside), np.array(inside)
    print("outside the text box: mean |on - off| %.2f grey levels (max frame %.2f)" % (outside.mean(), outside.max()))
    print("on the text, fully visible: mean |on - off| %.1f (min frame %.1f) on %d frames" % (inside.mean(), inside.min(), len(inside)))
    print("on the text, frame before each move (hidden): %s" % ", ".join("%.2f" % v for v in before))
    if outside.max() > 2.5: ok = False; print("FAIL watermark leaks outside its box")
    if inside.min() < 8: ok = False; print("FAIL watermark missing on some fully visible frames")
    if any(v > 3 for v in before): ok = False; print("FAIL not hidden on the frame before a move")
    # preview == export (watermark on)
    fp = frames_gray(pvp, 0, 0, W, H); k0 = int(round(ps * fps))
    mm = min(len(fp), n - k0 - 1)
    res = {L: float(np.mean([np.abs(fp[i].astype(np.int16) - on[k0 + i + L].astype(np.int16)).mean() for i in range(0, mm, 2) if k0 + i + L >= 0])) for L in (-1, 0, 1)}
    print("preview vs export (watermark on, across the first move): %.2f at the same frame (%.2f early, %.2f late)" % (res[0], res[-1], res[1]))
    if not (res[0] < res[-1] and res[0] < res[1] and res[0] < 2.5): ok = False; print("FAIL preview != export")
    print("\nRESULT:", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
