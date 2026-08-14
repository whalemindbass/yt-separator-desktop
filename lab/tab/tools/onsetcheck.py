# 손 표기 온셋의 건전성 검사 — 채점의 잣대로 쓰기 전에.
#
# 이 파일이 앞으로 온셋·타이밍 판정의 유일한 기준이 된다. 기존 정답지가 검출기에서
# 파생돼 쓸 수 없다는 것을 늦게 알았으므로, 이번에는 먼저 잰다. 특히 두 가지:
#   1) 곡 전체를 표기했는가, 아니면 앞부분만 하다 말았는가 (구간별 밀도)
#   2) 검출기 결과와 우연 이상으로 닮았는가 (닮았다면 또 순환이다)
#
#   python lab/tab/tools/onsetcheck.py

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GT = ROOT / 'lab' / 'tab' / 'ground-truth'


NUM = re.compile(r'^\d+\.\d+$')


def times(path):
    """숫자만 있는 줄을 시각으로 읽는다.

    손 표기 파일은 숫자만 있는 줄이 전부고, 탭 악보는 마디 블록 위의 시각 줄이 그렇다.
    탭 악보 쪽 시각은 소수 첫째 자리까지만 적혀 있다 — 아래 허용오차가 그래서 50ms 부터다.
    """
    out = []
    for ln in path.read_text(encoding='utf-8').splitlines():
        tok = ln.split()
        if not tok or ln.lstrip().startswith('#'):
            continue
        if all(NUM.match(t) for t in tok):
            out.extend(float(t) for t in tok)
    return sorted(out)


hand = times(GT / 'bass_sample.onsets.txt')
dur = 210.2

print(f'표기 {len(hand)}개 · 오디오 {dur}초 · 초당 {len(hand)/dur:.2f}')

# ── 1. 형태 ─────────────────────────────────────────────
back = [i for i in range(len(hand) - 1) if hand[i + 1] < hand[i]]
dup = [i for i in range(len(hand) - 1) if hand[i + 1] == hand[i]]
print(f'\n오름차순 아님 {len(back)} · 완전중복 {len(dup)} · 범위 {min(hand):.2f}~{max(hand):.2f}s')
if max(hand) > dur:
    print('  !! 오디오 길이를 넘는 표기가 있다')

gaps = sorted(hand[i + 1] - hand[i] for i in range(len(hand) - 1))
q = lambda p: gaps[int(len(gaps) * p)]
print(f'간격 최소 {gaps[0]:.3f} · 5% {q(.05):.3f} · 중앙 {q(.5):.3f} · 95% {q(.95):.3f} · 최대 {gaps[-1]:.3f}')
tight = sum(1 for g in gaps if g < 0.05)
if tight:
    print(f'  50ms 미만 간격 {tight}개 — 손떨림 중복일 수 있다')

# ── 2. 곡 전체를 덮는가 ──────────────────────────────────
# 앞부분만 표기하고 지쳤다면 뒤쪽 채점이 전부 "헛노트"로 잘못 읽힌다.
print('\n30초 구간별 밀도 (초당 표기 수):')
bad = []
for s in range(0, int(dur), 30):
    e = min(s + 30, dur)
    n = sum(1 for t in hand if s <= t < e)
    rate = n / (e - s)
    bar = '#' * int(rate * 8)
    print(f'  {s:3d}-{int(e):3d}s  {n:4d}  {rate:5.2f}  {bar}')
    if rate < 0.3:
        bad.append((s, rate))
if bad:
    print('  !! 비어 보이는 구간 있음 — 표기 누락인지 실제 쉼인지 오디오로 확인할 것')

# ── 3. 검출기와 독립인가 ────────────────────────────────
# 기존 정답지는 덤프에서 파생돼 시각이 100% 겹쳤다. 그것이 이 정답지의 존재 이유다.
dump = times(GT / 'bass_sample.raw-dump.txt')
old = times(GT / 'bass_sample.tab.txt')


def overlap(a, b, tol):
    j, hit = 0, 0
    for t in a:
        while j < len(b) and b[j] < t - tol:
            j += 1
        if j < len(b) and abs(b[j] - t) <= tol:
            hit += 1
    return hit


for name, ref in (('검출기 덤프', dump), ('기존 정답지', old)):
    if not ref:
        continue
    print(f'\n{name} {len(ref)}음 대비 (저쪽 시각은 0.1초 단위 반올림)')
    for tol in (0.050, 0.080, 0.120, 0.200):
        h = overlap(hand, ref, tol)
        print(f'  ±{int(tol*1000):3d}ms  {h:4d}/{len(hand)}  {100*h/len(hand):5.1f}%')

# 파생이라면 ±50ms(= 반올림 폭의 절반) 안에 거의 전부가 들어온다. 손으로 찍었다면
# 대략 맞되 그만큼 딱 붙지는 않는다. 우연 수준도 같이 재서 비교한다.
if dump:
    import random
    random.seed(7)
    fake = sorted(random.uniform(0, dur) for _ in hand)
    print(f'\n같은 개수를 무작위로 뿌렸을 때 ±50ms  {100*overlap(fake, dump, .05)/len(hand):5.1f}%'
          f'  (우연 수준)')
