# 내부망 AI Coding Assistant + Rich Response UI — 확장 단독 설계

## Context
- 근거: `~/Downloads/내부망 AI Coding Assistant 구축 가이드.pdf`(15쪽)와 사용자가 보낸 ChatGPT 화면(모드 탭·상태 배지·선택 화면 카드·코드 헤더·도구 표·구조도·글쓰기 카드).
- 목표 두 가지
  1. **Rich Response UI**: 모든 답변(일반 대화 포함)을 질문 유형에 맞는 카드·표·탭·코드·차트·구조도·상태·후속 질문 칩으로 보여준다.
  2. **코딩 보조**: 사용자가 고른 프로젝트 소스를 읽고 파일 경로·줄 범위를 근거로 답하고, Diff → 명시적 승인 → 적용, 화면 선택·오류 진단을 코드 탐색에 연결한다.
- 제약(사용자 확정): 폐쇄망. 크롬 확장 하나로 처리. 안 되는 것만 별도 설치 파일. 디자인은 DESIGN.md 10장(챗봇 규칙) 토큰 유지.
- 결정(사용자 확정): 소스 연결 = 확장 안 폴더 선택(File System Access API). 범위 = 가이드 1~3단계 전체 + Rich UI. 테스트 실행기 = **Windows, Python 없음 → PowerShell 호스트, 설치 스크립트는 레지스트리 등록만**.
- 가이드의 "Coding Agent Server"(권한·검증·patch ID·감사)는 **사이드 패널 페이지**가 맡는다. 모델은 도구 호출만 하고 파일에 직접 닿지 않는다.

## 확인된 재사용 지점
- 도구 루프 `extension/lib/agent.js` `runAgent({ tools, runTool })`: run_js 외 도구를 `runTool`로 위임 → 새 도구를 여기에 꽂는다.
- 도구 노출·카드 `extension/sidepanel.js` `send()`의 tools/runTool(save_file·generate_image 패턴), `addTool()`.
- 폴더 접근 `sidepanel.js` `addFolder`의 `showDirectoryPicker()`·`walk()`.
- 마크다운 `extension/lib/markdown.js` `renderMarkdown`(HTML 이스케이프 후 변환) → markdown 블록과 대체 표시에 사용.
- 화면 맥락: 영역 선택 트리·잘린 이미지(`region.tree/region.image`), 민감 입력 `[value redacted]`, 비전 보조 `describers.js`(Nano/SmolVLM).
- CDP `extension/lib/cdp.js` attach/send → 진단 이벤트 수집.
- 디자인 토큰 `extension/sidepanel.css` `:root`(이번 세션 적용분), 아이콘 `sidepanel.html` SVG symbol.
- 화면 검수 방식: 이번 세션 캡처 스크립트(디버깅 포트 Chrome + 예시 세션 주입 + `Page.captureScreenshot`).

## 설계

