// 이미지 설명 엔진 선택: Chrome 내장 Nano → 브라우저 내 SmolVLM(local) → 없음.
export function pickDescriber({ nano, local, prefer = 'nano' }) {
  const ok = { nano: nano === 'available', local: local === 'ready' };
  if (prefer === 'local' && ok.local) return 'local';
  if (ok.nano) return 'nano';
  if (ok.local) return 'local';
  return null;
}
