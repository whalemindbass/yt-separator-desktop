# 옥타브 주법을 대역 에너지로 센다 — 피치 추적기를 쓰지 않는다.
#
# 디스코 옥타브 주법은 낮은 음(근음)과 그 한 옥타브 위를 번갈아 친다. 두 음은 대역이
# 갈리므로, 기본파가 아래 대역에 있는지 위 대역에 있는지만 보면 어느 쪽이 울리는지 알 수 있다.
# 피치 추적기(YIN·HPS)는 둘 다 옥타브를 틀리는 성향이 있어 이 판정에 쓸 수 없다 —
# 재려는 것 자체가 옥타브이기 때문이다.
#
# 판정 방법: 낮은 음이 울릴 때는 f0 가 저역에 있고 그 2배음이 고역에 같이 선다.
# 높은 음이 울릴 때는 저역에 기본파가 없다. 그래서 "저역 대비 고역" 비가 아니라
# 저역에 배음렬의 뿌리가 있는가를 본다.
#
#   python lab/tab/tools/octave.py <wav> [시작초] [길이초]

import sys
import wave

import numpy as np

path = sys.argv[1]
t0 = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
span = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0

with wave.open(path, 'rb') as w:
    sr, nch, n = w.getframerate(), w.getnchannels(), w.getnframes()
    start = int(t0 * sr)
    w.setpos(start)
    cnt = n - start if span <= 0 else min(int(span * sr), n - start)
    x = np.frombuffer(w.readframes(cnt), dtype='<i2').astype(np.float64) / 32768
if nch > 1:
    x = x.reshape(-1, nch).mean(1)

WIN, NFFT = 4096, 65536
HOP = int(sr * 0.010)
win = np.hanning(WIN)
freqs = np.fft.rfftfreq(NFFT, 1 / sr)

FLO, FHI = 30.0, 400.0
band = (freqs >= FLO) & (freqs <= FHI)
bf = freqs[band]

# 후보 f0 를 1/8 반음 간격으로 놓고 배음렬 점수를 매긴다.
cands = 30.0 * 2 ** (np.arange(0, 12 * 8 * 3.8) / (12 * 8))
cands = cands[cands < 300]
HARM = 6


def f0_of(seg):
    """배음렬 점수가 가장 높은 f0. 옥타브는 '위쪽을 우선'으로 가른다 —
    f0 의 2배가 점수의 대부분을 유지하면 낮은 쪽은 아래배음(subharmonic)일 뿐이다."""
    S = np.abs(np.fft.rfft(seg * win, NFFT))
    sc = np.zeros(len(cands))
    for k in range(1, HARM + 1):
        idx = np.searchsorted(freqs, cands * k)
        idx = np.clip(idx, 0, len(S) - 1)
        sc += S[idx] / k
    best = int(np.argmax(sc))
    top = sc[best]
    # 한 옥타브 위 후보가 거의 같은 점수면 그쪽이 진짜 기본파다
    up = np.searchsorted(cands, cands[best] * 2)
    if up < len(cands) and sc[up] > top * 0.80:
        best = int(np.argmax(sc[max(0, up - 4):min(len(sc), up + 5)])) + max(0, up - 4)
    return cands[best], top


rows = []
for i in range(0, len(x) - WIN, HOP):
    seg = x[i:i + WIN]
    rms = float(np.sqrt((seg ** 2).mean()))
    f, sc = f0_of(seg)
    rows.append((t0 + i / sr, rms, f))

gate = np.median([r[1] for r in rows]) * 0.40
midi = lambda f: 69 + 12 * np.log2(f / 440.0)

# 안정된 f0 가 이어지는 덩어리를 하나의 음으로 묶는다
events = []
cur = None
for t, rms, f in rows:
    m = round(midi(f))
    if rms < gate:
        cur = None
        continue
    if cur and abs(m - cur['midi']) <= 0 and t - cur['end'] < 0.05:
        cur['end'] = t
        continue
    cur = {'start': t, 'end': t, 'midi': m}
    events.append(cur)

