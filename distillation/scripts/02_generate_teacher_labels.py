"""청크(wav) -> teacher(4-stem+) 추론 -> mix+stem 4개를 압축 저장(.npz, float16).

주의: htdemucs ONNX 내보내기마다 입력/출력 텐서 이름·형태가 다를 수 있다.
먼저 --inspect 로 실제 모델의 입출력을 확인하고, run_teacher() 안의
INPUT_NAME/전처리 부분을 거기 맞게 고칠 것 (README의 TODO 참고 —
"4-stem+"가 core 모델을 다른 설정으로 돌리는 건지도 먼저 확인해야 한다).
"""
import argparse
import pathlib
import time

import numpy as np
import onnxruntime as ort
import soundfile as sf

STEM_NAMES = ['drums', 'bass', 'other', 'vocals']  # 4-stem 기준. 6-stem이면 여기 갈아끼울 것


def inspect(model_path: str):
    sess = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    print('=== inputs ===')
    for i in sess.get_inputs():
        print(f'  {i.name}: {i.shape} ({i.type})')
    print('=== outputs ===')
    for o in sess.get_outputs():
        print(f'  {o.name}: {o.shape} ({o.type})')


def make_session(model_path: str, use_gpu: bool) -> ort.InferenceSession:
    providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if use_gpu else ['CPUExecutionProvider']
    return ort.InferenceSession(model_path, providers=providers)


def run_teacher(sess: ort.InferenceSession, mix: np.ndarray) -> np.ndarray:
    """mix: (2, samples) float32, -1..1 범위. 반환: (n_stems, 2, samples) float32.

    TODO: 실제 입력 텐서 이름/차원 순서(batch 축 필요 여부 등)를 --inspect 결과에
    맞게 고칠 것 — 아래는 흔한 htdemucs ONNX 내보내기 패턴을 가정한 자리표시자다.
    """
    input_name = sess.get_inputs()[0].name
    x = mix[np.newaxis, ...].astype(np.float32)  # (1, 2, samples) 가정
    out = sess.run(None, {input_name: x})[0]     # (1, n_stems, 2, samples) 가정
    return out[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chunks-dir', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--model', default='../models/htdemucs_core.onnx')
    ap.add_argument('--gpu', action='store_true')
    ap.add_argument('--inspect', action='store_true', help='입출력 텐서 정보만 찍고 종료')
    args = ap.parse_args()

    if args.inspect:
        inspect(args.model)
        return

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sess = make_session(args.model, args.gpu)

    chunks = sorted(pathlib.Path(args.chunks_dir).glob('*.wav'))
    print(f'청크 {len(chunks)}개 처리')

    times = []
    for i, p in enumerate(chunks):
        mix, sr = sf.read(str(p), dtype='float32')
        mix = mix.T if mix.ndim == 2 else np.stack([mix, mix])  # (2, samples)

        t0 = time.perf_counter()
        stems = run_teacher(sess, mix)
        times.append(time.perf_counter() - t0)

        out_path = out_dir / (p.stem + '.npz')
        np.savez_compressed(
            out_path,
            mix=mix.astype(np.float16),
            stems=stems.astype(np.float16),
            stem_names=np.array(STEM_NAMES),
            sr=sr,
        )
        if (i + 1) % 20 == 0:
            print(f'[{i + 1}/{len(chunks)}] 평균 추론 시간 {np.mean(times):.3f}s')

    print(f'완료. 라벨 {len(chunks)}개 -> {out_dir}')
    print(f'teacher 평균 추론 시간(청크당): {np.mean(times):.3f}s — 04_evaluate.py에서 student와 비교할 기준값')


if __name__ == '__main__':
    main()
