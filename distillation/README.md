# 스템 분리 모델 Distillation 실험

## 왜

이 앱의 스템 분리는 htdemucs(오픈소스, 사전학습됨)를 ONNX로 돌린다 —
`4-stem`(빠름) / `4-stem+`(느리지만 정확) / `6-stem` 세 티어가 이미 있다.
직접 모델을 처음부터 학습시키는 건 개인 스케일에서 불가능하지만(대량 정제된
멀티트랙 데이터 + GPU 클러스터 필요), **이미 있는 두 티어 사이를
distillation으로 좁히는 건** 개인 스케일에서 시도할 수 있는 실험이다.

- **Teacher**: `4-stem+`(정확도 높은 느린 설정)
- **Student**: `4-stem`과 같은 빠른 아키텍처(또는 그보다 더 가벼운 구조) —
  teacher의 출력을 정답 삼아 다시 학습해서 "빠른 모델이 느린 모델 품질에
  얼마나 가까워지는지" 확인한다.

Distillation이라 진짜 정답 stem(원본 멀티트랙)이 없어도 된다 — teacher가
그 자리에서 라벨을 만들어준다. 필요한 건 다양한 완성 음원(믹스) 대량뿐.

## TODO (실행 전에 확인할 것)

- [ ] `4-stem+`가 실제로 `models/htdemucs_core.onnx`를 다른 설정(예: test-time
      shift 앙상블)으로 돌리는 건지, 아니면 별도 가중치 파일인지 `renderer/scripts/separator.js`
      / 워커 쪽을 다시 확인하고 `scripts/02_generate_teacher_labels.py`의
      `TEACHER_CONFIG`를 실제 값으로 맞출 것. 지금은 추정으로 비워둠.
- [ ] 입력 음원 라이선스 — CC 데이터셋(FMA, MTG-Jamendo)이나 MUSDB18 믹스만
      쓸 것. 저작권 있는 실제 K-pop 음원은 로컬 개인 실험 범위를 넘기지 말 것.

## 파이프라인

```
01_chunk_audio.py            원본 음원 → 무음 필터링된 고정 길이 청크(wav)
02_generate_teacher_labels.py 청크마다 teacher(4-stem+) 추론 → mix+stem 4개를 압축 저장(.npz, float16)
03_train_student.py          student 모델을 teacher 라벨로 학습(L1 + STFT loss)
04_evaluate.py               student vs teacher, student vs 진짜 정답(MUSDB18 홀드아웃) SDR +
                              추론 속도(CPU/GPU) 측정 → results.json 저장
```

`results.json`은 `viz/dashboard.html`(더블클릭으로 브라우저에서 열기)에
불러오면 속도·품질 비교 그래프로 볼 수 있다.

## 실행

```bash
pip install -r requirements.txt
python scripts/01_chunk_audio.py --in-dir <원본 음원 폴더> --out-dir data/chunks
python scripts/02_generate_teacher_labels.py --chunks-dir data/chunks --out-dir data/labels
python scripts/03_train_student.py --labels-dir data/labels --out-dir runs/exp1
python scripts/04_evaluate.py --student-ckpt runs/exp1/best.pt --musdb-dir <MUSDB18 경로> --out results.json
```
