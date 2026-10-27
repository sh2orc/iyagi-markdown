//! 창별 감시 범위를 합쳐 감시한다. 파일의 부모 폴더를 감시하므로 원자적
//! 저장 뒤에도 감시가 이어진다. 이벤트는 마지막 변화까지 모아 전달하며,
//! 자기 저장 판별은 프런트의 내용 비교에 맡긴다(시간 기반 유실 금지).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify::Watcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub path: String,
    pub kind: String,
}

#[derive(Default)]
struct Scope {
    dirs: HashSet<PathBuf>,
    recursive: HashSet<PathBuf>,
}

struct Inner {
    watcher: notify::RecommendedWatcher,
    owners: HashMap<String, Scope>,
    /// 실제로 구독에 성공한 경로와 재귀 여부. 실패는 다음 동기화에서 재시도한다.
    watched: HashMap<PathBuf, bool>,
}

pub struct WatcherState {
    inner: Mutex<Inner>,
}

struct PendingChange {
    first: Instant,
    last: Instant,
}

impl PendingChange {
    fn deadline(&self) -> Instant {
        (self.last + DEBOUNCE).min(self.first + MAX_DELAY)
    }
}

fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<WatcherState>().is_some() {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    app.manage(WatcherState {
        inner: Mutex::new(Inner {
            watcher,
            owners: HashMap::new(),
            watched: HashMap::new(),
        }),
    });
    let worker_app = app.clone();
    std::thread::spawn(move || {
        let mut pending: HashMap<PathBuf, PendingChange> = HashMap::new();
        loop {
            let timeout = pending
                .values()
                .map(PendingChange::deadline)
                .min()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()));
            let received = match timeout {
                Some(wait) => rx.recv_timeout(wait),
                None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(Ok(mut event)) => {
                    // 읽기 자체가 다시 읽기를 유발하는 이벤트 순환을 막는다.
                    if !matches!(event.kind, notify::EventKind::Access(_)) {
                        if event.paths.is_empty() {
                            // 감시 백엔드의 전체 재스캔 신호도 열린 문서까지 전달한다.
                            if let Some(state) = worker_app.try_state::<WatcherState>() {
                                event
                                    .paths
                                    .extend(state.inner.lock().unwrap().watched.keys().cloned());
                            }
                        }
                        let now = Instant::now();
                        for path in event.paths {
                            if path
                                .file_name()
                                .is_some_and(|name| name.to_string_lossy().contains(".iyagi-tmp"))
                            {
                                continue;
                            }
                            pending
                                .entry(path)
                                .and_modify(|change| change.last = now)
                                .or_insert(PendingChange {
                                    first: now,
                                    last: now,
                                });
                        }
                    }
                }
                Ok(Err(error)) => tracing::warn!("파일 감시 오류: {error}"),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            let ready: Vec<PathBuf> = pending
                .iter()
                .filter(|(_, change)| change.deadline() <= now)
                .map(|(path, _)| path.clone())
                .collect();
            for path in ready {
                pending.remove(&path);
                // remove→create(원자적 교체)·rename 이벤트의 마지막 상태로 판정.
                // 권한 오류는 삭제로 단정하지 않는다.
                let removed = std::fs::symlink_metadata(&path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
                let payload = FsEvent {
                    path: path.to_string_lossy().into_owned(),
                    kind: if removed { "removed" } else { "changed" }.into(),
                };
                let _ = worker_app.emit("fs-event", payload);
            }
        }
    });
    Ok(())
}

fn desired_paths(owners: &HashMap<String, Scope>) -> HashMap<PathBuf, bool> {
    let mut desired = HashMap::new();
    for scope in owners.values() {
        for dir in &scope.dirs {
            desired.entry(dir.clone()).or_insert(false);
        }
        for dir in &scope.recursive {
            desired.insert(dir.clone(), true);
        }
    }
    desired
}

pub fn update_watch(
    app: &AppHandle,
    owner: String,
    files: Vec<String>,
    dirs: Vec<String>,
) -> Result<(), String> {
    ensure(app)?;
    let state = app.state::<WatcherState>();
    let mut inner = state.inner.lock().unwrap();
    let live = app.webview_windows();
    inner.owners.retain(|label, _| live.contains_key(label));
    inner.owners.insert(
        owner,
        Scope {
            dirs: files
                .iter()
                .filter_map(|file| Path::new(file).parent().map(Path::to_path_buf))
                .filter(|dir| !dir.as_os_str().is_empty())
                .collect(),
            recursive: dirs.into_iter().map(PathBuf::from).collect(),
        },
    );
    let desired = desired_paths(&inner.owners);
    // 같은 경로의 비재귀↔재귀 전환은 해제 후 등록한다. 새 구독을 지우지 않는다.
    let obsolete: Vec<PathBuf> = inner
        .watched
        .iter()
        .filter(|(path, recursive)| desired.get(*path) != Some(*recursive))
        .map(|(path, _)| path.clone())
        .collect();
    for path in obsolete {
        let _ = inner.watcher.unwatch(&path);
        inner.watched.remove(&path);
    }
    let mut failures = Vec::new();
    for (path, recursive) in desired {
        if inner.watched.get(&path) == Some(&recursive) {
            continue;
        }
        let mode = if recursive {
            notify::RecursiveMode::Recursive
        } else {
            notify::RecursiveMode::NonRecursive
        };
        match inner.watcher.watch(&path, mode) {
            Ok(()) => {
                inner.watched.insert(path, recursive);
            }
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debounce_delivers_last_change_without_indefinite_starvation() {
        let first = Instant::now();
        let mut change = PendingChange { first, last: first };
        change.last = first + Duration::from_millis(100);
        assert_eq!(change.deadline(), first + Duration::from_millis(250));
        change.last = first + Duration::from_millis(950);
        assert_eq!(change.deadline(), first + MAX_DELAY);
    }

    #[test]
    fn each_window_retains_its_scope_and_recursive_mode_wins() {
        let mut owners = HashMap::new();
        owners.insert(
            "main".into(),
            Scope {
                dirs: HashSet::from([PathBuf::from("/notes")]),
                recursive: HashSet::new(),
            },
        );
        owners.insert(
            "doc-1".into(),
            Scope {
                dirs: HashSet::from([PathBuf::from("/other")]),
                recursive: HashSet::from([PathBuf::from("/notes")]),
            },
        );
        assert_eq!(desired_paths(&owners).get(Path::new("/notes")), Some(&true));
        assert_eq!(
            desired_paths(&owners).get(Path::new("/other")),
            Some(&false)
        );
        owners.remove("doc-1");
        assert_eq!(
            desired_paths(&owners).get(Path::new("/notes")),
            Some(&false)
        );
    }
}
