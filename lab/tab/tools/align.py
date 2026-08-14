# 손 표기 · 검출기 · 실제 오디오 어택, 셋이 어디에 놓이는지 잰다.
#
# 손 표기와 검출기 덤프가 중앙 73ms 어긋났다. 둘 중 어느 쪽이 옳은지는 서로 비교해서는
# 알 수 없다 — 오디오에 물어봐야 한다. 여기서는 표기 근처의 실제 에너지 상승 지점을 찾아
# 양쪽과 견준다. 오디오가 손 표기 쪽에 붙으면 검출기가 이르게 찍는 것이고,
# 덤프 쪽에 붙으면 표기가 늦은 것이다.
#
#   python lab/tab/tools/align.py

import bisect
import re
import statistics as st
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
GT = ROOT / 'lab' / 'tab' / 'ground-truth'
WAV = ROOT / 'bass_sample.wav'

NUM = re.compile(r'^\d+\.\d+$')


def times(path):
    out = []
    for ln in path.read_text(encoding='utf-8').splitlines():
        tok = ln.split()
        if not tok or ln.lstrip().startswith('#'):
            continue
        if all(NUM.match(t) for t in tok):
            out.extend(float(t) for t in tok)
    return sorted(out)


# ── 오디오 → 짧은 창 에너지 포락선 ──────────────────────
# 창을 10ms 로 잡는다. 제품이 쓰는 93ms 피치 창은 5~20ms 짜리 어택을 평균으로 뭉갠다.
with wave.open(str(WAV), 'rb') as w:
    sr, nch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    raw = w.readframes(n)

assert sw == 2, f'16비트가 아니다: {sw*8}비트'
x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
if nch > 1:
    x = x.reshape(-1, nch).mean(axis=1)

HOP = int(sr * 0.002)          # 2ms — 73ms 를 판정하려면 이보다 촘촘해야 한다
WIN = int(sr * 0.010)
frames = (len(x) - WIN) // HOP
env = np.sqrt(np.array([
    float(np.mean(x[i * HOP: i * HOP + WIN] ** 2)) for i in range(frames)
], dtype=np.float64) + 1e-12)
lg = np.log(env)
t_of = lambda i: (i * HOP + WIN / 2) / sr

print(f'{WAV.name}  {sr}Hz {nch}ch  {len(x)/sr:.1f}초 · 포락선 {frames}프레임 (2ms 간격)')

hand = times(GT / 'bass_sample.onsets.txt')
dump = times(GT / 'bass_sample.raw-dump.txt')


def attack_near(anchor, half):
    """anchor 를 가운데 둔 창에서 로그 에너지가 가장 가파르게 오르는 지점.

    창은 반드시 대칭이어야 한다. 앞뒤 길이가 다르면 그 자체가 어택 추정을 한쪽으로 밀어서,
    재려던 편향을 도구가 만들어 낸다. 그리고 anchor 는 손 표기도 덤프도 아닌 둘의 중점으로
    잡는다 — 어느 한쪽에 anchor 를 두면 그쪽이 유리해진다.
    """
    a = max(0, int((anchor - half) * sr / HOP))
    b = min(frames - 1, int((anchor + half) * sr / HOP))
    if b - a < 6:
        return None
    d = np.diff(lg[a:b])
    k = int(np.argmax(np.convolve(d, np.ones(3) / 3, mode='same')))
    return t_of(a + k)


def nearest(t, arr):
    i = bisect.bisect_left(arr, t)
    c = [arr[j] for j in (i - 1, i) if 0 <= j < len(arr)]
    return min(c, key=lambda v: abs(v - t)) if c else None


pairs = []
for h in hand:
    d = nearest(h, dump)
    if d is not None and abs(d - h) <= 0.25:   # 짝을 못 찾은 표기는 이 비교에서 뺀다
        pairs.append((h, d))
print(f'\n짝지어진 표기 {len(pairs)} / {len(hand)}')

pct = lambda v, p: sorted(v)[int(len(v) * p)]

print('\n창 반폭을 바꿔가며 — 결론이 창에 따라 뒤집히면 그 결론은 도구가 만든 것이다')
print('  반폭   어택-손표기 (중앙/IQR폭)    어택-덤프 (중앙/IQR폭)    손표기가 더 가까움')
for half in (0.06, 0.08, 0.10, 0.15):
    rows = [(h, d, attack_near((h + d) / 2, half)) for h, d in pairs]
    rows = [r for r in rows if r[2] is not None]
    hd = [a - h for h, d, a in rows]
    dd = [a - d for h, d, a in rows]
    near_hand = sum(1 for h, d, a in rows if abs(a - h) < abs(a - d))
    print(f'  {half*1000:3.0f}ms  {st.median(hd):+.3f} / {pct(hd,.75)-pct(hd,.25):.3f}'
          f'            {st.median(dd):+.3f} / {pct(dd,.75)-pct(dd,.25):.3f}'
          f'          {100*near_hand/len(rows):4.0f}%')

print('\n중앙값 = 계통 오차(상수면 빼면 그만) · IQR폭 = 흔들림(못 고친다)')
print('덤프 시각은 파일에 0.1초 단위로 적혀 있어 IQR 에 약 50ms 가 얹혀 있다.')
