# 놓친 옥타브 음 자리에서 두 가지 특징을 나란히 잰다.
#
#   (가) 로그 에너지 플럭스 — 지금 제품이 쓰는 것. 전체 세기가 얼마나 올랐나.
#   (나) 대역별 스펙트럴 플럭스 — 대역마다 오른 만큼만 더한다. 에너지가 한 대역에서
#        다른 대역으로 옮겨가기만 해도 값이 선다.
#
# 가설: 울리는 낮은 음 위에 그 옥타브를 치면 전체 세기는 거의 안 오르고 에너지가
# 옮겨갈 뿐이라, (가)로는 안 보이고 (나)로는 보인다. 맞는지 여기서 가른다.
# 맞으면 제품의 온셋 특징을 바꾸는 것이 답이고, 아니면 다른 데를 봐야 한다.
#
#   python lab/tab/tools/fluxprobe.py <wav> <사건정답지>

import sys
import wave

import numpy as np

wav, gtp = sys.argv[1], sys.argv[2]

with wave.open(wav, 'rb') as w:
    sr, nch, n = w.getframerate(), w.getnchannels(), w.getnframes()
    x = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float64) / 32768
if nch > 1:
    x = x.reshape(-1, nch).mean(1)

ev = []
for ln in open(gtp, encoding='utf-8'):
    if ln.startswith('#') or not ln.strip():
        continue
    t, m, d = ln.split()
    ev.append((float(t), int(m), float(d)))
ev.sort()

# ── 두 특징 ─────────────────────────────────────────────
WIN = int(sr * 0.020)           # 20ms — 지금 제품이 온셋에 쓰는 창과 같다
HOP = int(sr * 0.005)
NF = 2048
win = np.hanning(WIN)
frames = (len(x) - WIN) // HOP

mag = np.empty((frames, NF // 2 + 1))
eng = np.empty(frames)
for i in range(frames):
    seg = x[i * HOP:i * HOP + WIN]
    eng[i] = np.sqrt((seg ** 2).mean()) + 1e-9
    mag[i] = np.abs(np.fft.rfft(seg * win, NF))

freqs = np.fft.rfftfreq(NF, 1 / sr)
keep = (freqs >= 30) & (freqs <= 600)          # 베이스와 그 앞 배음들
mag = np.log1p(mag[:, keep] * 200)

energy_flux = np.diff(np.log(eng), prepend=np.log(eng[0]))
spec_flux = np.zeros(frames)
d = np.diff(mag, axis=0)
spec_flux[1:] = np.maximum(d, 0).sum(axis=1)   # 오른 대역만 더한다

zs = lambda a: (a - np.median(a)) / (np.median(np.abs(a - np.median(a))) + 1e-12)
ef, sf = zs(energy_flux), zs(spec_flux)

at = lambda t: int(np.clip(t * sr / HOP, 0, frames - 1))


def peak(a, t, back=0.015, fwd=0.045):
    i, j = at(t - back), at(t + fwd)
    return float(a[i:j + 1].max()) if j > i else 0.0


up = [i for i in range(1, len(ev)) if ev[i][1] - ev[i - 1][1] == 12]
rest = [i for i in range(1, len(ev)) if i not in set(up)]

print(f'{wav}  사건 {len(ev)}개 · 옥타브 위쪽 {len(up)}개')
print('\n온셋 자리에서의 봉우리 높이 (중앙값, 잡음 대비 배수)')
print('                         에너지 플럭스   대역별 스펙트럴 플럭스')
for name, idx in (('옥타브 위쪽 음', up), ('나머지 음    ', rest)):
    e = np.median([peak(ef, ev[i][0]) for i in idx])
    s = np.median([peak(sf, ev[i][0]) for i in idx])
    print(f'  {name}   {e:12.2f}   {s:16.2f}')

# 아무 소리 없는 자리의 값 — 이것보다 충분히 높아야 문턱을 세울 수 있다
rng = np.random.default_rng(3)
gaps = []
for _ in range(400):
    t = rng.uniform(0, len(x) / sr - 0.2)
    if min(abs(t - e[0]) for e in ev) > 0.20:
        gaps.append(t)
if gaps:
    e = np.median([peak(ef, t) for t in gaps])
    s = np.median([peak(sf, t) for t in gaps])
    print(f'  음이 없는 자리   {e:12.2f}   {s:16.2f}   <- 이보다 높아야 잡을 수 있다')

print('\n분리도 — 옥타브 위쪽 음의 봉우리가 빈 자리보다 얼마나 높은가')
for name, a in (('에너지 플럭스        ', ef), ('대역별 스펙트럴 플럭스', sf)):
    hit = np.array([peak(a, ev[i][0]) for i in up])
    non = np.array([peak(a, t) for t in gaps])
    thr = np.quantile(non, 0.95)               # 헛노트 5% 를 허용하는 문턱
    print(f'  {name}  그 문턱에서 옥타브 음 {100*(hit>thr).mean():5.1f}% 를 잡는다')
