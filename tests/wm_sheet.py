#!/usr/bin/env python3
"""Watermark contact sheet: stills from real clips with the watermark drawn by the page's own code
(js/watermark.js: wmFont / spotsFor / placeText / drawWatermark, hosted font) at a few size/opacity
settings, side by side. For judging legibility across clips; not a test.

  python3 tests/wm_sheet.py clip1.mp4 ... --out sheet.png [--at 0.45] [--variants 2.8:55,3.5:70,4.5:85]
"""
import argparse, base64, io, os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import serve
from PIL import Image, ImageDraw, ImageFont

JS = """async ([src, w, h, size, op, spot, thumbs, segs, segk]) => {
  const W = await import('/js/watermark.js');
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const { font, fontPx } = W.wmFont(size, w, h);
  await document.fonts.load(font, W.WM_TEXT);
  const ok = document.fonts.check('500 20px "BS Watermark"', W.WM_TEXT);
  g.font = font; const tw = g.measureText(W.WM_TEXT).width;
  const spots = W.spotsFor(w, h);
  let si = spot % spots.length;
  if (thumbs) {                                   // the page's spot finder on this clip's own frames
    const th = thumbs.map(o => ({ t: o.t, w: o.w, h: o.h, g: Uint8Array.from(atob(o.g), c => c.charCodeAt(0)) }));
    si = W.chooseSpots(spots, segs, th, tw / w, fontPx / h, h / w).spots[segk];
  }
  const p = W.placeText(spots[si], tw, fontPx, w, h);
  W.drawWatermark(g, font, fontPx, p.x, p.y, op / 100);
  return { url: c.toDataURL('image/png'), ok };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+"); ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.45); ap.add_argument("--cell", type=int, default=300)
    ap.add_argument("--variants", default="2.8:55,3.5:70,4.5:85"); ap.add_argument("--port", type=int, default=8767)
    ap.add_argument("--moments", type=int, default=0, help="instead of variants: N stills per clip (one per 6.5 s segment), spots chosen by the spot finder, first variant's size/opacity")
    a = ap.parse_args()
    variants = [tuple(float(x) for x in v.split(":")) for v in a.variants.split(",")]
    tmp = tempfile.mkdtemp()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    serve(a.port)
    from playwright.sync_api import sync_playwright
    rows = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(); pg = br.new_page()
        pg.goto("http://127.0.0.1:%d/index.html" % a.port); pg.wait_for_function("window.__ready === true", timeout=30000)
        for k, clip in enumerate(a.clips):
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip], capture_output=True, text=True).stdout)
            thumbs = segs = None; jobs = []
            if a.moments:
                tw = 144
                raw = subprocess.run(["ffmpeg", "-v", "quiet", "-ss", "0.5", "-i", clip, "-vf", "fps=1,scale=%d:-2" % tw, "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
                pr = subprocess.run(["ffmpeg", "-v", "quiet", "-i", clip, "-frames:v", "1", "-vf", "scale=%d:-2" % tw, "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
                th = len(pr) // tw
                thumbs = [dict(t=i + 0.5, w=tw, h=th, g=base64.b64encode(raw[i * tw * th:(i + 1) * tw * th]).decode()) for i in range(len(raw) // (tw * th))]
                cuts = [0.0]; 
                while cuts[-1] + 6.5 < dur - 2: cuts.append(cuts[-1] + 6.5)
                cuts.append(dur); segs = [[cuts[i], cuts[i + 1]] for i in range(len(cuts) - 1)]
                for sk in range(min(a.moments, len(segs))): jobs.append(((segs[sk][0] + segs[sk][1]) / 2, variants[0], sk))
            else:
                jobs = [(a.at * dur, v, None) for v in variants]
            cells = []
            for ji, (tt, (size, op), sk) in enumerate(jobs):
                png = os.path.join(tmp, "f%d_%d.png" % (k, ji))
                subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-ss", str(tt), "-i", clip, "-frames:v", "1", png], check=True)
                im = Image.open(png); w, h = im.size
                src = "data:image/png;base64," + base64.b64encode(open(png, "rb").read()).decode()
                r = pg.evaluate(JS, [src, w, h, size, op, k, thumbs, segs, sk if sk is not None else 0])
                if not r["ok"]: print("WARNING: watermark font not loaded")
                cell = Image.open(io.BytesIO(base64.b64decode(r["url"].split(",")[1]))).convert("RGB")
                cells.append(cell.resize((a.cell, round(a.cell * h / w)), Image.LANCZOS))
            rows.append((os.path.basename(clip), cells))
            print("%s: %dx%d, %d stills" % (os.path.basename(clip), w, h, len(cells)))
        br.close()
    pad, head, lab = 14, 40, 22
    rh = [max(c.size[1] for c in cs) for _, cs in rows]
    ncol = max(len(cs) for _, cs in rows)
    Wt = pad + ncol * (a.cell + pad); Ht = head + sum(lab + r + pad for r in rh)
    sheet = Image.new("RGB", (Wt, Ht), (24, 24, 28)); d = ImageDraw.Draw(sheet)
    try: f = ImageFont.truetype("DejaVuSans.ttf", 15)
    except Exception: f = ImageFont.load_default()
    heads = (["%.0f-%.0f s segment" % (6.5 * j, 6.5 * j + 6.5) for j in range(ncol)] if a.moments else None)
    for j, (s, o) in enumerate(variants if not a.moments else [variants[0]] * ncol):
        if heads: d.text((pad + j * (a.cell + pad), 12), "segment %d · size %.1f%% · opacity %d%%" % (j + 1, s, o), fill=(230, 230, 230), font=f); continue
        d.text((pad + j * (a.cell + pad), 12), "size %.1f%% · opacity %d%%%s" % (s, o, "  (default)" if (s, o) == (3.5, 70) else ""), fill=(230, 230, 230), font=f)
    y = head
    for (name, cells), r in zip(rows, rh):
        d.text((pad, y + 2), name, fill=(170, 170, 170), font=f); y += lab
        for j, c in enumerate(cells): sheet.paste(c, (pad + j * (a.cell + pad), y))
        y += r + pad
    sheet.save(a.out); print("wrote", a.out, sheet.size)


if __name__ == "__main__":
    main()
