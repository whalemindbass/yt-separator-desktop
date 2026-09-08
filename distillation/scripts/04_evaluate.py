"""student vs teacher, (있으면) student/teacher vs 진짜 정답(MUSDB18) 비교.

측정 두 가지:
  1) 속도 — 청크당 추론 시간(ms), teacher(onnxruntime) vs student(torch), CPU/GPU
  2) 품질 — SDR(Source-to-Distortion Ratio)
     - vs teacher: distillation이 얼마나 잘 따라했는지 (val/test 청크의 .npz 라벨 사용)
     - vs 진짜 정답: MUSDB18 홀드아웃 몇 곡으로, teacher/student/원래 4-stem(있으면) 절대 품질 비교

결과는 results.json 하나로 저장 — viz/dashboard.html에서 그대로 불러와 본다.
SDR은 여기선 museval 없이 직접 계산하는 단순 버전(scale 보정 없는 순수 SDR)이다 —
논문 수준 벤치마크로 쓰려면 museval.evaluate()로 바꿀 것(BSSEval 표준).
"""
import argparse
import json
import pathlib
import time
from datetime import datetime, timezone

import numpy as np
import onnxruntime as ort
import torch

import importlib.util

_spec = importlib.util.spec_from_file_location('train_student', pathlib.Path(__file__).parent / '03_train_student.py')
_train_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_train_mod)
TinySeparator = _train_mod.TinySeparator


def sdr(pred: np.ndarray, target: np.ndarray) -> float:
    """단순 SDR(dB). pred/target: (channels, samples)."""
    noise = pred - target
    num = np.sum(target ** 2) + 1e-9
    den = np.sum(noise ** 2) + 1e-9
    return 10 * np.log10(num / den)


def bench_teacher_speed(model_path: str, sample: np.ndarray, n_runs: int, providers) -> float:
    sess = ort.InferenceSession(model_path, providers=providers)
    input_name = sess.get_inputs()[0].name
    x = sample[np.newaxis, ...].astype(np.float32)
    # 워밍업
    sess.run(None, {input_name: x})
    times = []
    for _ in range(n_runs):
        t0 = time.perf_counter()
        sess.run(None, {input_name: x})
        times.append(time.perf_counter() - t0)
    return float(np.mean(times) * 1000)  # ms


def bench_student_speed(model: torch.nn.Module, sample: torch.Tensor, n_runs: int) -> float:
    model.eval()
    with torch.no_grad():
        model(sample)  # 워밍업
        times = []
        for _ in range(n_runs):
            t0 = time.perf_counter()
            model(sample)
            times.append(time.perf_counter() - t0)
    return float(np.mean(times) * 1000)


def eval_vs_teacher(model, labels_dir, stem_names, device, max_chunks=200):
    files = sorted(pathlib.Path(labels_dir).glob('*.npz'))[:max_chunks]
    per_stem = {name: [] for name in stem_names}
    model.eval()
    with torch.no_grad():
        for f in files:
            d = np.load(f)
            mix = torch.from_numpy(d['mix'].astype(np.float32))[None].to(device)
            teacher_stems = d['stems'].astype(np.float32)  # (n_stems, 2, samples)
            pred = model(mix)[0].cpu().numpy()
            for i, name in enumerate(stem_names):
                per_stem[name].append(sdr(pred[i], teacher_stems[i]))
    return {name: float(np.mean(v)) for name, v in per_stem.items() if v}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--student-ckpt', required=True)
    ap.add_argument('--val-labels-dir', required=True, help='03에서 곡 단위로 뺀 val 라벨(.npz) 폴더')
    ap.add_argument('--teacher-model', default='../models/htdemucs_core.onnx')
    ap.add_argument('--baseline-model', default=None, help='비교할 원래 빠른 모델(있으면)')
    ap.add_argument('--musdb-dir', default=None, help='진짜 정답 비교용 MUSDB18 경로 (없으면 생략)')
    ap.add_argument('--out', default='results.json')
    ap.add_argument('--n-speed-runs', type=int, default=20)
    args = ap.parse_args()

    stem_names = ['drums', 'bass', 'other', 'vocals']
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    model = TinySeparator()
    model.load_state_dict(torch.load(args.student_ckpt, map_location=device))
    model.to(device)

    print('품질(vs teacher) 측정 중...')
    quality_vs_teacher = eval_vs_teacher(model, args.val_labels_dir, stem_names, device)

    print('속도 측정 중...')
    sample_len = 44100 * 12
    dummy_mix = np.random.randn(2, sample_len).astype(np.float32) * 0.1
    cpu_providers = ['CPUExecutionProvider']
    teacher_ms_cpu = bench_teacher_speed(args.teacher_model, dummy_mix, args.n_speed_runs, cpu_providers)
    student_sample = torch.from_numpy(dummy_mix)[None].to(device)
    student_ms = bench_student_speed(model, student_sample, args.n_speed_runs)

    speed = {
        'teacher_ms_per_chunk': {'cpu': teacher_ms_cpu},
        'student_ms_per_chunk': {device: student_ms},
    }
    try:
        gpu_providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        speed['teacher_ms_per_chunk']['gpu'] = bench_teacher_speed(args.teacher_model, dummy_mix, args.n_speed_runs, gpu_providers)
    except Exception:
        pass  # GPU 없으면 그냥 생략

    quality_vs_ground_truth = None
    if args.musdb_dir:
        print('MUSDB18 홀드아웃 절대 품질 비교는 musdb 패키지 연동이 필요 — TODO로 남겨둠')
        # TODO: musdb.DB(args.musdb_dir, subsets='test')로 곡 몇 개 불러와
        # teacher/student(및 baseline_model 있으면 그것도) 추론 후 진짜 stem과 SDR 비교.
        # 여기 붙일 때 quality_vs_ground_truth = {"teacher": {...}, "student": {...}, "baseline_fast": {...}}
        # 형태로 채워서 results.json에 실으면 dashboard.html이 그대로 그린다.

    results = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'device': device,
        'speed': speed,
        'quality_vs_teacher': quality_vs_teacher,
        'quality_vs_ground_truth': quality_vs_ground_truth,
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f'결과 저장: {args.out}')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
