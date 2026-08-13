# score.html 과 같은 규칙으로 두 TAB 텍스트를 채점한다.
#   python gtscore.py <정답지> <검출덤프>
# 문서에 남은 "580 검출 / 87% / 잉여 0" 이 이 조합에서 나온 것인지 확인하기 위한 것이다.
import re, sys

NOTE = re.compile(r'^([A-G]#?)(-?\d+)$')
NUM = re.compile(r'^\d+(\.\d+)?$')
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def midi(s):
    m = NOTE.match(s)
    return (int(m.group(2)) + 1) * 12 + NAMES.index(m.group(1))


def parse(path):
    times, names = [], []
    for ln in open(path, encoding='utf-8'):
        if ln.strip().startswith('#'):
            continue
        tok = ln.split()
        if not tok:
            continue
        if all(NUM.match(t) for t in tok):
            times += [float(t) for t in tok]
        elif all(NOTE.match(t) for t in tok):
            names += tok
    base, prev, fixed = 0.0, -1.0, []
    for t in times:
        v = t + base
        while v < prev:
            base += 100
            v = t + base
        prev = v
        fixed.append(v)
    n = min(len(fixed), len(names))
    return [{'start': fixed[i], 'midi': midi(names[i])} for i in range(n)]


def score(gt, det, tol=0.25, octave_lenient=False):
    used, hit, wrong, miss = set(), 0, 0, 0
    for g in gt:
        best, bd = -1, 1e9
        for i, d in enumerate(det):
            if i in used:
                continue
            dt = abs(d['start'] - g['start'])
            if dt < bd and dt <= tol:
                bd, best = dt, i
        if best < 0:
            miss += 1
            continue
        used.add(best)
        ok = ((det[best]['midi'] - g['midi']) % 12 == 0) if octave_lenient else (det[best]['midi'] == g['midi'])
        if ok:
            hit += 1
        else:
            wrong += 1
    return hit, wrong, miss, len(det) - len(used)


gt = parse(sys.argv[1])
det = parse(sys.argv[2])
h, w, m, e = score(gt, det)
ho = score(gt, det, octave_lenient=True)[0]
print(f'정답지 {len(gt)}음 · 검출 {len(det)}음')
print(f'일치 {h} ({round(h / len(gt) * 100)}%) · 음정오류 {w} · 놓침 {m} · 잉여 {e} · 옥타브무시 {round(ho / len(gt) * 100)}%')
