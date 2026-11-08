# 生成 QQ 桥接桌面版的图标：蓝色纵向渐变 + 白色 q + 箭头
from PIL import Image, ImageDraw, ImageFont

SIZE = 256
RADIUS = 60

# 纵向渐变：#3b82f6 -> #2563eb
gradient = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
g = ImageDraw.Draw(gradient)
for y in range(SIZE):
    ratio = y / (SIZE - 1)
    r = int(59 + (37 - 59) * ratio)
    gr = int(130 + (99 - 130) * ratio)
    b = int(246 + (235 - 246) * ratio)
    g.line([(0, y), (SIZE, y)], fill=(r, gr, b, 255))

# 圆角遮罩
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
img.paste(gradient, (0, 0), mask)

d = ImageDraw.Draw(img)
WHITE = (255, 255, 255, 255)

# 白色 q
font = None
for path in (r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"):
    try:
        font = ImageFont.truetype(path, 170)
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()

bbox = d.textbbox((0, 0), "q", font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((SIZE - tw) / 2 - bbox[0] - 20, (SIZE - th) / 2 - bbox[1] + 8), "q", font=font, fill=WHITE)

# 右上角箭头 ↗（圆头线 + 三角）
d.line([(168, 96), (206, 58)], fill=WHITE, width=18)
d.line([(168, 96), (206, 58)], fill=WHITE, width=18)
d.polygon([(212, 50), (176, 56), (206, 86)], fill=WHITE)

out = r"D:\DSH 插件\QQ桥接桌面版\resources\app\icon.ico"
img.save(out, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save(r"D:\DSH 插件\QQ桥接桌面版\resources\app\icon-preview.png", format='PNG')
print("done")
