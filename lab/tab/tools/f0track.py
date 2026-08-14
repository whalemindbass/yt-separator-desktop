# 오디오의 f0 를 검출기와 무관하게 훑는다.
#
# tab-core 의 YIN 이 옥타브를 접는지 아닌지는 YIN 으로 재서는 알 수 없다.
# 여기서는 조화곱 스펙트럼(HPS)으로 따로 뽑는다 — 방식이 달라야 견줄 수 있다.
# HPS 는 배음이 겹치는 자리를 곱으로 눌러서 기본파를 세우므로 옥타브 위쪽으로 틀리는
# 성향이 YIN 과 반대다. 둘이 같은 말을 하면 믿고, 다르면 거기가 볼 자리다.
#
#   python lab/tab/tools/f0track.py <wav> [시작초] [길이초]

import sys
import wave

import numpy as np

path = sys.argv[1]
t0 = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
span = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0

with wave.open(path, 'rb') as w:
    sr, nch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    w.setpos(int(t0 * sr))
    raw = w.readframes(min(int(span * sr), n - int(t0 * sr)))

x = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768
if nch > 1:
    x = x.reshape(-1, nch).mean(1)

# 창이 길면 저음 해상도는 좋아지지만 8분음표(120BPM 에서 250ms)를 뭉갠다.
# 옥타브 주법을 보려면 한 음 안에 창이 여러 번 들어가야 한다.
WIN = int(sys.argv[4]) if len(sys.argv) > 4 else 4096
HOP = int(sr * 0.010)
NFFT = 32768        # 영채움 — 40Hz 근처에서 반음을 가르려면 성글면 안 된다
win = np.hanning(WIN)
freqs = np.fft.rfftfreq(NFFT, 1 / sr)

FMIN, FMAX = 30.0, 400.0
lo = np.searchsorted(freqs, FMIN)
hi = np.searchsorted(freqs, FMAX)

rows = []
for i in range(0, len(x) - WIN, HOP):
    seg = x[i:i + WIN] * win
    rms = float(np.sqrt((seg ** 2).mean()))
    S = np.abs(np.fft.rfft(seg, NFFT))
    # 조화곱 — 2·3·4배음 자리를 끌어와 곱한다. 기본파에서만 전부 살아남는다.
    hps = S[lo:hi].copy()
    for k in (2, 3, 4):
        idx = (np.arange(lo, hi) * k)
        idx = np.clip(idx, 0, len(S) - 1)
        hps *= S[idx]
    j = int(np.argmax(hps))
    f = freqs[lo + j]
    midi = 69 + 12 * np.log2(f / 440.0) if f > 0 else 0
    rows.append((t0 + i / sr, rms, f, midi))

NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
name = lambda m: f'{NN[int(round(m)) % 12]}{int(round(m)) // 12 - 1}'

gate = np.median([r[1] for r in rows]) * 0.35
print(f'{path}  {t0:.1f}~{t0+span:.1f}s  · 20ms 간격 · 게이트 {gate:.4f}')
print('시각    음      MIDI   Hz     세기')
prev = None
for t, rms, f, m in rows:
    if rms < gate:
        prev = None
        continue
    r = int(round(m))
    mark = ''
    if prev is not None:
        d = r - prev
        if abs(d) == 12:
            mark = '  <= 옥타브 도약'
        elif d != 0:
            mark = f'  ({d:+d})'
    print(f'{t:6.2f}  {name(m):4s}  {r:4d}  {f:6.1f}  {rms:.3f}{mark}')
    prev = r
