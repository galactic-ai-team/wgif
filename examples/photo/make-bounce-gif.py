# Self-made animated GIF (CC0, Galactic AI Team): a ball bouncing on a checkered floor in front of hills at sunset.
import math, sys
from PIL import Image, ImageDraw
def frame(W, H, t):
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    hor = int(H * 0.45)
    for y in range(hor):  # sky gradient
        k = y / hor
        d.line([(0, y), (W, y)], fill=(int(40 + 200 * k), int(30 + 90 * k), int(90 - 30 * k)))
    d.ellipse([W * 0.62, hor - H * 0.16, W * 0.62 + H * 0.24, hor + H * 0.08], fill=(255, 200, 90))
    for i, (amp, col) in enumerate([(0.10, (70, 50, 90)), (0.06, (45, 40, 70))]):
        pts = [(x, hor - H * amp * (0.6 + 0.4 * math.sin(x / W * 6 + i * 2))) for x in range(0, W + 8, 8)]
        d.polygon(pts + [(W, hor), (0, hor)], fill=col)
    # Perspective checker floor scrolling toward the viewer.
    for y in range(hor, H):
        z = (H - hor) / (y - hor + 1)
        row = int(z * 4 + t * 4) % 2
        for x in range(0, W, 2):
            u = (x - W / 2) * z / W * 8
            c = (int(u) + row) % 2
            shade = max(0.25, 1 - z / 30)
            col = (int((230 if c else 60) * shade), int((120 if c else 30) * shade), int((200 if c else 80) * shade))
            d.line([(x, y), (x + 1, y)], fill=col)
    # Bouncing ball near the viewer and its shadow.
    bx = W * (0.3 + 0.12 * math.sin(t * 2 * math.pi))
    by = H * 0.82 - abs(math.sin(t * 2 * math.pi)) * H * 0.38
    r = H * 0.09
    d.ellipse([bx - r * 1.1, H * 0.86, bx + r * 1.1, H * 0.86 + r * 0.4], fill=(20, 10, 30))
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=(60, 220, 255))
    d.ellipse([bx - r * 0.5, by - r * 0.6, bx - r * 0.1, by - r * 0.2], fill=(220, 250, 255))
    return im
W, H, N, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
frames = [frame(W, H, i / N).quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for i in range(N)]
frames[0].save(out, save_all=True, append_images=frames[1:], duration=70, loop=0, optimize=False, disposal=1)
