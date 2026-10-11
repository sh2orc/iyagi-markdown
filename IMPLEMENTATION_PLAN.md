# IYAGI Markdown 구현 방안

작성일: 2026-10-10 · 상태: **v1.0 — 2026-10-10 토의로 D1~D8 모두 확정, 나머지 토의 중**. 아직 코드는 없다.

형제 프로젝트: [iyagi-layout](../iyagi-layout), [iyagi-term](../iyagi-term). 이 문서는 iyagi-layout의 구조·스크립트·문서 관례(Tauri 2 + Rust 워크스페이스 + React, 안정 서명, CI, 티켓 방식)를 기준으로 IYAGI Markdown의 구현 방안을 정한다.

## 0. 결정이 필요한 항목 (토의 포인트)

2026-10-10 토의로 모두 확정했다. D3·D5·D6·확장 기능은 추천과 다르게 결정됐고(WYSIWYG 계열 편집, 편집 기본, 탭+사이드바, KaTeX·mermaid 포함), 그 결과 원문 무손실·무래스터 원칙(§4-2, §4-3)이 설계의 중심이 됐다.

| # | 항목 | 후보 | 추천 | 근거 요약 | 결정 |
|---|---|---|---|---|---|
| D1 | 기술 스택 | (a) Tauri 2 + Rust + React/TS (b) Swift/AppKit(+WKWebView) 네이티브 | **(a)** | layout과 툴체인·서명·CI·문서 관례 공유. 마크다운 생태계(markdown-it, CodeMirror, KaTeX, mermaid)가 전부 JS | **(a) 확정** |
| D2 | 앱 성격 | (a) 일반 문서 앱(Dock 아이콘, 파일 연결, 창 여러 개) (b) 메뉴 막대 상주 | **(a)** | 리더/편집기는 "파일을 열어 보는" 앱. layout의 `LSUIElement`/트레이 패턴은 쓰지 않는다 | **(a) 확정** |
| D3 | 에디터 엔진 | (a) ProseMirror 계열 WYSIWYG(Milkdown/Tiptap) (b) **CodeMirror 6 라이브 프리뷰**(문서 = 마크다운 텍스트, 장식·위젯으로 WYSIWYG처럼 표시) | **(b)** | 사용자 요구 "WYSIWYG라도 마크다운을 보존, HTML 변환 절대 불가". (a)는 트리→직렬화 과정에서 원문이 달라질 수밖에 없다. (b)는 편집 대상이 원문 텍스트 자체라 구조상 무손실 | **(b) 확정** |
| D4 | 렌더러 | (a) 에디터가 직접 표시(CM6 장식/위젯) 단일화 (b) 읽기용 별도 렌더러 | **(a)** | 읽기 모드는 같은 에디터를 읽기 전용 + 장식 전체 적용. 렌더 엔진 하나, 파일 변환 없음 | **(a) 확정** |
| D5 | 화면 모드 | 읽기(읽기 전용 라이브 프리뷰) / 편집(라이브 프리뷰, 커서 줄은 원문 노출) / 소스(장식 없음) | 추천은 읽기 기본이었으나 사용자가 **편집 기본**을 택함 (`Cmd+E` 읽기↔편집 토글, `Cmd+/` 소스) | 모두 같은 텍스트 버퍼를 보는 뷰일 뿐이라 전환 시 변환이 없다. 편집 기본이라도 수정 전에는 dirty가 아니므로 원문 보존 원칙(§4-2)은 그대로 | **편집 기본 확정** |
| D6 | 창 모델 | (a) 파일당 창 (b) 탭 (c) 폴더 사이드바 | 추천은 (a)였으나 사용자가 **(b)+(c) MVP 포함**을 택함 | 한 창에 폴더 사이드바 + 탭 구조. 범위가 커지므로 §5 티켓 확장 | **(b)+(c) 확정** |
| D7 | 데이터 저장 | (a) 파일 시스템만(설정은 JSON) (b) 자체 라이브러리/DB | **(a)** | 사용자의 `.md` 파일이 진실 원본. 인덱싱·DB는 범위 밖 | **(a) 확정** |
| D8 | 저장소·공유 | 별도 저장소, 서명/빌드 스크립트는 layout에서 복사 | **별도 저장소** | layout D8과 동일. 공용화는 네 번째 형제 이후로 미룬다 | **별도 저장소 확정** |

