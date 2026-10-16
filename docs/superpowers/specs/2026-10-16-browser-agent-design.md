# 브라우저 에이전트 확장 설계 (2026-10-16)

## 목적
- Aside 브라우저의 사이드 챗처럼, 사이드 패널에서 현재 페이지를 **스크린샷 없이** 접근성 트리로 읽고 클릭·입력·이동을 실행하는 Chrome 확장을 직접 만들어 실습한다.
- LLM은 사용자가 고른다. RunPod vLLM(gpt-oss-120b), 내부망 vLLM, Ollama, LM Studio 등 OpenAI 호환 서버를 설정에서 바꿔 쓴다.
- **확장 폴더 하나를 "압축해제된 확장 프로그램 로드"로 설치하면 끝.** Node·데몬·브라우저 다운로드·CDN 등 추가 설치와 런타임 외부 접속이 없다(폐쇄망 동작).

## 성공 기준
1. 인터넷을 끊은 PC에서 확장 폴더만 로드해 사이드 패널이 뜨고, 내부망 모델 주소를 입력하면 대화가 된다.
2. 로컬 고정 HTML 페이지(검색창 + 결과 목록)에서 "○○ 검색해서 첫 결과 열어"가 스냅샷→입력→Enter→클릭→새 페이지 확인까지 스크린샷 없이 완료된다.
3. 모델 드롭다운에서 RunPod / Ollama / LM Studio 모델을 바꿔도 같은 코드로 동작한다.

## 범위 밖
로그인·과금·웹스토어 배포, 스크린샷 기반 비전, 다중 사용자, 스케줄 작업, 파일 다운로드 관리.

## 구조 (확장 단독, MV3)
```
extension/
 ├ manifest.json        permissions: sidePanel, storage, unlimitedStorage, tabs, scripting,
 │                      debugger, webNavigation, activeTab / host_permissions: <all_urls>
 │                      sandbox.pages: [repl.html] / side_panel.default_path: sidepanel.html
 ├ sidepanel.html/.js   채팅 UI, 모델 드롭다운, 설정, 세션 목록, 에이전트 루프, 브라우저 브리지
 ├ repl.html/.js        샌드박스. 모델 코드 eval. page/snapshot/openTab/closeTab/tabs/sleep 전역은
 │                      postMessage RPC 프록시
 ├ background.js        action 클릭·단축키(Cmd+E)로 사이드 패널 열기. 루프는 돌리지 않음
 ├ content/snapshot.js  접근성 트리 생성 + ref 레지스트리. 모든 탭, document_idle
 └ lib/                 openai.js(스트리밍·tools), cdp.js(chrome.debugger 래퍼), store.js(세션)
```
- 에이전트 루프는 **사이드 패널 페이지**에서 돈다. 서비스 워커는 30초 유휴면 종료돼 스트리밍·긴 작업이 끊기기 때문.
- 외부 리소스 링크 없음. 폰트·스타일·스크립트 전부 폴더 안 파일. 라이트 모드만.

## 페이지 읽기: `snapshot(page, {interactive?, selector?})`
- `content/snapshot.js`가 DOM을 걸어 한 줄 트리를 만든다. 형식은 Aside와 동일:
  `role "name" [ref=e12] [level=2] [checked] [disabled] [focused] [selected] [placeholder="…"]`
  들여쓰기 2칸, 루트는 `페이지 제목 · URL` 한 줄.
- role 결정: `role` 속성 → 태그 매핑(a→link, button, input type별, select→combobox, h1~h6→heading[level], img, nav, main, li→listitem 등) → generic.
- name 결정: aria-label → placeholder → title → alt → `label[for]` → 버튼/링크 텍스트 → input value(50자 미만). 비밀번호·카드·OTP 입력값은 `[value redacted]`.
- `interactive: true`면 link/button/textbox/checkbox/radio/combobox/listitem(클릭 핸들러 있는 것) 등만 남기고, 자식이 텍스트뿐인 노드는 부모 name으로 접는다.
- 숨김(`display:none`, `aria-hidden`, 0×0)은 제외. 뷰포트 밖 요소는 포함(스크롤 불필요).
- iframe(동일 출처)은 `f1e3` 접두어로 포함. 교차 출처 iframe은 `iframe "…" [ref=f2] [cross-origin]`만.
- ref 레지스트리: `Map<ref, Element>` + `WeakMap<Element, ref>`. 새 스냅샷마다 비우고 다시 번호 매김(이전 ref 무효). 요소에 DOM 속성을 추가하지 않는다.
- 반환 `{tree, diff}`: diff는 직전 스냅샷과의 줄 단위 비교(추가 `+`, 삭제 `-`, 변경 없으면 "(변경 없음)").
- 크기 상한: 트리 20,000자. 넘으면 뒤를 잘라 `[… N줄 생략, selector로 범위를 좁히세요]`.

