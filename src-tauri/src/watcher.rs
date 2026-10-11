//! 파일 감시(notify). 열린 문서(부모 디렉터리 비재귀)와 워크스페이스 폴더
//! (재귀)를 감시하고 `fs-event`로 프런트에 알린다.
//!
//! - 원자적 저장은 "임시 파일 생성 → rename"이라 파일 자체를 감시하면
//!   rename 뒤 놓친다 — 그래서 문서는 **부모 디렉터리**를 감시하고 경로로 거른다.
//! - 우리가 저장해 일어난 이벤트(1.5초 창)와 임시 파일(`.iyagi-tmp`)은 무시한다.
//! - 같은 경로의 연속 이벤트는 150ms 안에 묶는다(저장 한 번이 mtime을
//!   여러 번 건드리는 경우 대비).
//! - 프런트는 탭/폴터 변화가 있을 때마다 **남아 있는 전체 목록**으로
//!   `watch_paths`를 다시 부른다(선언적 동기화 — 개별 add/remove 추적이 없다).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::Watcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(150);
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub path: String,
    /// changed | removed
    pub kind: String,
}

struct Inner {
    watcher: notify::RecommendedWatcher,
    /// 비재귀로 감시 중인 디렉터리(문서 부모).
    dirs: HashSet<PathBuf>,
    /// 재귀 감시 중인 루트(워크스페이스).
    recursive: HashSet<PathBuf>,
    last_self_write: HashMap<PathBuf, Instant>,
    last_emit: HashMap<PathBuf, Instant>,
}

pub struct WatcherState {
    inner: Mutex<Inner>,
}

/// 감시자를 필요한 시점(첫 watch_paths)에 만든다. AppHandle은 Send+Clone이라
/// 이벤트 전달 스레드로 그대로 옮겨 이벤트를 emit한다.
fn ensure(app: &AppHandle) {
    if app.try_state::<WatcherState>().is_none() {
        let app_for_thread = app.clone();
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .expect("파일 감시자를 만들 수 없습니다");
        std::thread::spawn(move || {
            for res in rx {
                match res {
                    Ok(ev) => forward(&app_for_thread, ev),
                    Err(e) => tracing::debug!("감시 오류(무시): {e}"),
                }
            }
        });
        app.manage(WatcherState {
            inner: Mutex::new(Inner {
                watcher,
                dirs: HashSet::new(),
                recursive: HashSet::new(),
                last_self_write: HashMap::new(),
                last_emit: HashMap::new(),
            }),
        });
    }
}

/// 감시 대상 갱신: files는 각각의 부모 디렉터리(비재귀), dirs는 재귀 감시.
/// 목록에 없는 기존 감시는 해제한다.
pub fn update_watch(app: &AppHandle, files: Vec<String>, dirs: Vec<String>) {
    ensure(app);
    let state = app.state::<WatcherState>();
    let mut inner = state.inner.lock().unwrap();

    let mut new_dirs: HashSet<PathBuf> = files
        .iter()
        .map(|f| Path::new(f).parent().map(|p| p.to_path_buf()).unwrap_or_default())
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    let new_recursive: HashSet<PathBuf> = dirs.iter().map(PathBuf::from).collect();
    new_dirs.retain(|d| !new_recursive.contains(d));

    // 현재 목록을 꺼내 놓고(대여 분리) 증분을 계산한다.
    let old_dirs = std::mem::take(&mut inner.dirs);
    let old_recursive = std::mem::take(&mut inner.recursive);

    for d in new_dirs.difference(&old_dirs) {
        if let Err(e) = inner.watcher.watch(d, notify::RecursiveMode::NonRecursive) {
            tracing::warn!("감시 추가 실패({}): {e}", d.display());
        }
    }
    for d in new_recursive.difference(&old_recursive) {
        if let Err(e) = inner.watcher.watch(d, notify::RecursiveMode::Recursive) {
            tracing::warn!("재귀 감시 추가 실패({}): {e}", d.display());
        }
    }
    for d in old_dirs.difference(&new_dirs) {
        if !new_recursive.contains(d) {
            let _ = inner.watcher.unwatch(d);
        }
    }
    for d in old_recursive.difference(&new_recursive) {
        let _ = inner.watcher.unwatch(d);
    }
    inner.dirs = new_dirs;
    inner.recursive = new_recursive;
}

/// 저장 직후 호출 — 이 경로의 자기 발생 이벤트를 잠시 무시한다.
pub fn note_self_write(app: &AppHandle, path: &Path) {
    if let Some(state) = app.try_state::<WatcherState>() {
        state
            .inner
            .lock()
            .unwrap()
            .last_self_write
            .insert(path.to_path_buf(), Instant::now());
    }
}

fn forward(app: &AppHandle, ev: notify::Event) {
    let kind = match ev.kind {
        notify::EventKind::Remove(_) => "removed",
        _ => "changed",
    };
    let state = match app.try_state::<WatcherState>() {
        Some(s) => s,
        None => return,
    };
    let mut inner = state.inner.lock().unwrap();
    let now = Instant::now();
    for path in ev.paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 우리의 원자적 저장 임시 파일.
        if name.contains(".iyagi-tmp") {
            continue;
        }
        // 자기 저장 이벤트인가?
        if let Some(t) = inner.last_self_write.get(&path) {
            if now.duration_since(*t) < SELF_WRITE_WINDOW {
                continue;
            }
        }
        // 디바운스.
        if let Some(t) = inner.last_emit.get(&path) {
            if now.duration_since(*t) < DEBOUNCE {
                continue;
            }
        }
        inner.last_emit.insert(path.clone(), now);
        let payload = FsEvent {
            path: path.to_string_lossy().into_owned(),
            kind: kind.to_string(),
        };
        tracing::debug!(path = %payload.path, kind = %payload.kind, "fs-event");
        let _ = app.emit("fs-event", payload);
    }
    // 무한정 자라지 않게 주기적 청소.
    if inner.last_emit.len() > 512 {
        inner
            .last_emit
            .retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
    }
}