소소한 확정안(이견 없으면 그대로): 제품명 **IYAGI Markdown**, 번들 식별자 `ai.iyagi.markdown`, 실행 파일 `iyagi-markdown`, Apache-2.0, 최소 macOS 13, Apple Silicon 우선, 기본 개발 포트 1422.

## 1. 목표와 범위

### 1-1. 한 줄 정의

`.md` 파일을 더블클릭하면 즉시 깔끔하게 렌더링해 보여 주고, 필요하면 같은 창에서 바로 편집·저장할 수 있는 **경량 macOS 마크다운 리더/에디터**.

### 1-2. "경량"의 정의 (측정 가능한 목표)

| 지표 | 목표 | 비고 |
|---|---|---|
| 설치 크기(.app) | ≤ 20MB | CM6는 가볍다. KaTeX 폰트·mermaid(~2MB)는 지연 로딩 청크 |
| 콜드 스타트 → 첫 렌더 | ≤ 700ms | 읽기 모드는 초기 청크만 로드 |
| 창 1개 유휴 메모리 | ≤ 120MB | WKWebView 한계, 실측 후 조정 |
| 1MB 문서 열기/입력 지연 | ≤ 300ms / 체감 끊김 없음 | 장식·위젯은 뷰포트 범위만 계산(§7) |
| 무거운 기능 | 지연 로딩 | mermaid, KaTeX는 문서에 있을 때만 로드 |

### 1-3. MVP (MUST)

1. `.md`/`.markdown` 파일 연결, 더블클릭/Dock 드롭/`open -a`/`File › Open`으로 열기.
2. 읽기 모드: GFM(표, 작업 목록, 취소선, 자동 링크, 각주), 코드 하이라이트, 이미지(상대 경로 포함), 목차(TOC) 패널, **수식(KaTeX)**, **다이어그램(mermaid)**. 수식·mermaid는 문서에 있을 때만 지연 로딩.
3. **원문 무변환 편집**: CodeMirror 6 라이브 프리뷰(제목·강조·링크·표·코드·수식·mermaid를 위젯/장식으로 렌더, 커서가 있는 블록은 원문 노출). 저장(`Cmd+S`)·다른 이름으로 저장. 저장 내용 = 버퍼 텍스트 그대로(§4-2).
3-2. **내보내기**: `File › Export As…` 에서 HTML(단일 파일, CSS·이미지 인라인), PDF, DOCX. 수식·mermaid·코드 하이라이트 포함(§4-4).
3-1. **폴더 사이드바**(폴더 열기, 트리, `.md` 필터, 파일 감시) + **탭**(여러 문서, 드래그 순서 변경, `Cmd+W`/`Cmd+T` 등, 세션 복원).
4. 외부 변경 감지: 다른 편집기에서 파일이 바뀌면 자동 다시 읽기(수정 중이면 충돌 안내).
5. 라이트/다크 자동(시스템 따름) + 글꼴 크기 조절.
6. 문서 내 검색(`Cmd+F`), 링크 클릭(외부는 기본 브라우저, 상대 `.md`는 앱 내 열기).
7. 최근 문서, 미저장 확인, 창 상태 복원.

### 1-4. 후속 (SHOULD / MAY)

프런트매터 표시, 내보내기 옵션 확장(머리글/바닥글, 템플릿), 테마 선택, 빠른 열기(`Cmd+P`), 폴더 전체 검색, Quick Look 확장, 탭을 새 창으로 분리.

### 1-5. 범위 밖 (MUST NOT)

노트 관리/백링크(Obsidian류), 동기화·클라우드, 협업, 플러그인 시스템, Mac App Store 배포, Windows/Linux.

## 2. 기술 스택 검토 (D1)

| 기준 | (a) Tauri 2 + React | (b) Swift/AppKit + WKWebView |
|---|---|---|
| 렌더링/에디터 생태계 | CodeMirror 6, lezer-markdown 그대로 | 결국 WKWebView 안에서 같은 JS를 씀 |
| 파일 연결/Open 이벤트 | `RunEvent::Opened`(macOS), Info.plist 문서 타입 | 가장 자연스러움 |
| 번들·서명·공증·CI | layout/term 스크립트 재사용 | 새 파이프라인 필요 |
| 유휴 메모리 | WKWebView 공통 → 두 방식 차이 작음 | 약간 유리 |
| 일관성/유지보수 | 형제와 동일 | 새 툴체인 |

