// chrome.debugger(CDP) 래퍼. 실제 마우스·키 이벤트를 탭에 보낸다.
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 }, End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

export function parseCombo(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) { if (!(m in MODS)) throw new Error(`unsupported modifier ${m}`); modifiers |= MODS[m]; }
  let key = KEYS[name];
  if (!key && name.length === 1) key = { key: name, code: /\d/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: modifiers ? undefined : name };
  if (!key) throw new Error(`unsupported key ${name}`);
  const out = { modifiers, key };
  const cmd = { a: 'selectAll', v: 'paste', c: 'copy', x: 'cut' }[name.toLowerCase()];
  if ((modifiers & MODS.Meta) && cmd) out.commands = [cmd]; // macOS는 editing command로만 전체 선택·붙여넣기가 동작
  return out;
}

const attached = new Set();
const dbg = (fn, ...a) => new Promise((res, rej) => fn(...a, (r) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)));

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await dbg(chrome.debugger.attach, { tabId }, '1.3');
  attached.add(tabId);
  for (const m of ['Network.enable', 'Runtime.enable']) await send(tabId, m).catch(() => {}); // 페이지 진단(diagnostics.js)용 이벤트
}
export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await dbg(chrome.debugger.detach, { tabId }); } catch {}
}
export async function detachAll() { for (const id of [...attached]) await detach(id); }
export const send = (tabId, method, params = {}) => dbg(chrome.debugger.sendCommand, { tabId }, method, params);

globalThis.chrome?.debugger?.onDetach?.addListener?.(({ tabId }) => attached.delete(tabId));

export async function hover(tabId, { x, y }) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}
export async function click(tabId, { x, y, clickCount = 1 }) {
  await hover(tabId, { x, y });
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: i });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: i });
  }
}
export const insertText = (tabId, text) => send(tabId, 'Input.insertText', { text });
export async function pressKey(tabId, combo) {
  const { modifiers, key, commands } = parseCombo(combo);
  const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
  await send(tabId, 'Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, text: key.text, ...(commands ? { commands } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
