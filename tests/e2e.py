#!/usr/bin/env python3
"""End-to-end check of the page in headless Chromium (Playwright).

  python3 tests/e2e.py clip1.webm [clip2.webm ...] [--ref tests/reference/bass_shake_gen.py] [--out DIR]

The container's Chromium has no H.264/HEVC/AAC, so test with VP9/Opus copies (WebM).
For each clip:
  1. load it in the page, wait for the analysis, read the shake curve the page computed
  2. compare that curve to the reference generator run on ffmpeg's decode of the SAME audio
     (catches decode/alignment errors that the golden test, which feeds both sides the same
     samples, cannot): 30 fps clips per frame, others against time
  3. render a preview and the full export; check frame count, duration, audio kept
  4. preview == export: the preview's frames must match the export's frames at the same times
  5. for a clip whose picture is a still texture (name starts with 'synth'), measure the
     vertical shake ON THE OUTPUT PIXELS and compare it to the curve (magnitude and timing).
     Measured = centroid of the blurred image, so it is compared with dy + trail/2.
"""
import argparse, base64, functools, http.server, importlib.util, json, os, subprocess, sys, threading, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)


def serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k): pass
    h = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def decode_audio(path, sr):
    p = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-f", "f64le", "-ac", "1", "-ar", str(sr), "-"], capture_output=True)
    return np.frombuffer(p.stdout, dtype=np.float64).copy()


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                        "stream=codec_type,codec_name,nb_read_frames,width,height:format=duration", "-of", "json", path],
                       capture_output=True, text=True)
    return json.loads(r.stdout)


def frames_gray(path, x0, y0, w, h):
    """Grey frames, cropped to a w x h window at (x0, y0) — keeps memory small."""
    r = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-vf", "crop=%d:%d:%d:%d" % (w, h, x0, y0),
                        "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.uint8).reshape(-1, h, w)


