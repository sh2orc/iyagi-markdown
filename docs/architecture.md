# IYAGI Markdown 구조

작성: 2026-10-11 · 구현 1차 완료 시점의 실제 구조.

## 저장소

```
iyagi-markdown/
├─ Cargo.toml              # workspace
├─ crates/
│  ├─ md-core/             # 순수 Rust: 문서 IO·링크 해석·트리·세션·설정·i18n
│  ├─ md-export/           # 순수 Rust: DOCX 생성 + SVG→DrawingML + MathML→OMML
│  └─ md-macos/            # macOS 전용: 선호 언어(NSUserDefaults)
├─ src-tauri/              # Tauri 셸: 명령·감시·메뉴·창·PDF(WKWebView)
├─ src/                    # React + TS
│  ├─ app/store.ts         # 탭·워크스페이스·설정 상태(의존 주입형 IO — 테스트 가능)
│  ├─ editor/              # CM6: mathSyntax(§4-1 확장)·livePreview·widgets·theme·format·cm
│  ├─ plugins/             # katex·mermaid·highlight — 전부 지연 로딩
│  ├─ search/searchCm.ts   # 검색 상태 필드 + 하이라이트 장식
│  ├─ export/html.ts       # 자체 완결형 HTML 빌더 + DOCX 매니페스트
│  ├─ components/          # TabBar·Sidebar·TocPanel·SearchPanel·모달·시트
│  └─ api.ts               # Tauri 명령/이벤트 래퍼
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

## 라이브 프리뷰(§4-1)

- 구문 트리(lezer-markdown + GFM + `$…$`/`$$…$$` 커스텀 확장)는 **표시용 읽기 전용**.
- `livePreview.ts`가 뷰포트 범위에서 장식을 계산해 StateField에 반영한다.
  블록 장식(표·수식·다이어그램 위젯)은 규칙상 StateField에서 제공해야 한다.
- 커서/선택/조합 중인 줄은 `revealed` 집합에 들어가 장식이 풀린다.
- 읽기 모드 = `editable:false` + behavior "render"(항상 장식). 소스 모드는 프리뷰 확장 제거.
- 위젯: Math(KaTeX)·Diagram(mermaid, strict + htmlLabels:false)·Table·Task·Image·HRule.
  체크박스 클릭은 `[ ]`↔`[x]` **텍스트 편집**으로 번역된다.

## 감시(외부 변경)

`src-tauri/src/watcher.rs` — notify. 열린 문서는 **부모 디렉터리**(비재귀)를 감시해
원자적 rename을 놓치지 않고, 워크스페이스는 재귀 감시한다. 자기 저장(1.5초 창)과
`.iyagi-tmp` 임시 파일 이벤트는 무시, 150ms 디바운스. 프런트는 남은 전체 목록으로
`watch_paths`를 다시 부른다(선언적 동기화).

## 내보내기(§4-3/§4-4)

### HTML(프런트 `src/export/html.ts`)
markdown-it + KaTeX + highlight.js + mermaid(인라인 `<svg>`) + 각주.
이미지는 data URI로 인라인, KaTeX CSS+폰트도 문서 안에. DOMPurify로 sanitize.
스크립트는 포함하지 않는다.

### PDF(src-tauri/src/pdf.rs) — 2026-10-11 실험으로 확정된 방식
1. HTML을 `loadHTMLString:`으로 메모리에서 로드(임시 파일 없음).
2. **CSS 다단 컬럼 페이지네이션 주입**: 래퍼를 페이지 폭·높이의 `column-width`로
   흘려 보내면 문서가 가로 컬럼들로 이어진다. `column-gap = 2×여백`으로 두면 페이지
   폭 창이 정확히 타일링되고, **컬럼 경계 = 페이지 경계라 줄이 중간에 잘리지 않는다.**
3. `createPDF`로 전체 폭을 한 넓은 페이지로(전부 벡터).
4. CoreGraphics로 페이지 폭마다 잘라 물리 크기(pt) 문서로 재조립 — 소스 페이지를
   그대로 삽입하므로 2차 전부 벡터. `CGPDFContextCreateWithURL`로 최종 파일에 직접.

(`createPDF`의 rect만으로는 분할이 일어나지 않음을 실험으로 확인하고 이 방식을
택했다. `printOperation`은 대화상자가 필요해 기각.)

### DOCX(crates/md-export)
comrak AST → OOXML을 직접 작성(docx-rs에 없는 OMML/DrawingML 때문). Word 기본
스타일(Heading1-6)·번호 매기기·표·하이퍼링크·이미지(헤더 파싱으로 크기 추출).

- **SVG→DrawingML**(svg2dml.rs): usvg(시스템 폰트 로드)로 정규화 → 각 경로를
  custGeom으로, 텍스트를 `wps:txbx`(편집 가능)로, 그룹을 `wpg:wgp`로. 화살표
  마커는 열린 선에 `a:tailEnd` 장식. 그라디언트는 중간색 단색으로 단순화.
  래스터 폴백 없음.
- **MathML→OMML**(mathml2omml.rs): KaTeX `output:'mathml'` 결과를 Presentation
  부분집합으로 변환(mfrac→m:f, msup→m:sSup, mroot→m:rad, ∑ 극한→m:nary, …).
  지원 밖은 수식 안의 텍스트 실행으로 — 여전히 Word 수식 편집기에서 편집 가능.

수식·다이어그램의 원본(LaTeX·mermaid 코드)→MathML·SVG 변환은 프런트(KaTeX·mermaid
청크)가 미리 계산해 **매니페스트**로 넘긴다(키 = 원본 코드 원문).

## 보안(§4-6)

- CSP: `default-src 'self'`, 이미지는 asset 프로토콜 + 원격 허용(설정으로 차단),
  스크립트 포함 없음.
- raw HTML은 원문 그대로 두고 회색으로만 표시. 내보내기 시에만 DOMPurify.
- mermaid `securityLevel:'strict'`, KaTeX `trust:false`.
- 링크는 항상 가로채 처리(내부 `.md` → 앱 내 열기, 외부 → opener).

## 테스트

- Rust: md-core 32개(IO 왕복·링크·트리·세션·설정·i18n), md-export 25개
  (SVG 변환·MathML 변환·DOCX 생성·이미지 포함).
- vitest 30개: 원문 보존 3종, 링크/슬러그(Rust 벡터와 동일 사례), i18n 무결성,
  math 문법, 표 파서, 검색 매칭, 위젯 DOM.
- 수동 QA 대상(§6): 한글 IME, 5MB 문서, CRLF/BOM, 외부 충돌, 다크/라이트.