(b)의 이득은 작고 렌더 엔진이 어차피 WebView이므로 **(a)를 추천**. 파일 IO·감시·창 관리 같은 비-UI 로직은 Tauri와 무관한 crate로 분리해 훗날 셸 교체 여지를 남긴다.

## 3. 아키텍처와 저장소 구조

```
iyagi-markdown/
├─ Cargo.toml                 # workspace
├─ crates/
│  ├─ md-core/                # 순수 Rust: 설정 스키마, 경로/링크 해석, 폴더 트리 스캔, 세션 모델, 최근 문서, i18n 키 (OS 무관, 리눅스 CI 가능)
│  └─ md-macos/               # macOS 전용: 파일 연결 이벤트 보조, 보안 범위 북마크(필요 시), 로케일
├─ src-tauri/                 # Tauri 셸: 명령(read/write/watch), 메뉴, 창 관리, 이벤트 연결
├─ src/                       # React + TS
│  ├─ app/                    # 창 셸, 모드 전환, 상태
│  ├─ editor/                 # CodeMirror 6 + lezer-markdown, 라이브 프리뷰 장식/위젯, 모드(읽기/편집/소스)
│  ├─ plugins/                # KaTeX, mermaid, 코드 하이라이트 (지연 로딩)
│  ├─ workspace/              # 폴더 사이드바(트리), 탭 상태, 세션 복원
│  ├─ toc/ search/ settings/
│  └─ i18n.ts
├─ scripts/                   # tauri.mjs, macos-sign-runner.sh 등 layout에서 복사
├─ docs/ · .github/workflows/ci.yml
```

데이터 흐름: Rust가 파일을 **바이트 그대로** 읽어 텍스트로 전달 → 편집 상태는 프런트의 CodeMirror 버퍼가 소유(문서 = 마크다운 원문) → 저장 시 Rust 명령이 버퍼를 그대로 원자적 쓰기(임시 파일 → rename) → `notify`가 외부 변경을 감지해 이벤트 발행. 마크다운을 다른 형식으로 바꿔 저장하는 경로는 존재하지 않는다.

## 4. 핵심 설계

### 4-1. 렌더·편집 엔진 (CodeMirror 6 라이브 프리뷰)

문서 모델은 마크다운 **텍스트 그 자체**다. `lezer-markdown`(GFM 확장)이 구문 트리를 만들고, 그 트리는 **표시용 읽기 전용 정보**로만 쓴다: 구문 기호(`#`, `**`, `[]()` 등)는 `Decoration.replace`/`mark`로 숨기거나 스타일링하고, 표·이미지·수식(KaTeX)·mermaid·체크박스는 `WidgetType` 위젯으로 그린다. 커서/선택이 걸친 블록은 장식을 풀어 원문을 보여 준다(Obsidian 라이브 프리뷰 방식). 사용자의 입력은 항상 텍스트 `ChangeSet`이며, 서식 버튼·단축키(굵게, 목록 등)도 원문에 기호를 삽입하는 텍스트 편집으로 구현한다. 읽기 모드는 `EditorView.editable=false`로 같은 장식을 전부 켠 상태다.

### 4-2. 원문 보존 원칙 (불변 조건)

1. **저장 = 버퍼 텍스트 그대로.** 파싱 결과를 직렬화해 쓰는 코드 경로를 만들지 않는다. 열기만 하고 수정하지 않은 파일은 저장 자체가 일어나지 않는다.
2. **HTML은 사용자에게 드러나지 않는 내부 구현이다.** 편집·저장 경로에는 HTML 변환이 없고, 사용자가 보는 편집 대상·저장 대상은 항상 `.md` 원문이다. HTML/PDF/DOCX는 **사용자가 "내보내기"를 명시적으로 실행했을 때만**, 원본과 별개의 새 파일로 생성한다(§4-4). 내보내기는 원본 `.md`를 절대 수정하지 않고, 내부 임시 HTML은 파일로 남기지 않는다.
3. **raw HTML은 수정하지 않는다.** 문서 안의 HTML 조각은 원문 그대로 두고, 표시는 sanitize한 위젯 또는 회색 원문으로만 한다(편집 불가 변환 없음).
4. CRLF/LF, BOM, 마지막 개행, 인코딩(UTF-8)은 원본 그대로 읽고 그대로 쓴다. 자동 줄바꿈·공백 정리·표 정렬 같은 "자동 서식"은 기본 꺼짐(명시적 명령으로만).
5. **자동 검증**: (a) 열기→무수정→저장 시 바이트 동일(코퍼스), (b) 임의 편집 시퀀스 후 `ChangeSet`을 역적용하면 원본과 바이트 동일, (c) 모드 전환 왕복 시 내용 불변. 이 테스트 실패 = 릴리스 차단.