def measure_dy(strips, tex, ov, W, H, search=70):
    """Vertical shift of each output frame's centre strip vs the (zoomed) still texture.
    strips: frames cropped to x in [W/2-60, W/2+60), y in [H/2-300, H/2+300)."""
    ys = ((np.arange(H) - H / 2) / ov + H / 2).astype(int).clip(0, H - 1)
    xs = ((np.arange(W // 2 - 60, W // 2 + 60) - W / 2) / ov + W / 2).astype(int).clip(0, W - 1)
    ref = tex[np.ix_(ys, xs)].astype(np.float32)
    cy0, cy1 = H // 2 - 300, H // 2 + 300
    out = []
    for f in strips:
        patch = f.astype(np.float32); patch = patch - patch.mean()
        best, bs = None, -1e18
        for s in range(-search, search + 1):
            r = ref[cy0 - s:cy1 - s]; r = r - r.mean()          # content moved down by s
            c = float((patch * r).sum() / (np.linalg.norm(patch) * np.linalg.norm(r) + 1e-9))
            if c > bs: bs, best = c, s
        out.append(best)
    return np.array(out, dtype=float)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--ref", default=os.path.join(HERE, "reference", "bass_shake_gen.py"))
    ap.add_argument("--out", default="/tmp/bassapp-e2e")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--preview-start", type=float, default=None)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bsg", a.ref); ref = importlib.util.module_from_spec(spec); spec.loader.exec_module(ref)
    from playwright.sync_api import sync_playwright
    serve(a.port)
    ok_all = True
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        for clip in a.clips:
            name = os.path.basename(clip); print("\n==", name)
            pg = br.new_page(viewport=dict(width=420, height=900))
            pg.goto("http://127.0.0.1:%d/index.html?t=%d" % (a.port, time.time()))
            pg.wait_for_function("window.__ready === true", timeout=30000)
            t0 = time.time()
            pg.set_input_files("#file", clip)
            pg.wait_for_function("document.getElementById('anaStatus').textContent.startsWith('Ready') || document.getElementById('anaStatus').className.includes('bad')", timeout=300000)
            st = pg.inner_text("#anaStatus"); print("  analysis:", st, "(%.1f s wall)" % (time.time() - t0))
            if not st.startswith("Ready"):
                ok_all = False; print("  FAIL"); print(pg.input_value("#log")[-2000:]); continue
            c = pg.evaluate("""() => { const S = window.__app; return { dy: Array.from(S.curve.dy), amp: Array.from(S.curve.amp),
                 fps: S.meta.fps, fpsF: S.meta.fpsF, n: S.meta.nFrames, offset: S.offsetSec, sr: S.an.sr, ov: S.curve.overscan,
                 params: S.params, w: S.meta.width, h: S.meta.height, dur: S.meta.dur } }""")
            dy = np.array(c["dy"]); P = c["params"]
            # --- 2. page curve vs reference on ffmpeg's decode of the same audio
            x = decode_audio(clip, c["sr"])
            n30 = int(round((c["dur"]) * 30)) - 1
            E = ref.energy_per_frame(x, c["sr"], n30, max(c["offset"], 0.0), p=P["p"], f_min=P["fMin"])
            rdy = ref.synth(E, P["K"], P["gamma"], P["rate"], P["t"], P["decay"], P["normWindow"], P["blurSustain"], P["knee"], P["blurK"])[0]
            if c["fps"]["num"] == 30 and c["fps"]["den"] == 1:
                m = min(len(dy), len(rdy)) - 1
                lags = {L: float(np.corrcoef(np.abs(dy[5 + L:m - 5 + L]), np.abs(rdy[5:m - 5]))[0, 1]) for L in range(-3, 4)}
                bestL = max(lags, key=lags.get)
                d = np.abs(dy[:m] - rdy[:m])
                print("  curve vs reference (per frame): max |diff| %.3f px, mean %.4f px, best lag %+d frames (corr %.4f), offset %.4f s"
                      % (d.max(), d.mean(), bestL, lags[bestL], c["offset"]))
                if bestL != 0 or lags[0] < 0.98: ok_all = False; print("  FAIL alignment/shape")
            else:
                t = np.arange(len(dy)) / c["fpsF"]; t30 = np.arange(len(rdy)) / 30
                env = np.interp(t, t30, np.abs(rdy)); amp = np.array(c["amp"])
                mm = (t > 0.3) & (t < t[-1] - 0.3)
                corr = float(np.corrcoef(amp[mm], env[mm])[0, 1])
                print("  curve vs reference (by time, %.3f fps): envelope corr %.3f" % (c["fpsF"], corr))
                if corr < 0.9: ok_all = False; print("  FAIL")
            # --- 3. preview
            ps = a.preview_start if a.preview_start is not None else max(0.0, min(c["dur"] - 4, c["dur"] / 2 - 2))
            pg.evaluate("v => { const e = document.getElementById('pstart'); e.value = v; e.dispatchEvent(new Event('input')); }", str(ps))
            ps = float(pg.input_value("#pstart"))
            pg.click("#previewBtn")
            pg.wait_for_function("document.getElementById('previewStatus').className.match(/ok|bad/)", timeout=300000)
            print("  preview:", pg.inner_text("#previewStatus"))
            pv = pg.evaluate("async () => { const v = document.getElementById('previewVid'); const b = await (await fetch(v.src)).arrayBuffer(); let s=''; const u=new Uint8Array(b); for (let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); }")
            pvp = os.path.join(a.out, name + ".preview.mp4"); open(pvp, "wb").write(base64.b64decode(pv))
            # --- export
            pg.click("#exportBtn")
            pg.wait_for_function("document.getElementById('exportStatus').className.match(/ok|bad/)", timeout=600000)
            print("  export:", pg.inner_text("#exportStatus"))
            ex = pg.evaluate("async () => { const b = await window.__app.out.blob.arrayBuffer(); let s=''; const u=new Uint8Array(b); for (let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); }")
            exp = os.path.join(a.out, name + ".export.mp4"); open(exp, "wb").write(base64.b64decode(ex))
            pin, pout = probe(clip), probe(exp)
            vin = [s for s in pin["streams"] if s["codec_type"] == "video"][0]; vout = [s for s in pout["streams"] if s["codec_type"] == "video"][0]
            has_a = any(s["codec_type"] == "audio" for s in pout["streams"])
            print("  frames in %s / out %s, duration in %.3f / out %.3f, audio kept: %s, out %sx%s %s"
                  % (vin["nb_read_frames"], vout["nb_read_frames"], float(pin["format"]["duration"]), float(pout["format"]["duration"]), has_a, vout["width"], vout["height"], vout["codec_name"]))
            if vin["nb_read_frames"] != vout["nb_read_frames"] or not has_a: ok_all = False; print("  FAIL frames/audio")
            # --- 4. preview == export
            W, H = int(vout["width"]), int(vout["height"])
            cw, ch = min(400, W), min(400, H)
            fe = frames_gray(exp, (W - cw) // 2, (H - ch) // 2, cw, ch); fp = frames_gray(pvp, (W - cw) // 2, (H - ch) // 2, cw, ch)
            k0 = int(round(ps * c["fpsF"]))
            m = min(len(fp), len(fe) - k0 - 1)
            idx = list(range(0, m, max(1, m // 30)))
            res = {L: float(np.mean([np.abs(fp[i].astype(np.float32) - fe[k0 + i + L]).mean() for i in idx if k0 + i + L >= 0])) for L in (-1, 0, 1)}
            print("  preview vs export: mean |diff| %.2f grey levels at the same frame (%.2f one early, %.2f one late)" % (res[0], res[-1], res[1]))
            if not (res[0] < res[-1] and res[0] < res[1]): ok_all = False; print("  FAIL preview != export")
            del fe, fp
            open(os.path.join(a.out, name + ".log.txt"), "w").write(pg.input_value("#log"))
            # --- 5. shake measured on the pixels
            if name.startswith("synth"):
                tex = np.frombuffer(open(os.path.join(os.path.dirname(clip), "tex.pgm"), "rb").read()[-1080 * 1920:], dtype=np.uint8).reshape(1920, 1080).astype(np.float32)
                strips = frames_gray(exp, W // 2 - 60, H // 2 - 300, 120, 600)
                meas = measure_dy(strips, tex, c["ov"] / 100.0, W, H)
                pxs = max(W, H) / 1920.0
                # The renderer's blur averages copies over [lo, hi] around dy: a centred directional
                # smear plus a shutter trail half-way back towards the previous frame's position.
                # So the image's centroid sits at dy + trail/2 = dy + 0.25*(dy_prev - dy).
                dyf = dy[:len(meas)] * pxs
                prev = np.r_[dyf[:1], dyf[:-1]]
                want = dyf + 0.25 * (prev - dyf)
                lags = {L: float(np.corrcoef(meas[5 + L:len(meas) - 5 + L], want[5:len(meas) - 5])[0, 1]) for L in range(-2, 3)}
                bestL = max(lags, key=lags.get)
                big = np.abs(want) > 8
                ratio = float(np.median(np.abs(meas[big]) / np.abs(want[big]))) if big.any() else float("nan")
                print("  pixels: measured vs curve corr %.3f, best lag %+d frames, |measured|/|curve| median %.2f on %d big frames"
                      % (lags[bestL], bestL, ratio, int(big.sum())))
                np.savetxt(os.path.join(a.out, name + ".measured.csv"), np.c_[want, meas], delimiter=",", header="expected_centroid_px,measured_px", fmt="%.2f")
                if bestL != 0 or lags[0] < 0.9 or not (0.8 < ratio < 1.2): ok_all = False; print("  FAIL pixels")
            pg.close()
        br.close()
    print("\nRESULT:", "PASS" if ok_all else "FAIL")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