## 페이지 조작: `page` API (RPC → 사이드 패널 → CDP)
| 호출 | 실행 |
|---|---|
| `page.locator('e12').click({dblClick?})` | content script가 ref→요소 `scrollIntoView({block:'center'})` 후 중심 좌표 반환 → CDP `Input.dispatchMouseEvent` mouseMoved→mousePressed→mouseReleased. `elementFromPoint`가 다른 요소면 obscured → `element.click()` 폴백. 80ms 후 반환 |
| `.fill(text)` | click → `Input.insertText`(기존 값은 Cmd/Ctrl+A → Delete 로 비움) |
| `.press('Enter')` | CDP `Input.dispatchKeyEvent` keyDown/keyUp. 지원 키: Enter, Tab, Escape, Backspace, 방향키, 수식키 조합 |
| `.selectOption(value)` | content script가 `select.value = …` + change 이벤트 |
| `.hover()` | mouseMoved 만 |
| `page.goto(url)` | `chrome.tabs.update` + `webNavigation.onCompleted` 대기(최대 30초) |
| `page.url()`, `page.title()` | `chrome.tabs.get` |
| `openTab(url?)`, `closeTab(page)`, `tabs()` | `chrome.tabs.create/remove/query`. 새 탭은 debugger attach 후 `Page` 객체 반환 |
| `sleep(ms)` | setTimeout |
| `console.log(...)` | 출력 수집. **`return`은 무시** (Aside와 동일 규칙) |
- debugger는 탭별 1회 attach(`chrome.debugger.attach(tabId, "1.3")`), 세션 종료·탭 닫힘 시 detach. 노란 "디버깅 중" 띠는 감수(승인됨).
- 입력 전 포커스: `.fill`은 click으로 포커스 확보 후 insertText.

## 샌드박스 REPL
- `repl.html`은 manifest `sandbox.pages` 등록 → iframe 안에서만 `eval` 허용. Chrome API 접근 불가.
- 사이드 패널이 `postMessage({id, call:'locator.click', args})`로 RPC. 응답 `{id, ok, value|error}`. 모든 전역은 Promise 반환.
- 코드 실행: `new Function('page','snapshot',…, 'return (async()=>{'+code+'})()')`. 타임아웃 120초(초과 시 iframe 재생성으로 강제 중단).
- 출력: console.log/warn/error 문자열 합산, 30KB 초과 시 뒤를 잘라 `[출력 30KB 초과, 생략]`. 예외는 `Error: message\n  at …` 첫 5줄.

## 모델 호출
- 단일 어댑터 `lib/openai.js`: `POST {baseUrl}/v1/chat/completions`, `stream: true`, `tools: [run_js]`, `Authorization: Bearer <key>`(키 없으면 헤더 생략).
- 스트림 파싱: `delta.content` → 화면, `delta.reasoning`/`reasoning_content` → 접힌 "생각" 영역, `delta.tool_calls` 조각 → 합쳐서 실행.
- 도구 하나: `run_js({code: string})` → 결과 문자열을 `role: tool` 메시지로 추가 후 재호출.
- 한 프롬프트당 도구 호출 최대 25회, 전체 10분. 초과 시 "한도 초과"로 종료.
- 컨텍스트 절약(32k 대응): 8턴 지난 `tool` 메시지 본문을 `[이전 출력 생략]`으로 치환. 스냅샷은 `interactive: true`를 기본 권장.
- 모델 목록(`GET` 통합): providers 설정 각각에 대해 Ollama `/api/tags`, LM Studio `/models`, OpenAI 호환 `/v1/models`를 조회해 드롭다운에 합친다. 조회 실패 provider는 수동 입력한 model 이름만 표시.