### 4-3. 출력 불변 원칙: 래스터화 금지, 편집 가능 형태 유지 (2026-10-10 확정)

내보낸 결과물에서 다이어그램·수식은 **항상 대상 형식의 네이티브 벡터/편집 가능 객체**여야 한다. PNG/JPEG 등 래스터화는 어떤 경로에서도 금지하며, "지금은 이미지로 넣고 나중에 고치자"는 선택지를 두지 않는다.

| 요소 | HTML | PDF | DOCX |
|---|---|---|---|
| mermaid | 인라인 `<svg>` | 벡터 경로 | **DrawingML 도형**(선택·이동·텍스트 편집 가능) |
| 수식 | KaTeX HTML+CSS (+MathML 병기) | 벡터 텍스트 | **OMML**(Word 수식 편집기에서 편집 가능) |
| 코드/표 | 텍스트/`<table>` | 텍스트 | 서식 있는 텍스트 / Word 표 |

**mermaid → DrawingML 변환 방식**: 다이어그램 종류별 변환기가 아니라 **범용 SVG → DrawingML 변환기**를 만든다. mermaid 출력은 결국 SVG 기본 요소(`rect`, `circle`, `ellipse`, `line`, `polygon`, `path`, `text`, `g`, `marker`)의 조합이고, DrawingML은 임의 경로를 `custGeom`(사용자 지정 도형)으로 표현할 수 있으므로 **모든 종류의 다이어그램이 편집 가능한 도형 그룹**으로 떨어진다. 변환 단계:

1. `htmlLabels: false`로 렌더 → `foreignObject` 없는 순수 SVG 확보.
2. Rust `usvg`로 파싱·정규화(transform 평탄화, `use`/`marker` 전개, 스타일 계산).
3. 요소 매핑: `rect`→`rect`/`roundRect`, `circle`/`ellipse`→`ellipse`, `line`/`polyline`→커넥터 또는 `custGeom`, `path`→`custGeom`(베지어 포함), `text`→텍스트 상자(글꼴·크기·정렬 유지), `g`→`wpg:grpSp` 그룹. 화살표 머리는 선 끝 장식(`headEnd`)으로 변환.
4. 지원하지 않는 시각 효과(그라데이션·필터·대시 패턴 일부)는 **단색·실선으로 단순화하되 도형은 유지**한다. 래스터 폴백은 없다.
5. 결과 검증: Word(최신)·Pages·LibreOffice에서 열어 도형 선택·텍스트 편집이 되는지 수동 QA, 자동으로는 OOXML 스키마 검증.

**수식 → OMML 변환 방식**: KaTeX 파싱 결과를 MathML로 출력(KaTeX `output: 'mathml'`) → Rust에서 **MathML → OMML 변환기**(Microsoft MML2OMML 매핑 규칙을 참고해 Presentation MathML 부분집합 구현: `mrow mi mn mo mfrac msup msub msubsup msqrt mroot munderover mtable mfenced mtext mspace`). 지원 밖 구조는 OMML `m:r` 텍스트로 넣어 **여전히 수식 객체 안에서 편집 가능**하게 둔다(이미지 폴백 없음).

- **편집/읽기 화면:** mermaid SVG를 위젯 DOM에 인라인 `<svg>`로 마운트한다(`<img>`·data URI·canvas 비트맵 사용 안 함). 테마에 맞춰 다시 그린다.
- 어떤 경로에서도 PNG/JPEG 래스터화를 하지 않는다.


### 4-4. 내보내기 (HTML / PDF / DOCX)

원칙: 내보내기는 `.md` → 새 파일의 **단방향 출력**이다. 사용자 화면에는 "형식 선택 → 저장 위치 → 완료"만 보이고 중간 변환물(HTML 등)은 노출되지 않는다.

