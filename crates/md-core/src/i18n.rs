//! 지원 언어와 Rust 쪽 고정 문구(네이티브 메뉴). 프런트(React) 문구는 `src/i18n.ts`.
//!
//! 규칙은 형제 프로젝트와 같다: 시스템 선호 언어 목록에서 지원하는 첫 언어,
//! 없으면 영어. 현재 ko/en 우선(§4-8).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    En,
    Ko,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ko => "ko",
        }
    }

    /// `ko-KR` 같은 태그 → 지원 언어. 아니면 None.
    pub fn from_tag(tag: &str) -> Option<Lang> {
        let primary = tag.trim().split(['-', '_']).next()?.to_ascii_lowercase();
        match primary.as_str() {
            "en" => Some(Lang::En),
            "ko" => Some(Lang::Ko),
            _ => None,
        }
    }

    /// 선호 언어 목록에서 지원하는 첫 언어, 없으면 영어.
    pub fn detect<I, S>(tags: I) -> Lang
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        tags.into_iter()
            .find_map(|t| Lang::from_tag(t.as_ref()))
            .unwrap_or(Lang::En)
    }
}

/// 네이티브 메뉴 문구. 새 메뉴 항목이 늘면 여기 키를 추가하고 두 언어를 채운다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msg {
    AppMenu,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    File,
    NewTab,
    Open,
    OpenFolder,
    OpenRecent,
    ClearRecent,
    Print,
    Save,
    SaveAs,
    Export,
    ExportHtml,
    ExportPdf,
    ExportDocx,
    CloseTab,
    CloseWindow,
    Edit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Find,
    FindNext,
    FindPrev,
    Replace,
    View,
    ModeEdit,
    ModeRead,
    ModeSource,
    ToggleSidebar,
    ToggleToc,
    ActualSize,
    ZoomIn,
    ZoomOut,
    NextTab,
    PrevTab,
    Window,
    Minimize,
    Zoom,
    BringAllToFront,
    Help,
    Shortcuts,
    CommandPalette,
    Yes,
}

