// 모델 서버 자동 전환: 선택한 서버가 출력 전에 연결·인증·서버 오류로 실패하면 목록에서 그 아래에 있는 설정된 서버를 차례로 시도한다.
// 한 번 넘어가면 그 실행이 끝날 때까지 새 서버를 계속 쓴다(sticky). DOM 없음.
const FAILOVER_ERR = /Failed to fetch|NetworkError|fetch failed|^HTTP (40[134]|408|429|5\d\d)|API 키가 없습니다|LanguageModel API 없음|사용 불가/i;
export const isFailoverError = (e) => e?.name !== 'AbortError' && FAILOVER_ERR.test(String(e?.message || e));

// 설정이 갖춰진 서버인지(주소·모델, Claude는 키까지). 이미지 생성 서버는 대화용이 아니다.
export function isConfigured(p) {
  if (!p || p.kind === 'image-gen') return false;
  if (p.kind === 'builtin') return true;
  if (!p.baseUrl || !(p.model || p.models?.length)) return false;
  return p.kind !== 'anthropic' || !!p.apiKey;
}

// providers: 설정 순서, startId: 선택한 서버, streamFor(p) → chatStream 함수, onSwitch(from, to, err) 알림
export function createFailoverStream({ providers, startId, model, streamFor, onSwitch = () => {}, onOk = () => {} }) {
  const i0 = Math.max(0, providers.findIndex((p) => p.id === startId));
  const chain = [providers[i0], ...providers.slice(i0 + 1).filter(isConfigured)];
  let k = 0; const fails = [];
  const modelOf = (p, j) => (j === 0 ? model : p.model || p.models?.[0] || '');
  return {
    current: () => ({ provider: chain[k], model: modelOf(chain[k], k) }),
    async chatStream(args) {
      for (;;) {
        const p = chain[k]; let emitted = false;
        try {
          const r = await streamFor(p)({ ...args, baseUrl: p.baseUrl, apiKey: p.apiKey, model: modelOf(p, k), onDelta: (d) => { emitted = true; args.onDelta?.(d); } });
          onOk(p); return r;
        } catch (e) {
          if (emitted || !isFailoverError(e)) throw e;
          fails.push(`${p.label}: ${String(e.message || e).split('\n')[0].slice(0, 80)}`);
          if (k + 1 >= chain.length) throw new Error(`연결 가능한 모델 서버가 없습니다 — ${fails.join(' / ')}. 설정에서 서버 주소·API 키를 확인하세요.`);
          k++; onSwitch(p, chain[k], e, modelOf(chain[k], k));
        }
      }
    },
  };
}
