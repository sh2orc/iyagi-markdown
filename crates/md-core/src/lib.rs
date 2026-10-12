//! IYAGI Markdown의 OS 무관 순수 로직 모음.
//!
//! - [`io`]: 원문 보존 원칙(IMPLEMENTATION_PLAN §4-2)을 지키는 문서 읽기/원자적 쓰기.
//!   BOM·CRLF/LF를 기억했다가 저장 시 그대로 되살리며, 수정하지 않은 문서는
//!   저장 자체가 일어나지 않는다(저장 여부의 판단은 프런트의 dirty 플래그).
//! - [`links`]: 상대 링크·이미지 경로 해석(외부/앵커/`.md`/이미지 분류)과
//!   GitHub 방식 제목 슬러그.
//! - [`tree`]: 폴더 스캔 → `.md` 트리(사이드바).
//! - [`session`]: 탭·사이드바·창 상태의 세션 모델과 저장/복원.
//! - [`recent`]: 최근 문서 목록.
//! - [`settings`]: 설정 스키마(`settings.json`).
//! - [`i18n`]: Rust 쪽 고정 문구(네이티브 메뉴). 프런트 문구는 `src/i18n.ts`.
//!
//! 이 크레이트는 Tauri·macOS에 의존하지 않아 리눅스 CI에서 단위 테스트가 돈다.

pub mod i18n;
pub mod io;
pub mod links;
pub mod recent;
pub mod search;
pub mod session;
pub mod snapshots;
pub mod settings;
pub mod tree;
