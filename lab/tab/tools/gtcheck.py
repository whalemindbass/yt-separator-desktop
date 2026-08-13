# 정답지의 시각 복원이 믿을 만한지 검사한다.
#
# 옛 덤프는 시각 열 폭이 고정이라 100초를 넘으면 백의 자리가 잘렸다(104.8 -> 04.8).
# 파서는 "시각은 반드시 증가한다"는 가정으로 줄어들면 100 을 더해 되돌린다.
# 그 가정이 깨지는 자리가 있으면 그 구간은 통째로 100초 어긋난 채 채점된다.
import re, sys

NOTE = re.compile(r'^[A-G]#?-?\d+$')
NUM = re.compile(r'^\d+(\.\d+)?$')

times, names = [], []
for ln in open(sys.argv[1], encoding='utf-8'):
    if ln.strip().startswith('#'):
        continue
    tok = ln.split()
    if not tok:
        continue
    if all(NUM.match(t) for t in tok):
        times += [float(t) for t in tok]
    elif all(NOTE.match(t) for t in tok):
        names += tok

# score.html 과 같은 복원
base, prev, fixed = 0.0, -1.0, []
wraps = []
for i, t in enumerate(times):
    v = t + base
    while v < prev:
        base += 100
        v = t + base
        wraps.append(i)
    prev = v
    fixed.append(v)

print(f'음 {len(times)}개 · 이름 {len(names)}개')
print(f'원본 범위 {min(times):.1f} ~ {max(times):.1f}')
print(f'복원 범위 {fixed[0]:.1f} ~ {fixed[-1]:.1f}  (곡 길이 210.2s)')
print(f'100 을 더한 지점 {len(wraps)}곳: {wraps}')

# 복원 뒤 간격 — 음악이라면 대부분 0.1~2초다. 비정상적으로 큰 도약은 복원 실패 신호다.
gaps = [(fixed[i + 1] - fixed[i], i) for i in range(len(fixed) - 1)]
big = [g for g in gaps if g[0] > 5]
print(f'5초 넘는 간격 {len(big)}곳: ' + ', '.join(f'{g:.1f}s@{i}' for g, i in big[:12]))
neg = [g for g in gaps if g[0] < 0]
print(f'역행 {len(neg)}곳')

# 같은 시각이 여러 번 (동시 타현) — 복원 규칙이 '줄어들면' 이므로 같은 값은 안전
same = sum(1 for g, _ in gaps if g == 0)
print(f'같은 시각 {same}쌍')