## 시스템 프롬프트 (직접 작성, Aside 규칙 참고)
- 역할: "브라우저 에이전트. 도구 run_js로 JS를 실행해 페이지를 읽고 조작한다."
- 규칙: ① 항상 `snapshot(page, {interactive:true})`로 시작, 필요 시 전체 스냅샷. ② 동작 후에는 `diff`만 출력. ③ ref 추측 금지, 새 스냅샷마다 이전 ref 무효. ④ 결과는 `console.log`로만. ⑤ 실패하면 재스냅샷, 같은 방법 2~3회 실패면 전략 변경. ⑥ 팝업·쿠키 배너 먼저 닫기. ⑦ URL 추측 금지(잘 알려진 사이트 제외). ⑧ 사용자에게는 도구 결과를 말로 요약. ⑨ 이모지·장식 금지.
- API 요약(위 표)을 TypeScript 시그니처로 첨부. 전문은 `extension/prompts/system.md`.

## 데이터와 저장
- `chrome.storage.local`
  - `settings`: `{providers: [{id, label, baseUrl, apiKey?, models?: string[]}], selected: {providerId, model}}`
  - `sessions`: `{[id]: {id, title, createdAt, model, messages: ChatMessage[]}}` (tool 메시지 포함 전체 보관)
- 기본 providers 3개를 미리 넣는다: RunPod(`https://<vllm-host>/v1`, model `openai/gpt-oss-120b`, 키는 사용자가 입력), Ollama(`http://localhost:11434/v1`), LM Studio(`http://localhost:1234/v1`).
- Ollama/LM Studio로 연결하려면 host_permissions에 `http://localhost/*`가 있어야 한다(포함).

## UI (사이드 패널, 라이트 모드)
- 상단: 세션 목록 드롭다운 · 새 채팅. 중앙: 메시지(어시스턴트 본문, 접힌 "생각", 도구 호출 카드 = 코드 + 출력 접기). 하단: 입력창 · 모델 드롭다운 · 중지 버튼 · 설정 톱니.
- 설정 패널: provider 추가/수정(label, baseUrl, apiKey, 수동 model), "모델 목록 새로고침", 연결 테스트.
- 현재 탭 칩: 입력창 위에 활성 탭 제목·URL 표시(Aside 캡처의 "(281) YouTube" 칩).

## 오류 처리
- 모델 401/404/연결 실패: 본문 그대로 메시지 영역에 빨간 카드, 루프 종료.
- debugger attach 실패(chrome:// 페이지, 다른 디버거 사용 중): `run_js` 결과로 오류 문자열 반환해 모델이 다른 탭을 쓰게 한다.
- 탭 닫힘: 해당 Page 호출은 "탭이 닫혔습니다" 오류.
- REPL 타임아웃: iframe 재생성, 오류 반환.
- 중지 버튼: fetch abort + 진행 중 RPC 취소 + iframe 재생성.

## 테스트
- 순수 함수 단위 테스트(`node --test`, 의존성 0): `snapshot` 핵심(role/name 결정, interactive 필터, 접기, diff), 스트림 파서(tool_calls 조각 합치기, reasoning 분리), 출력 자르기. DOM 의존 부분은 jsdom 없이 최소 가짜 노드 객체로.
- 수동 통합 체크리스트 `docs/manual-test.md`: ① 오프라인(와이파이 끔)에서 로드·패널 열기 ② `test/fixture/search.html`(검색창+결과 5개+결과 페이지)로 "두 번째 결과 열어" ③ RunPod/Ollama 전환 ④ 중지 버튼 ⑤ chrome:// 탭에서 오류 메시지.
- 비용: RunPod는 Pod 가동 중에만 과금(시간당 $3.99). 테스트는 Ollama로 먼저, 최종 확인만 RunPod.

## 참고·출처
- Aside 데몬 소스에서 확인한 스냅샷 형식·REPL 규칙·CDP 입력 순서: `NOTES.md`, scratchpad `aside_browser_prompt.txt`.
- Claude 확장 `accessibility-tree.js`(ref 카운터·redaction).
- 상용 코드는 복사하지 않고 구조만 참고해 자체 구현한다.

## 반입(폐쇄망) 절차
1. `extension/` 폴더를 통째로 복사(빌드 단계 없음, 번들러 미사용).
2. `chrome://extensions` → 개발자 모드 → 압축해제된 확장 프로그램 로드.
3. 설정에서 내부망 vLLM `baseUrl`·model 입력 → 연결 테스트.
