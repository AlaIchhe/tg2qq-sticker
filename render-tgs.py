import sys, os
from rlottie_python import LottieAnimation
from PIL import Image

src, outdir = sys.argv[1], sys.argv[2]
scale = int(sys.argv[3]) if len(sys.argv) > 3 else 512
out_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 20.0
os.makedirs(outdir, exist_ok=True)
a = LottieAnimation.from_tgs(src)
w, h = a.lottie_animation_get_size()
n = a.lottie_animation_get_totalframe()
fps = a.lottie_animation_get_framerate() or 60.0
count = max(1, int(round(n / fps * out_fps)))
for i in range(count):
    f = min(n - 1, int(round(i * fps / out_fps)))
    buf = a.lottie_animation_render(f, width=w, height=h)
    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
    if scale and scale != w:
        img = img.resize((scale, scale), Image.LANCZOS)
    img.save(os.path.join(outdir, 'f_%04d.png' % i))
print('rendered', count, 'frames', w, 'x', h, '->', scale, 'at', out_fps, 'fps')
