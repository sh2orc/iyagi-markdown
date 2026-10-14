# IYAGI Markdown 구조

작성: 2026-10-14 · 150차 고도화(404 테스트 통과 — 프런트 319 · Rust 85).

## 저장소

```
iyagi-markdown/
├─ Cargo.toml              # workspace
├─ crates/
│  ├─ md-core/             # 순수 Rust: 문서 IO·링크·트리·세션·설정·i18n·검색·스냅숏
│  ├─ md-export/           # 순수 Rust: DOCX(OOXML 직접 생성) + SVG→DrawingML + MathML→OMML
│  └─ md-macos/            # macOS 전용: 선호 언어(NSUserDefaults)
├─ src-tauri/              # Tauri 셸: 명령·감시·메뉴·창·PDF(WKWebView)·클립보드 이미지
├─ src/                    # React + TS
│  ├─ app/store.ts         # 탭·워크스페이스·설정 상태(의존 주입형 IO — 테스트 가능)
│  ├─ app/docStyle.ts      # 문서별 스타일(프리셋 포함) — CSS 변수 적용
│  ├─ editor/              # CM6: mathSyntax·wikiLink·tags·highlight·livePreview·widgets
│  │  ├─ livePreview.ts    # 청크 증분 장식(§7) — 뷰포트 범위 + 스팬 단위 노출
│  │  ├─ writing.ts        # 타이프라이터 스크롤·포커스 모드·문장 포커스
│  │  ├─ wikiComplete.ts   # "[[" 자동완성
│  │  ├─ diff.ts           # 줄 단위 diff(LCS + 트리밍 휴리스틱)
│  │  ├─ tableFormat.ts    # 표 파이프 열 맞춤(전각 폭 반영)
│  │  ├─ frontmatter.ts    # YAML 프런트매터 파싱·표시
│  │  └─ htmlPaste.ts      # HTML→마크다운 붙여넣기 변환
│  ├─ plugins/             # katex·mermaid·highlight — 전부 지연 로딩
│  ├─ search/searchCm.ts   # 문서 내 검색(증분 매치 갱신)
│  ├─ export/html.ts       # 자체 완결형 HTML 빌더 + DOCX 매니페스트
│  ├─ components/          # TabBar·Sidebar·TocPanel·SearchPanel·Toolbar·MiniToolbar
│  │  ├─ CommandPalette.tsx # ⌘⇧P — 모든 명령 퍼지 검색
│  │  ├─ WorkspaceSearch.tsx # ⇧⌘F — 폴더 전체 검색 + 모두 바꾸기
│  │  ├─ DiffPanel.tsx     # 문서 비교
│  │  ├─ VersionsPanel.tsx # 버전 기록(스냅숏)
│  │  ├─ BacklinksPanel.tsx# 백링크
│  │  ├─ ImageViewer.tsx   # 확대 뷰어
│  │  ├─ ExportSheet.tsx   # HTML/PDF/DOCX 내보내기 옵션
│  │  ├─ StylePanel.tsx    # 문서별 스타일(프리셋 포함)
│  │  └─ PrintPreview.tsx  # 인쇄 미리보기
│  └─ i18n.ts              # ko/en 문구
├─ scripts/                # tauri.mjs(안정 서명)·macos-sign-runner.sh·generate_icon.py
└─ .github/workflows/ci.yml
```

## 원문 보존 — 불변 조건(§4-2)

- 읽기(`md-core::io::read_doc`): 바이트 → BOM 제거 → UTF-8 검증 → `\n` 정규화.
  BOM·CRLF 여부는 `DocMeta`로 **기록만** 한다.
- 쓰기(`write_doc_atomic`): 버퍼 텍스트 + 메타로 재인코딩 → 임시 파일 → fsync → rename.
- 무수정 저장은 일어나지 않는다: `App.saveActive`가 `doc == savedText`면 no-op.
- 자동 검증 3종(vitest `src/preservation.test.ts`):
  (a) 무수정 저장 no-op, (b) 랜덤 편집 200회 역적용 → 원문 복원,
  (c) 모드 전환 왕복 시 내용·선택 불변. 이 실패는 릴리스 차단.
