"""원본 음원(mp3/wav/...) 폴더 -> 무음 걸러낸 고정 길이 청크(wav, 44.1kHz 스테레오).

곡 단위로 파일명을 남겨서(나중에 곡 단위로 train/val/test 스플릿할 수 있게)
청크 파일명은 "<원본곡이름>__chunk<번호>.wav" 형태로 저장한다.
"""
import argparse
import pathlib

import librosa
import numpy as np
import soundfile as sf

SR = 44100
CHUNK_SEC = 12.0          # student 모델 receptive field에 맞춰 조정할 것
SILENCE_RMS_DB = -45.0    # 이보다 조용한 청크는 학습에 낭비라 버린다


def is_silent(chunk: np.ndarray) -> bool:
    rms = np.sqrt(np.mean(chunk ** 2) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    return db < SILENCE_RMS_DB


def chunk_one(path: pathlib.Path, out_dir: pathlib.Path) -> int:
    y, _ = librosa.load(str(path), sr=SR, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])  # 모노 -> 가짜 스테레오
    n_samples = y.shape[1]
    chunk_len = int(CHUNK_SEC * SR)
    n_chunks = n_samples // chunk_len
    stem = path.stem
    saved = 0
    for i in range(n_chunks):
        c = y[:, i * chunk_len:(i + 1) * chunk_len]
        if is_silent(c):
            continue
        out_path = out_dir / f"{stem}__chunk{i:04d}.wav"
        sf.write(str(out_path), c.T, SR)
        saved += 1
    return saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in-dir', required=True)
    ap.add_argument('--out-dir', required=True)
    args = ap.parse_args()

    in_dir = pathlib.Path(args.in_dir)
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    exts = {'.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus'}
    files = [p for p in in_dir.rglob('*') if p.suffix.lower() in exts]
    print(f'입력 곡 {len(files)}개')

    total = 0
    for i, p in enumerate(files):
        try:
            n = chunk_one(p, out_dir)
            total += n
            print(f'[{i + 1}/{len(files)}] {p.name} -> 청크 {n}개')
        except Exception as e:
            print(f'[{i + 1}/{len(files)}] {p.name} 실패: {e}')

    print(f'총 청크 {total}개 -> {out_dir}')


if __name__ == '__main__':
    main()
