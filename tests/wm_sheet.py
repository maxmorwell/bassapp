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

JS = """async ([src, w, h, size, op, spot]) => {
  const W = await import('/js/watermark.js');
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const { font, fontPx } = W.wmFont(size, w, h);
  await document.fonts.load(font, W.WM_TEXT);
  const ok = document.fonts.check('500 20px "BS Watermark"', W.WM_TEXT);
  g.font = font; const tw = g.measureText(W.WM_TEXT).width;
  const spots = W.spotsFor(w, h), p = W.placeText(spots[spot % spots.length], tw, fontPx, w, h);
  W.drawWatermark(g, font, fontPx, p.x, p.y, op / 100);
  return { url: c.toDataURL('image/png'), ok };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+"); ap.add_argument("--out", required=True)
    ap.add_argument("--at", type=float, default=0.45); ap.add_argument("--cell", type=int, default=300)
    ap.add_argument("--variants", default="2.8:55,3.5:70,4.5:85"); ap.add_argument("--port", type=int, default=8767)
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
            png = os.path.join(tmp, "f%d.png" % k)
            subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-ss", str(a.at * dur), "-i", clip, "-frames:v", "1", png], check=True)
            im = Image.open(png); w, h = im.size
            src = "data:image/png;base64," + base64.b64encode(open(png, "rb").read()).decode()
            cells = []
            for size, op in variants:
                r = pg.evaluate(JS, [src, w, h, size, op, k])
                if not r["ok"]: print("WARNING: watermark font not loaded")
                cell = Image.open(io.BytesIO(base64.b64decode(r["url"].split(",")[1]))).convert("RGB")
                cells.append(cell.resize((a.cell, round(a.cell * h / w)), Image.LANCZOS))
            rows.append((os.path.basename(clip), cells))
            print("%s: %dx%d at %.1f s" % (os.path.basename(clip), w, h, a.at * dur))
        br.close()
    pad, head, lab = 14, 40, 22
    rh = [max(c.size[1] for c in cs) for _, cs in rows]
    Wt = pad + len(variants) * (a.cell + pad); Ht = head + sum(lab + r + pad for r in rh)
    sheet = Image.new("RGB", (Wt, Ht), (24, 24, 28)); d = ImageDraw.Draw(sheet)
    try: f = ImageFont.truetype("DejaVuSans.ttf", 15)
    except Exception: f = ImageFont.load_default()
    for j, (s, o) in enumerate(variants):
        d.text((pad + j * (a.cell + pad), 12), "size %.1f%% · opacity %d%%%s" % (s, o, "  (default)" if (s, o) == (3.5, 70) else ""), fill=(230, 230, 230), font=f)
    y = head
    for (name, cells), r in zip(rows, rh):
        d.text((pad, y + 2), name, fill=(170, 170, 170), font=f); y += lab
        for j, c in enumerate(cells): sheet.paste(c, (pad + j * (a.cell + pad), y))
        y += r + pad
    sheet.save(a.out); print("wrote", a.out, sheet.size)


if __name__ == "__main__":
    main()
