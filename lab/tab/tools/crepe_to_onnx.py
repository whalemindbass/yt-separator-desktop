"""CREPE(marl/crepe, MIT) Keras 가중치를 ONNX 로 변환한다.

    python lab/tab/tools/crepe_to_onnx.py <capacity> <출력경로>
    python lab/tab/tools/crepe_to_onnx.py full renderer/models/crepe-full.onnx

marl/crepe 는 아직 공식 ONNX 내보내기가 main 에 머지되지 않았다(PR #105, 2025-04 오픈·미병합).
그 PR 코드에 기대는 대신, 이미 설치된 crepe 패키지(pip install crepe, MIT)의 Keras 모델을
tf2onnx 로 직접 변환한다 — 같은 결과를 우리가 검증할 수 있는 방식으로 얻는다.
"""
import sys
import numpy as np
import tensorflow as tf
import tf2onnx

CAPACITY = sys.argv[1] if len(sys.argv) > 1 else 'full'
OUT = sys.argv[2] if len(sys.argv) > 2 else f'model-{CAPACITY}.onnx'

# crepe.core 는 import 시점에 모델을 안 만든다 — build_and_load_model() 을 직접 부른다.
from crepe.core import build_and_load_model  # noqa: E402

model = build_and_load_model(CAPACITY)
print('입력', model.input_shape, '출력', model.output_shape, '· 입력 텐서 이름:', model.input.name)

spec = (tf.TensorSpec((None, 1024), tf.float32, name='input'),)
model_proto, _ = tf2onnx.convert.from_keras(model, input_signature=spec, output_path=OUT, opset=13)
print('저장:', OUT)

# 검증 — crepe.core 와 같은 정규화·같은 cents→Hz 공식으로 순음을 넣어 검출 Hz 가 실제와
# 맞는지 확인한다(추측이 아니라 라이브러리 상수를 그대로 가져와 계산).
import onnxruntime as ort
CENTS_MAPPING = np.linspace(0, 7180, 360) + 1997.3794084376191
def to_hz(salience):
    center = int(np.argmax(salience))
    lo, hi = max(0, center - 4), min(len(salience), center + 5)
    s = salience[lo:hi]
    cents = np.sum(s * CENTS_MAPPING[lo:hi]) / np.sum(s)
    return 10 * 2 ** (cents / 1200)

sess = ort.InferenceSession(OUT, providers=['CPUExecutionProvider'])
in_name = sess.get_inputs()[0].name
sr = 16000
t = np.arange(1024) / sr
print(f'\nONNX 입력 이름: {in_name}\n')
for test_hz in (41.2, 55.0, 110.0, 220.0, 440.0):   # E1(41Hz 근처)부터 A4 까지
    frame = (0.5 * np.sin(2 * np.pi * test_hz * t)).astype(np.float32)
    frame = (frame - frame.mean()) / max(frame.std(), 1e-8)
    out = sess.run(None, {in_name: frame[None, :]})[0][0]
    got_hz = to_hz(out)
    err_cents = 1200 * np.log2(got_hz / test_hz)
    print(f'  넣은 소리 {test_hz:7.1f}Hz -> 검출 {got_hz:7.2f}Hz'
          f'  오차 {err_cents:+6.1f}cent  살리언스 {out.max():.3f}')