| 형식 | 방법 | 비고 |
|---|---|---|
| HTML | 내보내기 전용 렌더러(markdown-it + GFM + KaTeX + highlight, 프런트에서 lazy)로 생성 → CSS·폰트·이미지를 인라인한 **자체 완결형 단일 `.html`** | mermaid는 **본문에 인라인 `<svg>`로 직접 삽입**(`<img>`/base64/PNG 아님), 수식은 KaTeX HTML+CSS. 스크립트 포함 안 함 |
| PDF | 위 HTML을 숨은 WebView에 로드 → macOS `WKWebView` PDF 생성(`createPDF`/인쇄 연산, objc2 바인딩) | 페이지 크기·여백 옵션, 코드블록/표 페이지 분할 처리. 임시 HTML은 메모리/임시 폴더에서 즉시 삭제. mermaid는 인라인 SVG가 WebKit PDF 변환에서 **벡터 경로로 그대로 출력**된다(래스터화 없음, 확대해도 선명) |
| DOCX | Rust: `comrak` AST → `docx-rs`로 직접 생성(외부 Pandoc 의존 없음, 경량 유지) | 제목·목록·표·코드·링크·이미지 지원. mermaid는 범용 SVG→DrawingML 변환기로 **편집 가능한 도형 그룹**, 수식은 **OMML**(§4-3). 래스터·SVG 폴백 없음. 스타일은 Word 기본 스타일 이름 사용 |

편집 화면(CM6 위젯)과 내보내기 렌더러는 별개 파이프라인이라 모양이 미세하게 다를 수 있다 → 공통 CSS 토큰과 스냅샷 테스트로 차이를 관리한다. Pandoc 연동은 옵션 기능으로만 고려한다(설치 필요, 기본 제외).

### 4-5. 파일 연결과 열기

`src-tauri/Info.plist`의 `CFBundleDocumentTypes`(UTI `net.daringfireball.markdown`, 확장자 md/markdown, Role: Editor)와 Tauri `bundle.fileAssociations`. 실행 중 열기는 `RunEvent::Opened { urls }`, 첫 실행 시 인자/이벤트 모두 처리. 이미 열린 파일은 해당 창을 앞으로. 단일 인스턴스 플러그인으로 중복 프로세스 방지.

### 4-6. 보안

- raw HTML 조각은 표시할 때만 DOMPurify로 sanitize한다(스크립트·이벤트 속성 제거; 원문은 불변). mermaid는 `securityLevel: 'strict'`, KaTeX는 `trust: false`.
- CSP: `default-src 'self'`, 이미지는 `asset:`(Tauri asset 프로토콜)로 **문서 폴더 하위만** 범위 허용, 원격 이미지는 **기본 불러옴**, 설정으로 끄기 가능(2026-10-10 확정). 끄면 자리표시자 + 클릭 시 해당 이미지만 로드.
- 링크는 직접 이동 금지, 항상 가로채 `opener`/내부 열기로 처리.
- 앱 샌드박스 없음(layout과 동일, 공증 DMG 배포) → 임의 경로 읽기 가능하지만 Tauri capability로 명령 최소화.

### 4-7. 설정

`~/Library/Application Support/ai.iyagi.markdown/settings.json`(글꼴, 크기, 줄 폭, 기본 모드, 원격 이미지, 언어). 항목 10개 내외, JSON 직접 편집 가능(layout D7과 동일).

### 4-8. 다국어

layout의 `i18n.rs`/`i18n.ts` 구조를 따라 ko/en 우선, ja/zh는 후속.

### 4-9. 서명/배포

layout의 `scripts/tauri.mjs` + `macos-sign-runner.sh` 그대로(안정 서명으로 개발 중 TCC 문제 방지는 이 앱엔 덜 중요하지만 Dock 이름/번들 일관성 때문에 유지). Developer ID 서명 + 공증 DMG, GitHub Actions 구성도 layout `ci.yml` 복사 후 수정.

## 5. 구현 티켓

