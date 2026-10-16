// run_tests: Windows 테스트 실행기(native-host/, Native Messaging)를 부른다. 확장 단독으로는 명령을 실행할 수 없다.
export const HOST = 'com.local.agent.tests';
export const RUN_TESTS_TOOL = { type: 'function', function: { name: 'run_tests', description: '허용 목록(.assistant/tests.json)에 등록된 테스트 템플릿을 실행한다. 명령 문자열은 받지 않고 템플릿 ID만 받는다. 실행기가 없으면 미실행으로 돌아온다.', parameters: { type: 'object', properties: { templateId: { type: 'string', description: '예: unit' } }, required: ['templateId'] } } };

const NOT_INSTALLED = /not found|native messaging host|Specified native|Access to the specified native/i;

// send(msg) → Promise<응답>. 브라우저에선 chrome.runtime.sendNativeMessage.
export const nativeSend = (msg) => new Promise((res, rej) => chrome.runtime.sendNativeMessage(HOST, msg, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))));

// 결과를 카드·모델 출력용으로 정리. 반환 { state: passed|failed|timeout|notrun, ... }
export async function runTests({ testPath, templateId, send = nativeSend }) {
  if (!testPath) return { state: 'notrun', reason: '미실행: 프로젝트의 "테스트 실행 경로"가 설정되지 않았습니다(설정 → 프로젝트).' };
  let r;
  try { r = await send({ type: 'run', testPath, templateId }); }
  catch (e) { return { state: 'notrun', reason: NOT_INSTALLED.test(e.message) ? '미실행: 테스트 실행기가 설치되지 않았습니다(native-host/README.md 참고).' : `미실행: 실행기 오류 — ${e.message}` }; }
  if (!r?.ok) return { state: 'notrun', reason: `미실행: ${r?.error || '응답 없음'}` };
  const log = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  const tail = log.length > 4000 ? `…${log.slice(-4000)}` : log;
  return { state: r.timedOut ? 'timeout' : r.exitCode === 0 ? 'passed' : 'failed', command: r.command, exitCode: r.exitCode, ms: r.ms, log: tail };
}

export function formatTestResult(t) {
  if (t.state === 'notrun') return t.reason;
  return `테스트 ${{ passed: '통과', failed: '실패', timeout: '시간 초과(120초)' }[t.state]} · 명령 ${t.command} · 종료 코드 ${t.exitCode ?? '-'} · ${Math.round((t.ms || 0) / 1000)}초\n출력 끝부분:\n${t.log || '(출력 없음)'}`;
}
