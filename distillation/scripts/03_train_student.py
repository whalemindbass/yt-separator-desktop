"""teacher 라벨(.npz)로 student 모델을 distillation 학습.

student 아키텍처는 자리표시자(작은 Conv1D U-Net)다 — 처음 실험은 이걸로
방향성만 확인하고, 진짜로 "4-stem 아키텍처를 그대로 재학습"하고 싶으면
htdemucs의 경량 버전(demucs 공식 레포의 --repo 옵션들)으로 바꿔 낄 것.

손실 = L1(파형) + multi-resolution STFT loss. Demucs 계열이 실제로 쓰는
조합과 같은 방식이라, 나중에 "왜 이 loss를 골랐냐"는 질문에 근거 있게 답할 수 있다.
"""
import argparse
import pathlib
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset


# ── student 모델 (자리표시자) ────────────────────────────────
class ConvBlock(nn.Module):
    def __init__(self, c_in, c_out, stride):
        super().__init__()
        self.conv = nn.Conv1d(c_in, c_out, kernel_size=8, stride=stride, padding=2)
        self.act = nn.GELU()

    def forward(self, x):
        return self.act(self.conv(x))


class DeconvBlock(nn.Module):
    def __init__(self, c_in, c_out, stride):
        super().__init__()
        self.deconv = nn.ConvTranspose1d(c_in, c_out, kernel_size=8, stride=stride, padding=2)
        self.act = nn.GELU()

    def forward(self, x):
        return self.act(self.deconv(x))


class TinySeparator(nn.Module):
    """작은 encoder-decoder — 진짜 student로 쓰기엔 소박하지만 파이프라인
    검증(distillation이 실제로 loss를 줄이는지)엔 충분하다."""

    def __init__(self, n_stems=4, base=32):
        super().__init__()
        self.enc = nn.ModuleList([
            ConvBlock(2, base, 4),
            ConvBlock(base, base * 2, 4),
            ConvBlock(base * 2, base * 4, 4),
        ])
        self.dec = nn.ModuleList([
            DeconvBlock(base * 4, base * 2, 4),
            DeconvBlock(base * 2, base, 4),
            DeconvBlock(base, 2 * n_stems, 4),
        ])
        self.n_stems = n_stems

    def forward(self, x):
        skips = []
        h = x
        for layer in self.enc:
            h = layer(h)
            skips.append(h)
        for layer in self.dec:
            h = layer(h)
        # 길이 안 맞으면 입력 길이에 맞춰 자르거나 패딩
        if h.shape[-1] > x.shape[-1]:
            h = h[..., :x.shape[-1]]
        elif h.shape[-1] < x.shape[-1]:
            h = F.pad(h, (0, x.shape[-1] - h.shape[-1]))
        b = h.shape[0]
        return h.view(b, self.n_stems, 2, -1)


# ── 데이터셋 ──────────────────────────────────────────────
class TeacherLabelDataset(Dataset):
    def __init__(self, files):
        self.files = files

    def __len__(self):
        return len(self.files)

    def __getitem__(self, idx):
        d = np.load(self.files[idx])
        mix = d['mix'].astype(np.float32)      # (2, samples)
        stems = d['stems'].astype(np.float32)  # (n_stems, 2, samples)
        return torch.from_numpy(mix), torch.from_numpy(stems)


def split_by_song(files, val_ratio=0.1, test_ratio=0.1, seed=0):
    """청크가 아니라 곡(파일명의 __chunk 앞부분) 단위로 스플릿 — 리키지 방지."""
    songs = sorted({f.name.split('__chunk')[0] for f in files})
    rng = random.Random(seed)
    rng.shuffle(songs)
    n_val = max(1, int(len(songs) * val_ratio))
    n_test = max(1, int(len(songs) * test_ratio))
    val_songs = set(songs[:n_val])
    test_songs = set(songs[n_val:n_val + n_test])
    train, val, test = [], [], []
    for f in files:
        song = f.name.split('__chunk')[0]
        (val if song in val_songs else test if song in test_songs else train).append(f)
    return train, val, test


# ── loss ──────────────────────────────────────────────────
def stft_loss(pred, target, n_fft=1024, hop=256):
    pred_f = pred.reshape(-1, pred.shape[-1])
    target_f = target.reshape(-1, target.shape[-1])
    window = torch.hann_window(n_fft, device=pred.device)
    p = torch.stft(pred_f, n_fft, hop, window=window, return_complex=True).abs()
    t = torch.stft(target_f, n_fft, hop, window=window, return_complex=True).abs()
    return F.l1_loss(p, t)


def distill_loss(pred, target):
    return F.l1_loss(pred, target) + 0.5 * stft_loss(pred, target)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--labels-dir', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--batch-size', type=int, default=8)
    ap.add_argument('--lr', type=float, default=3e-4)
    args = ap.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(pathlib.Path(args.labels_dir).glob('*.npz'))
    train_f, val_f, _test_f = split_by_song(files)
    print(f'train {len(train_f)} / val {len(val_f)} 청크 (곡 단위 스플릿)')

    train_ds = TeacherLabelDataset(train_f)
    val_ds = TeacherLabelDataset(val_f)
    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=2)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=2)

    model = TinySeparator().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)

    best_val = float('inf')
    for epoch in range(args.epochs):
        model.train()
        train_loss = 0.0
        for mix, stems in train_dl:
            mix, stems = mix.to(device), stems.to(device)
            pred = model(mix)
            loss = distill_loss(pred, stems)
            opt.zero_grad()
            loss.backward()
            opt.step()
            train_loss += loss.item() * mix.size(0)
        train_loss /= len(train_ds)

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for mix, stems in val_dl:
                mix, stems = mix.to(device), stems.to(device)
                pred = model(mix)
                val_loss += distill_loss(pred, stems).item() * mix.size(0)
        val_loss /= max(1, len(val_ds))

        print(f'epoch {epoch + 1}/{args.epochs}  train {train_loss:.4f}  val {val_loss:.4f}')
        if val_loss < best_val:
            best_val = val_loss
            torch.save(model.state_dict(), out_dir / 'best.pt')

    print(f'완료. best val loss {best_val:.4f} -> {out_dir / "best.pt"}')


if __name__ == '__main__':
    main()