- **모든 기능이 이 원칙 위에서 동작한다**: 서식·표 편집·위키링크·이미지 크기·
  책갈피·스타일 — 전부 텍스트 편집이거나 SQLite 사이드카.

## 사이드카 데이터(SQLite styles.db)

원문을 건드리지 않고 문서별로 저장되는 것:

| 테이블 | 내용 |
|---|---|
| `doc_style` | 폰트·크기·행간·간격·정렬·들여쓰기·강조색·이미지 폭·표 열 폭 |
| `doc_bookmark` | 책갈피 줄 번호 |

## 라이브 프리뷰(§4-1)

- 구문 트리(lezer-markdown + GFM + `$…$`/`$$…$$` + `[^각주]` + `[[위키링크]]` +
  `#태그` + `==하이라이트==`)는 **표시용 읽기 전용**.
- **청크 증분 렌더**: 문서를 ~4k자 청크로 나눠 각 청크를 정확히 한 번만 계산.
  커서 이동당 재계산 = 청크 1~2개(문서 크기와 무관한 상수 비용).
- 블록(표·수식·다이어그램·제목)은 커서 줄 기준 노출, 인라인(`**`·`` ` ``·링크·
  `$…$`)은 **스팬 단위**(±1자) 노출(Typora 모델).
- 빈 줄은 0.42배 높이로 축소.
- 위젯: Math(KaTeX)·Diagram(mermaid)·Table·Task·Image(폭 드래그)·HRule·
  Bullet(깊이별 글리프)·Highlight.

## 집필 모드(src/editor/writing.ts)

- **타이프라이터 스크롤**: 입력 시에만 커서 줄을 세로 중앙으로.
- **포커스 모드**: 커서가 속한 최상위 블록 외 흐림(iA Writer).
- **문장 포커스**: 현재 문장만 또렷하게(선택적).

## 노트 체계

- **위키링크** `[[이름]]`: 구문 인식 → 라이브 프리뷰 링크색 → 클릭 이동 →
  대상 없으면 새 파일 생성. `[[이름|표시]]`, `[[이름#앵커]]` 지원.
- **자동완성**: `[[` 입력 시 워크스페이스 문서 목록 팝업(서브시퀀스 퍼지).
- **백링크**: 이 문서를 `[[참조]]`하는 문서들 — 상태 줄 "🔗 N" 클릭 → 패널.
- **태그** `#태그`: pill 표시 → 클릭 → 워크스페이스 태그 검색.
- **빠른 열기**(명령 팔레트에서 파일 퍼지 검색), **폴더 전체 검색**(⇧⌘F) +
  **모두 바꾸기**(원자적 저장·메타 보존) — 문서 내 검색은 대소문자·정규식·
  **단어 단위**([w]) 토글.
- **입력 보조**: 스마트 문장부호(“”·…·–, 코드·수식 안 제외) · 서식 복사
  (Format Painter ⌥⌘C/⌥⌘V) · 서식 없이 붙여넣기(⌥⌘⇧V) · 특수 문자 패널 ·
  링크/이미지 설명 편집 대화상자 · 표 삽입 크기 지정 · 각주 호버 미리보기.
- **버전 기록**: 저장 직전 상태를 스냅숏(30개·60초 간격) — diff 미리보기 후 복원.
- **메모(Word "메모")**: 줄 앵커 사이드카 — 우클릭 추가·앰버 바·호버 팝오버·
  패널(편집·해결·삭제)·DOCX 원생 메모(commentRange/comments.xml)로 내보내기.
- **캡션**: 그림(`![설명](src)`)·표(표 아래 `: 설명` — Pandoc 규약) — 편집기
  표시·4경로 내보내기·SEQ 필드·그림/표 목차(lof/lot).
- **검수 허브**: 끊긴 링크(수)·긴 문장(수·점선 표시 토글)·고아 이미지(삭제).
- **파일 관리**: 사이드바 우클릭 — 새 문서·이름 변경·복제·Finder 보기.
- **편집 보조**: 스마트 문장부호·서식 복사(⌥⌘C/V)·서식 없이 붙여넣기·
  표 셀 Tab(끝에서 새 행)·특수 문자 패널·링크/이미지 설명 편집·
  같은 단어 강조·문법 노출은 '선택이 덮을 때만'.
- **변경 추적(Word Track Changes)**: 베이스라인 사이드카 diff — 본문
  표시·상태 줄 +N−R·검토 패널(이동·↺ 되돌리기·모두 수락)·다음/이전 탐색.
- **개요 재배치·분할 편집**: 목차 패널 드래그로 섹션 이동, 참조 보기 ✎로
  두 문서 동시 편집(뷰·탭 라우팅).
- **클릭=편집 규칙**: 텍스트류는 렌더 유지·문법은 선택 덮음 시만 노출,
  표 셀·수식 블록·다이어그램·프런트매터는 클릭으로 원문 진입.
- **접기**: 제목·목록·코드펜스·인용 — 거터 화살표.
- **세션 연속성**: 탭·커서·창·폭·참조 보기·접힌 폴더·찾기 상태·내보내기 옵션.

## 내보내기(§4-3/§4-4)

### HTML(프런트 `src/export/html.ts`)
markdown-it + KaTeX + highlight.js + mermaid(인라인 `<svg>`) + 각주.
이미지 data URI, KaTeX CSS+폰트 인라인, DOMPurify sanitize.
문서별 스타일(폰트·크기·행간·정렬·들여쓰기·강조색) 반영.

### PDF(src-tauri/src/pdf.rs)
CSS 다단 컬럼 페이지네이션(`column-gap = 2×여백`) → createPDF로 넓은
한 페이지 → CoreGraphics로 슬라이스. 전부 벡터. 페이지 번호(N / M) 옵션.

### DOCX(crates/md-export)
comrak AST → OOXML 직접 작성. Word 기본 스타일(제목·번호·표·하이퍼링크) +
문서별 스타일(폰트·크기·행간·정렬·들여쓰기·강조색).
- **SVG→DrawingML**(custGeom·그룹·편집 가능 텍스트 상자·화살표).
- **MathML→OMML**(m:nary·m:acc·m:bar 등 Presentation MathML 부분집합).
- 표: 셀 여백·헤더 음영·정렬 지정. 래스터 폴백 없음.
- 바닥글 페이지 번호(옵션) — PAGE/NUMPAGES 필드, 가운데 9pt 회색.

## 성능 — 실측(§1-2 달성)

| 지표 | 목표 | 실측 |
|---|---|---|
| .app 크기 | ≤ 20MB | 13MB (DMG 8.1MB) |
| 유휴 메모리(RSS) | ≤ 120MB | 102MB |
| 커서 이동 재계산 | — | 청크 1~2개(상수 비용) |
| KaTeX·mermaid·highlight | 지연 로딩 | 별도 청크 — 문서에 있을 때만 |

## 테스트(2026-10-14 기준, 150차)

- **프런트 319개**(vitest): 원문 보존 3종·렌더링 회귀·링크/슬러그·i18n 무결성·
  math/wiki/tags/highlight 구문·표 편집(셀 Tab 이동·새 행)·정렬·들여쓰기·
  diff·HTML 붙여넣기·검색 증분 갱신·스크롤 성능·입력 지연 프로파일·스토어·
  빠른 열기·문장 길이 통계·스마트 문장부호·서식 복사·단어 단위 찾기·
  캡션(그림·표)·정적 목차·목차 트리·CodeMirror 클래스 충돌 가드.
- **Rust 85개**(cargo test): md-core(IO 왕복·링크·트리·세션·설정·검색·
  바꾸기·스냅숏) + md-export(DOCX 생성·SVG 변환·MathML 변환·이미지 포함·
  페이지 번호·머리글·하이퍼링크 스타일·캡션 SEQ·원생 메모·TOC/lof/lot).
- clippy 0 경고.

## 보안(§4-6)

- CSP: `default-src 'self'`, 스크립트 포함 없음.
- raw HTML: 원문 그대로 두고 회색으로만 표시. 내보내기 시에만 DOMPurify.
- mermaid `securityLevel:'strict'`, KaTeX `trust:false`.
- 링크는 항상 가로채 처리(내부 `.md` → 앱 내, 외부 → opener).
