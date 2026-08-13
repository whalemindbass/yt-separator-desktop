# 합성음의 어택이 실제로 존재하는지 검사한다.
#
# 검출기가 반복 타현을 놓치는 것을 두고 "검출기 문제"라고 말하려면,
# 먼저 그 자리에 검출할 만한 것이 있어야 한다. 각 정답 온셋 앞뒤의 에너지를 재서
# 새로 튕긴 흔적이 신호에 남아 있는지 본다.
import wave, struct, math, re, sys

wav_path, gt_path = sys.argv[1], sys.argv[2]

w = wave.open(wav_path, 'rb')
sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
raw = w.readframes(n); w.close()
x = [0.0] * n
for i in range(n):
    o = i * ch * sw
    x[i] = struct.unpack_from('<h', raw, o)[0] / 32768.0

NOTE = re.compile(r'^([A-G]#?)(-?\d+)$')
NUM = re.compile(r'^\d+(\.\d+)?$')
times, names = [], []
for ln in open(gt_path, encoding='utf-8'):
    if ln.strip().startswith('#'):
        continue
    tok = ln.split()
    if not tok:
        continue
    if all(NUM.match(t) for t in tok):
        times += [float(t) for t in tok]
    elif all(NOTE.match(t) for t in tok):
        names += tok

def rms(a, b):
    a, b = max(0, a), min(n, b)
    if b <= a:
        return 0.0
    return math.sqrt(sum(v * v for v in x[a:b]) / (b - a))

W = int(0.020 * sr)   # 20ms 창
rows = []
for i, t in enumerate(times):
    s = int(t * sr)
    before = rms(s - W, s)
    after = rms(s, s + W)
    ratio = after / before if before > 1e-6 else float('inf')
    gap = t - times[i - 1] if i else None
    same = (i > 0 and names[i] == names[i - 1])
    rows.append((i, t, gap, same, before, after, ratio))

fin = [r for r in rows if r[6] != float('inf')]
fin.sort(key=lambda r: r[6])
def pct(p):
    return fin[int(len(fin) * p)][6]

print(f'정답 {len(times)}음 · 20ms 창 에너지비(직후/직전)')
print(f'  중앙값 {pct(0.5):.2f} · 하위 10% {pct(0.1):.2f} · 상위 10% {pct(0.9):.2f}')

rep = [r for r in rows if r[3] and r[2] is not None and r[2] < 0.2]
oth = [r for r in rows if not (r[3] and r[2] is not None and r[2] < 0.2)]
def med(rs):
    v = sorted(r[6] for r in rs if r[6] != float('inf'))
    return v[len(v) // 2] if v else float('nan')
print(f'  같은 음 0.2초 이내 반복 {len(rep)}개 — 에너지비 중앙값 {med(rep):.2f}')
print(f'  그 밖 {len(oth)}개 — 에너지비 중앙값 {med(oth):.2f}')
weak = [r for r in rep if r[6] < 1.2]
print(f'  반복 중 에너지가 20% 도 안 오른 것 {len(weak)}개')
