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