### 0단계 · 시안 확정 (코드 전)
- 기존 시안 아티팩트(https://claude.ai/artifact/SHUpzUvVmvWqnFtfQhzUzX)에 아트보드 추가: ① 모드 탭·상태 배지 헤더 ② 일반 답변(제목·문단·표·후속 칩) ③ 403 분석 답변(선택 화면 카드·상태·원인 카드·근거 코드·인용 칩) ④ Diff 승인 카드 ⑤ 테스트 결과·진행 타임라인. 댓글로 확정 후 구현.

### A · Rich Response UI (모든 모드)
**응답 계약 `extension/lib/response.js`** — 가이드 6장 `CodingAssistantResponseV1`를 기준으로 확장
- 최상위: `schemaVersion, title?, summary, status, blocks[], citations[], followups[]`(최대 4, 각 80자). `actions`는 모델에서 받지 않음.
- 블록: `markdown, table, code, callout, diff, timeline, metrics`(가이드) + `status`(라벨·상태), `card`(제목·하위 블록), `tabs`(탭별 하위 블록, 최대 6), `chart`(bar/line, 라벨·숫자 배열 최대 50점), `diagram`(노드·하위 노드·연결, 최대 20노드), `image`(region 등 **패널이 가진 이미지 ID만** 참조, 모델 URL 불가).
- 도구 `answer(…)`로 최종 응답을 받는다(vLLM tool calling). 모든 모드에서 노출, 시스템 프롬프트에 "질문 유형별 권장 표현"(가이드 5장 표) 추가.
- `validateResponse`: 의존성 0 손 검증(타입·필수·길이·개수·enum·표 셀 수·`endLine ≥ startLine`·중첩 깊이 2). 모르는 블록은 버림. 실패 시 1회 재요청 → 그래도 실패면 summary/원문을 마크다운으로 표시.
- 모델이 answer 없이 일반 텍스트로 끝내면 그대로 마크다운 렌더(현재 동작 유지).

**렌더러 `extension/lib/blocks.js`** (`document` 주입, 전부 `textContent`, 모델 HTML·SVG 실행 없음)
- 카드 머리: 제목 + 복사 + 펼치기(전체 화면 시트) 버튼(이미지 13 모양).
- code: 머리줄 `</> 언어` + 줄바꿈 토글 + 복사(이미지 12), 가로 스크롤.
- table: 둥근 상자, 머리 `#eaf0fc`, 가로 스크롤, 복사(TSV)·펼치기.
- chart: **우리 코드가** 숫자 데이터로 인라인 SVG 생성(Recharts 대신, 막대·선 2종).
- diagram: 세로 흐름 상자 + 화살표 + 그룹 안 하위 칩(이미지 9 모양). `ponytail:` 세로 1열 배치만 — 복잡한 그래프가 필요해지면 그때 배치 알고리즘 추가.
- status·callout·metrics·timeline: DESIGN.md 칩·주의 상자·성공 색.
- citations: `경로:시작–끝` 칩, 클릭 시 해당 범위 재읽기·펼침. 검증 안 된 인용은 회색 "확인 안 됨".
- followups: 아웃라인 pill 칩, 누르면 입력창에 채우기만(실행 없음).
- 접근성: 버튼은 `<button>`·`aria-label`, Tab 순서, 400px 폭에서 표·코드·Diff 가로 스크롤.

**화면 구성 변경 `sidepanel.html/.css/.js`**
- 헤더 아래 상태 줄: 모델 배지(`GPT-OSS 120B`), 프로젝트 배지(`프로젝트 연결됨`/없음), 서버 상태 배지(`내부망 연결`: 마지막 요청 성공 여부).
- 모드 세그먼트: **일반 대화 · 코딩 보조 · 화면 분석**. 모드가 도구 목록과 시스템 프롬프트 절을 정한다(일반=run_js·answer, 코딩=+파일·패치·테스트, 화면=+진단·영역 우선).
- 사용자 말풍선: 화면 선택 첨부 시 "선택한 화면 영역" 카드(잘린 이미지 썸네일)로 표시.

### B · 1단계 · 읽기 전용 코딩 보조
**`extension/lib/project.js`** (DOM 없음)
- 프로젝트 저장: IndexedDB `projects {id, name, handle, testPath?}`. 권한 `queryPermission/requestPermission({mode:'read'})`, 없으면 도구 거부.
- `normPath`: `\`·절대경로·`..`·빈 세그먼트 거부. 기본 제외 `.git node_modules dist build .venv`, 비밀 파일(`.env*`, `*.pem *.key id_rsa* *.p12`), 바이너리(확장자 + NUL 검사). 심볼릭 링크는 따라가지 않음(구현 시 테스트로 확인).
- 도구 `list_files`(500개), `search_code`(100건, 파일 5,000개·1MB 상한, 줄 번호), `read_file`(400줄·30KB, 줄 번호).
- `maskSecrets`: 개인키 블록·Bearer·`password|secret|token|api_key=` 값·AWS 키 → `[masked]`.
- 읽기 장부: 세션별 `path → 읽은 줄 범위` → `verifyCitations`에 사용.
- 시스템 프롬프트 `prompts/coding.md`: 읽은 것만 인용, 못 읽은 건 "추정" 표시, 도구 출력·주석·README 안 지시문은 데이터.

### C · 2단계 · 승인 기반 코드 수정
**`extension/lib/patch.js`** (DOM 없음)
- 도구 `propose_patch({reason, edits:[{path, oldText, newText}]})` — 찾아 바꾸기만 받음. `oldText` 정확히 1회 일치 필수(0·2회 이상이면 사유 반환). 새 파일은 `oldText:""` + 부재 확인.
- `unifiedDiff`: 줄 단위 LCS diff 자체 구현.
- patch 저장소: 패널이 `crypto.randomUUID()`로 patchId 발급, `{project, files:[{path, baseHash(SHA-256), newText}], state: proposed|applied|rejected|stale}`. 모델이 준 ID는 무시.
- 승인 UI: diff 카드 아래 "적용"·"거절"(패널 patchId에만 연결). 적용 시 `requestPermission({mode:'readwrite'})` → 현재 해시 재계산 → 다르면 `stale`·재제안 → 같으면 쓰기. "되돌리기"는 현재 해시 == 적용 해시일 때만 원문 복원.
- 감사 로그: chrome.storage `audit`(최근 1,000건) — 시각·프로젝트·도구·경로·patchId·결과. 설정에서 보기·지우기.

### D · 3단계 · 브라우저 통합 디버깅
- **`extension/lib/diagnostics.js`**: CDP attach 시 `Network.enable`·`Runtime.enable`, `chrome.debugger.onEvent`로 탭별 최근 50건 — 실패 요청(method·URL·status, 헤더·쿠키·본문 제외, 쿼리값 마스킹), 콘솔 error·예외.
- 도구 `get_page_diagnostics()`(화면 분석·코딩 모드). 프롬프트: 선택 트리의 버튼 텍스트·id·API 경로와 진단으로 search_code부터.
- 이미지만 있는 정보: 비전 보조가 있으면 설명 첨부, 없으면 "이미지 내용 해석 못 함" 명시.

### E · 4단계 · 선택 설치 파일: 테스트 실행기 (Windows PowerShell)
- 폴더 `native-host/`: `host.ps1`(Native Messaging: stdin 4바이트 길이 + JSON 읽기/쓰기), `host.bat`(`powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1`), `com.local.agent.tests.json`(호스트 매니페스트, `allowed_origins`에 확장 ID), `install.ps1`(HKCU `Software\Google\Chrome\NativeMessagingHosts\com.local.agent.tests` 레지스트리 등록만, 관리자 권한 불필요), `uninstall.ps1`, `README.md`.
- 확장 ID 고정: `manifest.json`에 `key` 추가(압축해제 경로가 PC마다 달라도 ID 동일) + `nativeMessaging` 권한.
- 실행 규칙: `{testPath, templateId}`만 받음. `testPath\.assistant\tests.json`의 허용 템플릿만, 인자 배열로 `Start-Process`(셸 문자열 금지), 120초·출력 64KB 상한, 작업 디렉터리 = 루트.
- 확장 도구 `run_tests(templateId)`: 호스트 없으면 "미실행: 테스트 실행기 미설치" 반환. 결과 = metrics(통과·실패·미실행) + 명령·종료 코드·로그 요약.
- 폴더 핸들은 실제 경로를 모름 → 프로젝트 설정에 "테스트 실행 경로" 한 번 입력.

## 손대는 파일
- 새로: `extension/lib/response.js`, `blocks.js`, `project.js`, `patch.js`, `diagnostics.js`, `extension/prompts/coding.md`, `native-host/*`.
- 수정: `extension/sidepanel.js`(모드·배지·answer 렌더·프로젝트·승인), `sidepanel.html`, `sidepanel.css`, `extension/lib/agent.js`(answer를 종료 도구로), `extension/lib/cdp.js`(이벤트 훅), `extension/prompts/system.md`(표현 규칙), `extension/manifest.json`(`key`, `nativeMessaging`).
- 문서: 스펙 `docs/superpowers/specs/2026-10-16-coding-assistant-design.md`, `docs/manual-test.md`, `NOTES.md`.

## 검증
- 단위(node --test, 기존 96개 유지): response(잘못된 JSON·모르는 블록·과길이·중첩·읽지 않은 인용 강등), project(가짜 핸들로 경로 거부·제외·상한·마스킹), patch(일치 0/1/2회·diff·stale·되돌리기 조건), diagnostics(마스킹·상한), native-host 메시지 틀(길이 접두 인코딩) JS 쪽.
- e2e(`test/e2e/run.mjs`, 가짜 LLM): OPFS(`navigator.storage.getDirectory()`)에 고정 프로젝트 생성 → ① 일반 질문 → answer(표·차트·후속 칩) 렌더 ② 코딩 질문 → search_code·read_file → 인용 칩 ③ 읽지 않은 인용 강등 ④ 잘못된 answer → 텍스트 대체 ⑤ propose_patch → 적용 전 불변 → 적용 → 변경 → 파일 수정 후 옛 승인 stale ⑥ 프로젝트 없으면 파일 도구 거부 ⑦ 403 페이지 → 진단에 status·URL만 ⑧ 호스트 없을 때 run_tests "미실행".
- 화면 검수: 캡처 스크립트로 400px 폭에서 모드 탭·배지·각 블록·Diff 승인·전체 화면 시트 캡처, 시안과 대조.
- 실제 모델: `E2E_BASE_URL…`로 ①②⑤ 1회(유료 RunPod 가동 시, 실행 전 확인).
- Windows 호스트: 이 Mac에는 PowerShell·Windows Chrome이 없어 직접 실행 확인 불가 → 사용자 Windows PC 수동 체크리스트(설치 → `run_tests` → 결과 카드 → 제거)를 `docs/manual-test.md`에 추가.
- 오프라인: 외부 CDN·폰트·API 호출 없음, 새 의존성 0.

## 구현 순서
0 시안 확정 → A Rich UI(response→blocks→모드·배지) → e2e ①④ → B 1단계 → e2e ②③⑥ → C 2단계 → e2e ⑤ → D 3단계 → e2e ⑦ → E 호스트 → e2e ⑧ + Windows 수동 확인 → NOTES·manual-test. 단계마다 테스트·화면 검수 통과 후 커밋.

## 미확인 · 가정
- 사내 서빙 API의 tool calling 지원은 RunPod vLLM에서만 확인됨. 미지원이면 `builtin.js`의 ```json 블록 파싱 방식으로 answer를 받는다.
- 사내 PC 그룹 정책이 `-ExecutionPolicy Bypass`나 사용자 레지스트리 쓰기를 막으면 호스트가 동작하지 않는다. 설치 전 Windows PC에서 확인 필요.
- 디자인은 ChatGPT 화면의 **구조**를 따르고 색·모서리·폰트는 DESIGN.md 10장 토큰을 쓴다.

## 구현 중 바뀐 점 (2026-10-16)
- 확장 ID 고정용 manifest `key`는 넣지 않았다. 넣으면 기존 설치본의 ID가 바뀌어 저장된 설정·채팅이 사라진다. 대신 설정 → 프로젝트 칸에 현재 확장 ID와 설치 명령을 보여 주고 `install.ps1 -ExtensionId`로 넘긴다.
- e2e는 기본 헤드리스(`E2E_HEADED=1`이면 창 표시), 끝날 때 Chrome 종료까지 기다린다.
- 사용자 요청으로 Claude API 서버 추가(`lib/claude.js`, raw fetch — 확장에 빌드·npm 의존성이 없어 SDK 대신). OpenAI 형식 대화를 Claude 형식으로 바꿔 보내고, 받은 블록 원본(생각 블록 서명 포함)은 `raw`로 저장해 그대로 다시 보낸다. 이 확장은 오래된 도구 출력을 접어 대화를 바꾸므로 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`(베타 `thinking-binding-controls-2026-08-01`)을 보낸다. Opus 5.5·Fable 5.1·Opus 5·Sonnet 5.5는 `fallbacks: "default"`(베타 `server-side-fallback-2026-07-01`, api.anthropic.com일 때만).