| 티켓 | 내용 | 완료 조건 |
|---|---|---|
| M01 | 저장소 골격: workspace, Tauri, Vite+React, 스크립트·CI 복사, 앱 아이콘 | `npm run tauri dev` 창 표시 |
| M02 | 파일 열기: 연결, `Opened` 이벤트, 열기 대화상자, 최근 문서 | 더블클릭으로 내용이 로드됨 |
| M03 | CM6 라이브 프리뷰 기초: 제목·강조·링크·코드·목록 장식, 읽기 전용 모드, GFM 표/체크박스 위젯, 이미지 경로 | 코퍼스 열기→저장 바이트 동일 |
| M04 | 편집 명령(서식 단축키 = 텍스트 삽입), 원자적 저장, 미저장 처리, 줄 끝/BOM 보존 | 무수정 시 저장 안 됨, ChangeSet 역적용 테스트 통과 |
| M05 | 소스 모드(장식 제거) 전환 + 선택/스크롤 유지 | 전환 왕복 시 내용 불변 |
| M06 | 탭 모델: 열기/닫기/순서/dirty 표시/세션 복원 | 재실행 시 탭 복원 |
| M07 | 폴더 사이드바: 트리, `.md` 필터, 파일 감시(`notify`), 외부 변경 충돌 처리 | 외부 수정이 탭에 반영/경고 |
| M08 | KaTeX·mermaid 위젯(지연 로딩), 오류 시 원문 표시 | 샘플 문서 렌더 + 번들 청크 분리 확인 |
| M09a | 내보내기: HTML(자체 완결형) + PDF(WKWebView) | 샘플 문서 결과 스냅샷, 원본 `.md` 바이트 불변 |
| M09b | 내보내기: DOCX(comrak→docx-rs), 이미지·표·코드 | Word/Pages에서 열림 확인 |
| M09c | 범용 SVG→DrawingML 변환기(`usvg` 기반, custGeom·그룹·텍스트 상자·화살표) | mermaid 전 종류 샘플이 Word에서 도형 선택·텍스트 편집 가능, 래스터 0건 |
| M09d | MathML→OMML 변환기(Presentation MathML 부분집합) | 수식 샘플이 Word 수식 편집기에서 열림 |
| M09 | TOC 패널, 문서 내 검색, 링크 처리(상대 `.md`는 새 탭) | 링크 이동/검색 동작 |
| M10 | 테마(라이트/다크), 설정 파일·창, i18n | 시스템 외관 추종 |
| M11 | 성능·번들 점검(§1-2), 큰 문서 대응 | 지표 달성 또는 목표 재합의 |
| M12 | 서명·공증·DMG·릴리스 | 새 Mac에서 Gatekeeper 통과 |

## 6. 검증

- 단위(vitest): 링크 해석, **원문 보존 테스트 3종(§4-2 5항)**, sanitize 우회 케이스(XSS 목록), 탭/세션 상태 리듀서.
- Rust: `md-core` 설정/경로 테스트, 원자적 저장 테스트.
- 수동 QA: 한글 IME 입력, 큰 파일(5MB), CRLF/UTF-8 BOM, 심볼릭 링크, 외부 편집 충돌, 다크/라이트 전환, 여러 창.

## 7. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 라이브 프리뷰 장식과 한글 IME 조합 충돌 | 조합 중에는 해당 블록 장식 해제, QA 매트릭스에 포함 |
| 큰 문서에서 위젯/장식 비용 | 뷰포트 범위만 장식(CM6 기본), 임계 크기 초과 시 소스 모드 권유 |
| 번들/메모리가 "경량" 기대를 넘김 | 지연 로딩(mermaid·KaTeX), 비활성 탭은 EditorState만 보관하고 View 해제 |
| mermaid 보안·크기 | strict 모드, 첫 사용 시에만 로드 |
| SVG→DrawingML·MathML→OMML 변환기 자체 구현 부담 | 기성 Rust 크레이트가 없어 직접 작성(가장 큰 공수 항목). 범용 변환이라 다이어그램 종류별 작업은 없고, 테스트 코퍼스(mermaid 공식 예제 전체 + 수식 샘플)로 회귀 방지. 일정상 M09c/M09d를 MVP 마지막 순서로 둔다 |
| raw HTML/XSS | 표시 시에만 DOMPurify, CSP 이중 방어, 원문 불변 |
| 파일 연결이 다른 앱과 경쟁 | 기본 앱 지정은 사용자 몫(안내 문구), 강제하지 않음 |
| WebView 메모리가 "경량" 기대에 못 미침 | 창 닫으면 WebView 해제, 측정치를 README에 정직하게 기재 |

## 8. 참고

- iyagi-layout `IMPLEMENTATION_PLAN.md`, `scripts/tauri.mjs`, `.github/workflows/ci.yml`
- Tauri 2 file associations / `RunEvent::Opened`, CodeMirror 6 + lezer-markdown, KaTeX, mermaid, DOMPurify
