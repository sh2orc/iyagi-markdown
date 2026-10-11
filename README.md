# IYAGI Markdown

`.md` 파일을 더블클릭하면 즉시 깔끔하게 렌더링해 보여 주고, 같은 창에서 바로 편집·저장할 수
있는 **경량 macOS 마크다운 리더/에디터**. Tauri 2 + Rust + React/TS + CodeMirror 6.

- **원문 무손실**: 문서는 언제나 마크다운 텍스트 그 자체다. 저장은 버퍼를 그대로 원자적으로
  쓴다(임시 파일 → rename). BOM·CRLF/LF·마지막 개행이 보존되고, 수정하지 않은 문서는
  저장 자체가 일어나지 않는다. HTML 변환을 거치는 편집 경로는 존재하지 않는다.
- **라이브 프리뷰(WYSIWYG)**: 제목·강조·링크·표·체크박스·이미지·수식(KaTeX)·다이어그램
  (mermaid)을 CodeMirror 6 장식·위젯으로 렌더한다. 커서가 있는 블록만 원문이 드러난다
  (Obsidian 방식). 같은 버퍼를 보는 읽기(⌘E)·편집·소스(⌘/) 세 가지 보기일 뿐 — 전환에
  변환이 없다.
- **출력 불변**: 내보내기의 다이어그램·수식은 항상 대상 형식의 네이티브 벡터·편집 가능
  객체다. PDF는 벡터 경로, DOCX는 DrawingML 도형 그룹과 OMML 수식. 어떤 경로에서도
  래스터화하지 않는다.
- **가볍게**: KaTeX·mermaid·코드 하이라이트는 문서에 있을 때만 로드되는 지연 청크.
  비활성 탭은 EditorState만 메모리에 남는다.

## 기능

- 파일 연결(`.md`/`.markdown`) — 더블클릭·Dock 드롭·`open -a`·파일 › 열기
- GFM: 표, 작업 목록, 취소선, 자동 링크 + 각주(HTML 내보내기)
- 폴더 사이드바(트리·파일 감시) + 탭(드래그 순서·세션 복원)
- 문서 내 검색/바꾸기(대소문자·정규식), 목차(TOC) 패널
- 외부 변경 감지 — 수정 중이면 충돌 안내, 아니면 자동 다시 읽기
- 내보내기: HTML(자체 완결형 단일 파일), PDF(용지·여백·배율), DOCX(Word 수식·도형 편집 가능)
- 라이트/다크 자동(시스템 추종), 글꼴 크기·읽기 단 폭, 원격 이미지 정책
- 최근 문서, 미저장 확인, 창 상태 복원, 한국어/영어 UI

## 개발

```sh
npm install
npm run tauri dev      # 개발 실행(포트 1422)
npm run test:unit      # 프런트 단위 테스트(원문 보존 3종 포함)
cargo test --workspace # Rust 테스트(md-core·md-export)
npm run tauri build    # .app + DMG
```

구조와 설계 원칙은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)을, 구현 상세는
[docs/architecture.md](docs/architecture.md)를 본다.

## 성능 목표(§1-2)

| 지표 | 목표 |
|---|---|
| 설치 크기(.app) | ≤ 20MB |
| 콜드 스타트 → 첫 렌더 | ≤ 700ms |
| 창 1개 유휴 메모리 | ≤ 120MB |
| 1MB 문서 입력 지연 | 체감 끊김 없음(뷰포트 장식) |

측정치는 릴리스 노트에 정직하게 기재한다.

## 라이선스

Apache-2.0. 형제 프로젝트: [iyagi-layout](../iyagi-layout), [iyagi-term](../iyagi-term).