events = [e for e in events if e['end'] - e['start'] >= 0.04]

NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
nm = lambda m: f'{NN[m % 12]}{m // 12 - 1}'

dur = len(x) / sr
print(f'{path}  {t0:.1f}~{t0+dur:.1f}초')
print(f'음 사건 {len(events)}개 · 초당 {len(events)/dur:.2f}')

jumps = sum(1 for a, b in zip(events, events[1:]) if b['midi'] - a['midi'] == 12)
downs = sum(1 for a, b in zip(events, events[1:]) if b['midi'] - a['midi'] == -12)
print(f'한 옥타브 위로 도약 {jumps}회 · 아래로 {downs}회  '
      f'(둘의 합 {jumps+downs} = 옥타브 주법의 실제 횟수)')

lens = sorted(e['end'] - e['start'] for e in events)
print(f'음 길이 중앙 {lens[len(lens)//2]*1000:.0f}ms · 짧은쪽 10% {lens[len(lens)//10]*1000:.0f}ms')

up_lens = sorted(b['end'] - b['start'] for a, b in zip(events, events[1:]) if b['midi'] - a['midi'] == 12)
if up_lens:
    print(f'옥타브 위 음만 보면 길이 중앙 {up_lens[len(up_lens)//2]*1000:.0f}ms '
          f'(짧을수록 짧은 창이 아니면 못 잡는다)')

if span and span <= 20:
    print('\n시각    음    길이')
    for e in events:
        print(f'{e["start"]:6.2f}  {nm(e["midi"]):4s}  {(e["end"]-e["start"])*1000:4.0f}ms')

# ── 이 정답지 자체를 검사한다 ────────────────────────────
# 앞서 세 번, 잣대를 재지 않고 결과를 읽어서 틀렸다. 이번에는 쓰기 전에 잰다.
# 검사 방법은 물리다: 주장하는 f0 가 맞다면 2·3·4배음이 서 있고, 1.5배(= 한 옥타브
# 아래 음의 3배음)는 없어야 한다. 있으면 진짜 기본파는 한 옥타브 아래다.
import random

random.seed(11)
sample = random.sample(events, min(40, len(events)))
ok = bad = 0
for e in sample:
    t = (e['start'] + min(e['end'], e['start'] + 0.12)) / 2
    i = int((t - t0) * sr)
    if i < 0 or i + WIN > len(x):
        continue
    S = np.abs(np.fft.rfft(x[i:i + WIN] * win, NFFT))
    f0 = 440.0 * 2 ** ((e['midi'] - 69) / 12)
    amp = lambda f: float(S[np.searchsorted(freqs, f)])
    h1, h2, h3 = amp(f0), amp(f0 * 2), amp(f0 * 3)
    odd = amp(f0 * 1.5)                 # 아래 옥타브가 진짜라면 여기가 선다
    if h1 <= 0:
        continue
    if odd > max(h1, h2) * 0.5:
        bad += 1
    else:
        ok += 1
print(f'\n정답지 자체 검사 — 무작위 {ok+bad}개')
print(f'  배음렬이 주장과 맞음 {ok} · 한 옥타브 아래가 진짜로 보임 {bad}')
print('  아래쪽이 많으면 이 정답지는 옥타브를 위로 틀린 것이고, 그대로 쓰면 안 된다.')

out = sys.argv[5] if len(sys.argv) > 5 else None
if out:
    with open(out, 'w', encoding='utf-8') as fp:
        fp.write('# 배음렬 점수로 뽑은 음 사건 — YIN 과 무관하다\n')
        fp.write(f'# {len(events)}개 · {path} · {t0:.1f}~{t0+dur:.1f}초\n')
        fp.write('# 시각(초)  MIDI  길이(초)\n')
        for e in events:
            fp.write(f'{e["start"]:.3f} {e["midi"]} {e["end"]-e["start"]:.3f}\n')
    print(f'\n저장: {out}')
