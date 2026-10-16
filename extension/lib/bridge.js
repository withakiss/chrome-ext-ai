// RPC 서버: 샌드박스의 page.* 호출을 content script(좌표·DOM) + cdp(입력) + chrome.tabs 로 실행한다.
import './snapshot-core.js';
const { truncateTree, diffLines } = globalThis.SnapshotCore;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBridge({ chrome, cdp, sendToTab, navTimeoutMs = 30000, writeClipboard = (t) => globalThis.navigator.clipboard.writeText(t) }) {
  const lastTree = new Map(); // tabId -> 직전 스냅샷 텍스트(diff용)

  const ask = async (tabId, msg) => {
    const r = await sendToTab(tabId, msg);
    if (!r) throw new Error('content script가 응답하지 않습니다 — 탭을 새로고침하거나 다른 탭을 쓰세요');
    if (r.error) throw new Error(r.error);
    return r;
  };

  async function pointOf(tabId, ref) {
    await cdp.attach(tabId);
    return ask(tabId, { type: 'elementPoint', ref });
  }

  function waitNav(tabId, timeout = navTimeoutMs) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { chrome.webNavigation.onCompleted.removeListener(f); rej(new Error(`페이지 로딩 시간 초과(${Math.round(timeout / 1000)}초)`)); }, timeout);
      const f = (d) => { if (d.tabId === tabId && d.frameId === 0) { clearTimeout(t); chrome.webNavigation.onCompleted.removeListener(f); res(); } };
      chrome.webNavigation.onCompleted.addListener(f);
    });
  }

  const handlers = {
    async snapshot({ tabId, ...opts }) {
      const { tree } = await ask(tabId, { type: 'snapshot', ...opts });
      const text = truncateTree(tree);
      const diff = lastTree.has(tabId) ? diffLines(lastTree.get(tabId), text) : '(첫 스냅샷 — tree를 보세요)';
      lastTree.set(tabId, text);
      return { tree: text, diff };
    },
    async 'locator.click'({ tabId, ref, dblClick }) {
      const p = await pointOf(tabId, ref);
      if (p.obscured) await ask(tabId, { type: 'domClick', ref });
      else await cdp.click(tabId, { x: p.x, y: p.y, clickCount: dblClick ? 2 : 1 });
      await sleep(80);
      return { ok: true };
    },
    async 'locator.hover'({ tabId, ref }) { const p = await pointOf(tabId, ref); await cdp.hover(tabId, p); return { ok: true }; },
    async 'locator.fill'({ tabId, ref, text }) {
      await handlers['locator.click']({ tabId, ref });
      await ask(tabId, { type: 'focusAndClear', ref });
      await cdp.insertText(tabId, text);
      return { ok: true };
    },
    async 'locator.type'({ tabId, ref, text }) { await handlers['locator.click']({ tabId, ref }); await cdp.insertText(tabId, text); return { ok: true }; },
    async 'keyboard.type'({ tabId, text }) { await cdp.attach(tabId); await cdp.insertText(tabId, text); return { ok: true }; },
    async 'keyboard.paste'({ tabId, text }) { // 클립보드 경유: 캔버스 기반 웹 에디터(한컴 Web 등)는 insertText를 무시하는 경우가 있다
      await writeClipboard(text);
      await cdp.attach(tabId); await cdp.pressKey(tabId, 'Meta+v'); return { ok: true };
    },
    async 'locator.press'({ tabId, ref, key }) { if (ref) await handlers['locator.click']({ tabId, ref }); else await cdp.attach(tabId); await cdp.pressKey(tabId, key); return { ok: true }; },
    async 'locator.selectOption'({ tabId, ref, value }) { await ask(tabId, { type: 'selectOption', ref, value }); return { ok: true }; },
    async 'page.goto'({ tabId, url }) { const nav = waitNav(tabId); await chrome.tabs.update(tabId, { url }); await nav; return { url: (await chrome.tabs.get(tabId)).url }; },
    async 'page.url'({ tabId }) { return (await chrome.tabs.get(tabId)).url; },
    async 'page.title'({ tabId }) { return (await chrome.tabs.get(tabId)).title; },
    async openTab({ url }) { const t = await chrome.tabs.create({ url: url || 'about:blank', active: true }); if (url) await waitNav(t.id).catch(() => {}); return { tabId: t.id }; },
    async closeTab({ tabId }) { await cdp.detach(tabId); await chrome.tabs.remove(tabId); lastTree.delete(tabId); return { ok: true }; },
    async tabs() { return (await chrome.tabs.query({})).map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active })); },
  };

  return {
    async handle(call, args = {}) {
      const h = handlers[call];
      if (!h) throw new Error(`unknown call ${call}`);
      return h(args);
    },
    clearTrees() { lastTree.clear(); }, // 새 채팅·세션 전환 시 diff 기준 초기화
  };
}
