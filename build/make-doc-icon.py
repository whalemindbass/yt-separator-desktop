# .yssproj 파일 아이콘 생성기 — 문서 모양 가운데에 앱 마크.
#
#   python build/make-doc-icon.py
#
# 크기마다 그리는 정도를 달리한다. 16px 에서 접힌 모서리까지 그리면 뭉개져서
# 무엇인지 알아볼 수 없다. 작은 크기는 마크를 크게 두고 장식을 뺀다.
# 각 크기는 4배로 그린 뒤 줄여 가장자리를 정리한다.

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon.png')
OUT = os.path.join(HERE, 'yssproj.ico')

PAGE = (255, 255, 255, 255)
EDGE = (198, 210, 206, 255)      # 앱의 중립색과 같은 계열 — 순회색은 붙여 놓으면 튄다
FOLD = (223, 231, 228, 255)
SHADOW = (16, 26, 23, 38)

SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

app = Image.open(SRC).convert('RGBA')


def render(size):
    S = 4                                  # 슈퍼샘플링 배수
    W = size * S
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    small = size < 32
    # 페이지 비율 4:5. 작은 크기는 여백을 줄여 면적을 벌어 준다.
    margin_x = W * (0.13 if small else 0.16)
    margin_y = W * (0.07 if small else 0.06)
    x0, y0 = margin_x, margin_y
    x1, y1 = W - margin_x, W - margin_y
    r = W * (0.05 if small else 0.06)
    fold = 0 if small else (x1 - x0) * 0.30

    if not small:                          # 종이 아래 옅은 그림자
        d.rounded_rectangle([x0 + W * .012, y0 + W * .016, x1 + W * .012, y1 + W * .016],
                            radius=r, fill=SHADOW)

    if fold:
        # 오른쪽 위가 접힌 문서 — 접힌 만큼 모서리를 깎아 낸 다각형
        d.polygon([(x0 + r, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1 - r),
                   (x1 - r, y1), (x0 + r, y1), (x0, y1 - r), (x0, y0 + r)],
                  fill=PAGE, outline=EDGE, width=max(1, int(W * 0.008)))
        d.polygon([(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)],
                  fill=FOLD, outline=EDGE, width=max(1, int(W * 0.008)))
    else:
        d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=PAGE,
                            outline=EDGE, width=max(1, int(W * 0.012)))

    # 가운데 마크. 작은 크기일수록 크게 — 안 그러면 무엇인지 안 보인다.
    frac = 0.74 if small else 0.56
    mw = int((x1 - x0) * frac)
    mark = app.resize((mw, mw), Image.LANCZOS)
    mx = int(x0 + ((x1 - x0) - mw) / 2)
    my = int(y0 + ((y1 - y0) - mw) / 2 + (0 if small else W * 0.02))
    im.alpha_composite(mark, (mx, my))

    return im.resize((size, size), Image.LANCZOS)


frames = [render(s) for s in SIZES]
frames[-1].save(OUT, format='ICO', sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
print('생성:', OUT)

# 눈으로 확인할 미리보기 — 실제 크기 그대로 나열
strip_sizes = [16, 24, 32, 48, 64, 128]
gap = 8
width = sum(strip_sizes) + gap * (len(strip_sizes) + 1)
strip = Image.new('RGBA', (width, 128 + gap * 2), (245, 247, 246, 255))
x = gap
for s in strip_sizes:
    f = render(s)
    strip.alpha_composite(f, (x, gap + (128 - s) // 2))
    x += s + gap
strip.save(os.path.join(HERE, 'yssproj-preview.png'))
print('미리보기:', os.path.join(HERE, 'yssproj-preview.png'))
