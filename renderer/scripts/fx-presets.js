'use strict';
// FX 프리셋("톤") — 트랙 FX 체인 전체 스냅샷. localStorage 에 순수 JSON으로 저장되며
// 엔진 세션·프로젝트 파일과 무관하다 — 스튜디오와 트레이닝(연습 녹음)이 같은 톤 목록을
// 공유해서 쓴다(둘 다 이 모듈을 import).

const KEY = 'yss:fx-presets';

export function getPresets() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function setPresets(a) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {}
}
export function upsertPreset(p) {
  const a = getPresets();
  const i = a.findIndex(x => x.id === p.id);
  if (i >= 0) a[i] = p; else a.push(p);
  setPresets(a);
}
