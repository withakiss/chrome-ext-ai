// 샌드박스 REPL 코어. 모델이 쓴 코드를 실행하고 console 출력만 돌려준다. rpc(call,args)로 호스트에 위임.
export function truncateOutput(s, max = 30000) {
  return s.length <= max ? s : `${s.slice(0, max)}\n[출력 ${max}자 초과, 생략]`;
}
export function formatError(e) {
  if (!(e instanceof Error)) return `Error: ${String(e)}`;
  const stack = (e.stack || '').split('\n').slice(1, 5).filter((l) => !l.includes('repl-core')).join('\n');
  return `${e.name}: ${e.message}${stack ? '\n' + stack : ''}`;
}
const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v instanceof Error) return formatError(v);
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } // 순환 객체 등
};

function makePage(tabId, rpc) {
  return {
    tabId,
    locator: (ref) => ({
      click: (o = {}) => rpc('locator.click', { tabId, ref, dblClick: !!o.dblClick }),
      dblclick: () => rpc('locator.click', { tabId, ref, dblClick: true }),
      hover: () => rpc('locator.hover', { tabId, ref }),
      fill: (text) => rpc('locator.fill', { tabId, ref, text: String(text) }),
      press: (key) => rpc('locator.press', { tabId, ref, key }),
      selectOption: (value) => rpc('locator.selectOption', { tabId, ref, value: String(value) }),
      type: (text) => rpc('locator.type', { tabId, ref, text: String(text) }), // 클릭 후 지우지 않고 입력(캔버스·리치 에디터용)
    }),
    goto: (url) => rpc('page.goto', { tabId, url }),
    url: () => rpc('page.url', { tabId }),
    title: () => rpc('page.title', { tabId }),
    keyboard: {
      press: (key) => rpc('locator.press', { tabId, ref: null, key }),
      type: (text) => rpc('keyboard.type', { tabId, text: String(text) }), // 포커스된 곳에 그대로 입력
      paste: (text) => rpc('keyboard.paste', { tabId, text: String(text) }), // 클립보드에 넣고 ⌘V — 긴 글·에디터 삽입용
    },
  };
}

export function createRepl({ rpc, timeoutMs = 120000 }) {
  return {
    async run(code, { tabId }) {
      const lines = [];
      const log = (...a) => lines.push(a.map(fmt).join(' '));
      const console = { log, warn: log, error: log, info: log };
      const page = makePage(tabId, rpc);
      const globals = {
        page, console,
        snapshot: (p, opts = {}) => rpc('snapshot', { tabId: p?.tabId ?? tabId, ...opts }),
        openTab: async (url) => makePage((await rpc('openTab', { url })).tabId, rpc),
        closeTab: (p) => rpc('closeTab', { tabId: p?.tabId ?? tabId }),
        tabs: () => rpc('tabs', {}),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      let error = null, timer;
      try {
        const fn = new Function(...Object.keys(globals), `return (async () => {\n${code}\n})();`);
        await Promise.race([
          fn(...Object.values(globals)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout: ${timeoutMs}ms 초과`)), timeoutMs); }),
        ]);
      } catch (e) { error = formatError(e); } finally { clearTimeout(timer); }
      const output = lines.length ? truncateOutput(lines.join('\n')) : '(출력 없음 — console.log로 결과를 출력하세요)';
      return { output, error };
    },
  };
}
