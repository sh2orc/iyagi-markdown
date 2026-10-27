//! 앱 종료는 살아 있는 모든 창의 저장 확인을 받아야 한다.
use std::collections::BTreeSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Default)]
pub struct QuitState(Mutex<Coordinator>);

#[derive(Default)]
struct Coordinator {
    generation: u32,
    active: Option<Round>,
    confirmed: bool,
}

struct Round {
    id: u32,
    windows: BTreeSet<String>,
    approved: BTreeSet<String>,
    current: String,
}

#[derive(Debug, PartialEq)]
enum Action {
    None,
    Ask(u32, String),
    Cancel(u32),
    Exit,
}

impl Coordinator {
    fn begin(&mut self, windows: BTreeSet<String>) -> Action {
        if let Some(round) = &self.active {
            return Action::Ask(round.id, round.current.clone());
        }
        let Some(current) = windows.iter().next().cloned() else {
            self.confirmed = true;
            return Action::Exit;
        };
        self.generation = self.generation.wrapping_add(1);
        let id = self.generation;
        self.active = Some(Round {
            id,
            windows,
            current: current.clone(),
            approved: BTreeSet::new(),
        });
        Action::Ask(id, current)
    }

    fn cancel(&mut self) -> Action {
        self.active
            .take()
            .map_or(Action::None, |round| Action::Cancel(round.id))
    }

    fn reply(&mut self, id: u32, label: &str, approved: bool, live: BTreeSet<String>) -> Action {
        let Some(round) = &mut self.active else {
            return Action::None;
        };
        if round.id != id || !round.windows.contains(label) {
            return Action::None;
        }
        // 창 구성이 바뀌면 이전 승인을 재사용하지 않는다.
        if !approved || round.windows != live {
            return self.cancel();
        }
        if round.current != label {
            return Action::None;
        }
        round.approved.insert(label.to_owned());
        if let Some(next) = round.windows.difference(&round.approved).next().cloned() {
            round.current = next.clone();
            return Action::Ask(id, next);
        }
        self.active = None;
        self.confirmed = true;
        Action::Exit
    }
}

fn live_windows(app: &AppHandle) -> BTreeSet<String> {
    app.webview_windows().into_keys().collect()
}

fn dispatch(app: &AppHandle, action: Action) {
    match action {
        Action::Ask(id, label) => {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                if app.emit_to(label.as_str(), "quit-requested", id).is_err() {
                    cancel(app);
                }
            } else {
                cancel(app);
            }
        }
        Action::Cancel(id) => {
            let _ = app.emit("quit-cancelled", id);
        }
        Action::Exit => app.exit(0),
        Action::None => {}
    }
}

pub fn confirmed(app: &AppHandle) -> bool {
    app.state::<QuitState>().0.lock().unwrap().confirmed
}

pub fn request(app: &AppHandle) {
    let action = app
        .state::<QuitState>()
        .0
        .lock()
        .unwrap()
        .begin(live_windows(app));
    dispatch(app, action);
}

pub fn cancel(app: &AppHandle) {
    let action = app.state::<QuitState>().0.lock().unwrap().cancel();
    dispatch(app, action);
}

#[tauri::command]
pub fn quit_reply(app: AppHandle, window: WebviewWindow, request_id: u32, approved: bool) -> bool {
    let state = app.state::<QuitState>();
    let mut coordinator = state.0.lock().unwrap();
    let accepted = coordinator.active.as_ref().is_some_and(|round| {
        round.id == request_id
            && round.windows.contains(window.label())
            && (!approved || round.current == window.label())
    });
    let action = coordinator.reply(request_id, window.label(), approved, live_windows(&app));
    drop(coordinator);
    dispatch(&app, action);
    accepted
}

/// 초기 이벤트보다 늦게 리스너를 설치한 창도 현재 요청을 받을 수 있다.
#[tauri::command]
pub fn quit_pending(app: AppHandle, window: WebviewWindow) -> Option<u32> {
    let state = app.state::<QuitState>();
    let coordinator = state.0.lock().unwrap();
    coordinator
        .active
        .as_ref()
        .filter(|round| round.current == window.label())
        .map(|round| round.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn all_windows_must_approve_and_duplicates_do_not_advance() {
        let mut c = Coordinator::default();
        let live = windows(&["main", "doc-1"]);
        assert_eq!(c.begin(live.clone()), Action::Ask(1, "doc-1".into()));
        assert_eq!(c.reply(1, "main", true, live.clone()), Action::None);
        assert_eq!(
            c.reply(1, "doc-1", true, live.clone()),
            Action::Ask(1, "main".into())
        );
        assert_eq!(c.reply(1, "doc-1", true, live.clone()), Action::None);
        assert_eq!(c.reply(1, "main", true, live), Action::Exit);
        assert!(c.confirmed);
    }

    #[test]
    fn approved_window_can_cancel_and_old_reply_cannot_exit() {
        let mut c = Coordinator::default();
        let live = windows(&["main", "doc-1"]);
        c.begin(live.clone());
        c.reply(1, "doc-1", true, live.clone());
        assert_eq!(c.reply(1, "doc-1", false, live.clone()), Action::Cancel(1));
        assert_eq!(c.begin(live.clone()), Action::Ask(2, "doc-1".into()));
        assert_eq!(c.reply(1, "main", true, live.clone()), Action::None);
        assert_eq!(c.reply(2, "unknown", false, live), Action::None);
        assert!(!c.confirmed);
    }

    #[test]
    fn changed_window_set_aborts_and_empty_app_can_exit() {
        let mut c = Coordinator::default();
        c.begin(windows(&["main"]));
        assert_eq!(
            c.reply(1, "main", true, windows(&["main", "doc-1"])),
            Action::Cancel(1)
        );
        assert!(!c.confirmed);
        assert_eq!(c.begin(BTreeSet::new()), Action::Exit);
    }
}
