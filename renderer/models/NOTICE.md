# 동봉 모델

## basic-pitch.onnx

Spotify 의 **Basic Pitch** 음원→MIDI 모델(`nmp.onnx`)을 그대로 가져온 것입니다.

- 출처: https://github.com/spotify/basic-pitch (`basic_pitch/saved_models/icassp_2022/nmp.onnx`)
- 라이선스: **Apache License 2.0** (원저작권 Spotify AB)
- 용도: 베이스 TAB 채보에서 자체 검출 결과를 교차 확인 (`opts.crossCheck` 로만 켜지는 개발용 경로)

Apache-2.0 전문은 위 저장소의 LICENSE 를 따릅니다. 모델 파일은 수정하지 않았습니다.

`.onnx` 는 저장소에 넣지 않습니다(`.gitignore` 의 `models/*.onnx`). 교차 확인을 켜려면 위 출처에서
`nmp.onnx` 를 받아 이 폴더에 `basic-pitch.onnx` 로 두십시오.

## 왜 기본으로 쓰지 않는가

분리된 베이스 스템에서 실측한 결과, 사용자 수정 정답지(617음) 대비 정답률이
자체 YIN 87% · basic-pitch 18% (옥타브 무시 90% vs 29%) 로 격차가 컸습니다.
두 결과의 불일치는 신뢰도 신호가 아니라 basic-pitch 의 오답이어서, 화면에 표시하면
맞는 음이 오히려 흐려집니다.

## crepe-full.onnx

marl(NYU MARL) 의 **CREPE** 단선율 피치 추정 모델(`full` 용량, Keras `.h5`)을 `tf2onnx` 로
직접 변환한 것입니다. marl/crepe 는 아직 공식 ONNX 내보내기가 main 에 머지되지 않아서
(PR #105, 2025-04 오픈·미병합) 그 코드에 기대는 대신 이미 배포된 pip 패키지(`pip install crepe`)의
Keras 가중치를 `lab/tab/tools/crepe_to_onnx.py` 로 직접 변환했습니다. 순음(41.2~440Hz)을 넣어
검출 오차가 수 cent 이내인 것으로 변환 정확도를 확인했습니다.

- 출처: https://github.com/marl/crepe (Keras 가중치, `pip install crepe` 로 함께 받아짐)
- 라이선스: **MIT** (원저작권 Jong Wook Kim 외, New York University)
- 변환 도구: `lab/tab/tools/crepe_to_onnx.py` (이 저장소에서 작성 — tf2onnx 로 마르 변환, 검증 포함)
- 입력: `input` — `[1, 1024]` float32, 16kHz, 프레임별 평균 0·표준편차 1 정규화
- 출력: `[1, 360]` — 20cent 간격 피치 살리언스(cents = 1997.3794 + bin×7180/359, hz = 10·2^(cents/1200))
- 용도: 베이스 TAB 채보의 세 번째 피치 추정 경로(`opts.pitchTracker: 'crepe'` — 기본은 `'yin'`).
  실측은 `lab/tab/README.md` 11번 절.

MIT 전문은 위 저장소의 LICENSE 를 따릅니다. 가중치 자체는 수정하지 않았습니다 — 그래프 형식만
Keras → ONNX 로 바꿨습니다.

`.onnx` 는 저장소에 넣지 않습니다(`.gitignore` 의 `models/*.onnx`). 되살리려면:
```
pip install crepe tf2onnx
python lab/tab/tools/crepe_to_onnx.py full renderer/models/crepe-full.onnx
```