impl Msg {
    pub fn text(self, lang: Lang) -> &'static str {
        let en = |m: Msg| match m {
            Msg::AppMenu => "IYAGI Markdown",
            Msg::About => "About IYAGI Markdown",
            Msg::Services => "Services",
            Msg::Hide => "Hide IYAGI Markdown",
            Msg::HideOthers => "Hide Others",
            Msg::ShowAll => "Show All",
            Msg::Quit => "Quit IYAGI Markdown",
            Msg::File => "File",
            Msg::NewTab => "New Tab",
            Msg::Open => "Open…",
            Msg::OpenFolder => "Open Folder…",
            Msg::OpenRecent => "Open Recent",
            Msg::ClearRecent => "Clear Menu",
            Msg::Print => "Print…",
            Msg::Save => "Save",
            Msg::SaveAs => "Save As…",
            Msg::Export => "Export As…",
            Msg::ExportHtml => "HTML…",
            Msg::ExportPdf => "PDF…",
            Msg::ExportDocx => "Word Document…",
            Msg::CloseTab => "Close Tab",
            Msg::CloseWindow => "Close Window",
            Msg::Edit => "Edit",
            Msg::Undo => "Undo",
            Msg::Redo => "Redo",
            Msg::Cut => "Cut",
            Msg::Copy => "Copy",
            Msg::Paste => "Paste",
            Msg::SelectAll => "Select All",
            Msg::Find => "Find…",
            Msg::FindNext => "Find Next",
            Msg::FindPrev => "Find Previous",
            Msg::Replace => "Replace…",
            Msg::View => "View",
            Msg::ModeEdit => "Editing Mode",
            Msg::ModeRead => "Reading Mode",
            Msg::ModeSource => "Source Mode",
            Msg::ToggleSidebar => "Toggle Sidebar",
            Msg::ToggleToc => "Table of Contents",
            Msg::ActualSize => "Actual Size",
            Msg::ZoomIn => "Zoom In",
            Msg::ZoomOut => "Zoom Out",
            Msg::NextTab => "Show Next Tab",
            Msg::PrevTab => "Show Previous Tab",
            Msg::Window => "Window",
            Msg::Minimize => "Minimize",
            Msg::Zoom => "Zoom",
            Msg::BringAllToFront => "Bring All to Front",
            Msg::Help => "Help",
            Msg::Shortcuts => "Keyboard Shortcuts…",
            Msg::CommandPalette => "Command Palette…",
            Msg::Yes => "Yes",
        };
        let ko = |m: Msg| match m {
            Msg::AppMenu => "IYAGI Markdown",
            Msg::About => "IYAGI Markdown 정보",
            Msg::Services => "서비스",
            Msg::Hide => "IYAGI Markdown 숨기기",
            Msg::HideOthers => "기타 항목 숨기기",
            Msg::ShowAll => "모두 보기",
            Msg::Quit => "IYAGI Markdown 종료",
            Msg::File => "파일",
            Msg::NewTab => "새 탭",
            Msg::Open => "열기…",
            Msg::OpenFolder => "폴더 열기…",
            Msg::OpenRecent => "최근 문서",
            Msg::ClearRecent => "목록 지우기",
            Msg::Print => "인쇄…",
            Msg::Save => "저장",
            Msg::SaveAs => "다른 이름으로 저장…",
            Msg::Export => "내보내기…",
            Msg::ExportHtml => "HTML…",
            Msg::ExportPdf => "PDF…",
            Msg::ExportDocx => "Word 문서…",
            Msg::CloseTab => "탭 닫기",
            Msg::CloseWindow => "창 닫기",
            Msg::Edit => "편집",
            Msg::Undo => "실행 취소",
            Msg::Redo => "다시 실행",
            Msg::Cut => "잘라내기",
            Msg::Copy => "복사",
            Msg::Paste => "붙여넣기",
            Msg::SelectAll => "모두 선택",
            Msg::Find => "찾기…",
            Msg::FindNext => "다음 찾기",
            Msg::FindPrev => "이전 찾기",
            Msg::Replace => "바꾸기…",
            Msg::View => "보기",
            Msg::ModeEdit => "편집 모드",
            Msg::ModeRead => "읽기 모드",
            Msg::ModeSource => "소스 모드",
            Msg::ToggleSidebar => "사이드바 보기/숨기기",
            Msg::ToggleToc => "목차",
            Msg::ActualSize => "실제 크기로",
            Msg::ZoomIn => "확대",
            Msg::ZoomOut => "축소",
            Msg::NextTab => "다음 탭 보기",
            Msg::PrevTab => "이전 탭 보기",
            Msg::Window => "윈도우",
            Msg::Minimize => "최소화",
            Msg::Zoom => "확대/축소",
            Msg::BringAllToFront => "모두 앞으로 가져오기",
            Msg::Help => "도움말",
            Msg::Shortcuts => "키보드 단축키…",
            Msg::CommandPalette => "명령 팔레트…",
            Msg::Yes => "예",
        };
        match lang {
            Lang::En => en(self),
            Lang::Ko => ko(self),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_prefers_first_supported() {
        assert_eq!(Lang::detect(["fr-FR", "ko-KR", "en-US"]), Lang::Ko);
        assert_eq!(Lang::detect(["en-US", "ko-KR"]), Lang::En);
        assert_eq!(Lang::detect(["zh-Hans"]), Lang::En);
        assert_eq!(Lang::detect(Vec::<String>::new()), Lang::En);
    }

    #[test]
    fn every_msg_has_both_languages() {
        // 키가 늘면 한쪽 언어를 빠뜨리기 쉽다 — 전 순회로 문장이 비지 않았는지 확인.
        let all = [
            Msg::AppMenu,
            Msg::About,
            Msg::Services,
            Msg::Hide,
            Msg::HideOthers,
            Msg::ShowAll,
            Msg::Quit,
            Msg::File,
            Msg::NewTab,
            Msg::Open,
            Msg::OpenFolder,
            Msg::OpenRecent,
            Msg::ClearRecent,
            Msg::Save,
            Msg::SaveAs,
            Msg::Export,
            Msg::ExportHtml,
            Msg::ExportPdf,
            Msg::ExportDocx,
            Msg::CloseTab,
            Msg::CloseWindow,
            Msg::Edit,
            Msg::Undo,
            Msg::Redo,
            Msg::Cut,
            Msg::Copy,
            Msg::Paste,
            Msg::SelectAll,
            Msg::Find,
            Msg::FindNext,
            Msg::FindPrev,
            Msg::Replace,
            Msg::View,
            Msg::ModeEdit,
            Msg::ModeRead,
            Msg::ModeSource,
            Msg::ToggleSidebar,
            Msg::ToggleToc,
            Msg::ActualSize,
            Msg::ZoomIn,
            Msg::ZoomOut,
            Msg::NextTab,
            Msg::PrevTab,
            Msg::Window,
            Msg::Minimize,
            Msg::Zoom,
            Msg::BringAllToFront,
            Msg::Help,
            Msg::Yes,
        ];
        for m in all {
            assert!(!m.text(Lang::En).is_empty(), "{m:?} en 문구 없음");
            assert!(!m.text(Lang::Ko).is_empty(), "{m:?} ko 문구 없음");
        }
    }
}
