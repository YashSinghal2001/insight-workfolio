mod activity;
mod collector;
mod queue;
mod screenshot;

use collector::{Collector, CollectorStatus};
use queue::QueuedEvent;
use std::sync::Arc;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State, WindowEvent};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    /// Whether this build can collect activity (macOS yes; Windows collector pending).
    /// Whether it actually runs is decided by attendance state and consent (see main.ts).
    tracking_enabled: bool,
    /// "macos" | "windows" (others are not supported by the API).
    platform: &'static str,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tracking_enabled: activity::platform::SUPPORTED,
        platform: std::env::consts::OS,
    }
}

// The refresh token is the only persisted credential and lives in the OS credential store
// (macOS Keychain / Windows Credential Manager), never in localStorage or files.
// The short-lived access token stays in webview memory only.
// ponytail: the webview still sees the refresh token in transit; moving the auth HTTP calls into
// Rust would keep it out of JS entirely, at the cost of an HTTP client dependency.
const KEYCHAIN_SERVICE: &str = "com.insightworkfolio.desktop";
const KEYCHAIN_ACCOUNT: &str = "refresh-token";
const INSTALLATION_ACCOUNT: &str = "installation-id";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

fn credential() -> Result<keyring::Entry, String> {
    entry(KEYCHAIN_ACCOUNT)
}

/// Random per-installation UUID identifying this device to the API. Generated once and kept in
/// the OS credential store; no hardware or OS identifiers are read.
#[tauri::command]
fn installation_id() -> Result<String, String> {
    let entry = entry(INSTALLATION_ACCOUNT)?;
    match entry.get_password() {
        Ok(id) => Ok(id),
        Err(keyring::Error::NoEntry) => {
            let id = uuid::Uuid::new_v4().to_string();
            entry.set_password(&id).map_err(|e| e.to_string())?;
            Ok(id)
        }
        Err(e) => Err(e.to_string()),
    }
}

// ---- Offline queue commands (see queue.rs) -----------------------------------

type Db<'a> = State<'a, Mutex<Connection>>;

fn with_db<T>(db: Db, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    f(&mut conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn queue_add(db: Db, event: QueuedEvent) -> Result<(), String> {
    with_db(db, |c| queue::add(c, &event))
}

#[tauri::command]
fn queue_list(db: Db, user_id: String, device_id: String) -> Result<Vec<QueuedEvent>, String> {
    with_db(db, |c| queue::list(c, &user_id, &device_id))
}

#[tauri::command]
fn queue_ack(db: Db, ids: Vec<String>) -> Result<(), String> {
    with_db(db, |c| queue::ack(c, &ids))
}

#[tauri::command]
fn queue_reject(db: Db, id: String, reason: String) -> Result<(), String> {
    with_db(db, |c| queue::reject(c, &id, &reason))
}

#[tauri::command]
fn queue_dismiss_rejected(db: Db, user_id: String, device_id: String) -> Result<(), String> {
    with_db(db, |c| queue::dismiss_rejected(c, &user_id, &device_id))
}

// ---- Activity monitoring commands --------------------------------------------------

#[tauri::command]
fn activity_configure(
    collector: State<Arc<Collector>>,
    db: Db,
    mode: String,
    user_id: Option<String>,
    device_id: Option<String>,
    sample_seconds: u32,
    idle_threshold_seconds: u32,
) -> CollectorStatus {
    let scope = user_id.zip(device_id);
    collector.configure(&db, mode, scope, activity::Config::new(sample_seconds, idle_threshold_seconds))
}

#[tauri::command]
fn activity_status(collector: State<Arc<Collector>>) -> CollectorStatus {
    collector.status()
}

#[tauri::command]
fn activity_list(db: Db, user_id: String, device_id: String, limit: i64) -> Result<Vec<queue::ActivityRow>, String> {
    with_db(db, |c| queue::activity_list(c, &user_id, &device_id, limit))
}

#[tauri::command]
fn activity_ack(db: Db, ids: Vec<String>) -> Result<(), String> {
    with_db(db, |c| queue::activity_ack(c, &ids))
}

#[tauri::command]
fn activity_reject(db: Db, id: String, reason: String) -> Result<(), String> {
    with_db(db, |c| queue::activity_reject(c, &id, &reason))
}

#[tauri::command]
fn activity_dismiss_rejected(db: Db, user_id: String, device_id: String) -> Result<(), String> {
    with_db(db, |c| queue::activity_dismiss_rejected(c, &user_id, &device_id))
}

#[tauri::command]
fn activity_unsynced(db: Db, user_id: String, device_id: String, since_ms: i64) -> Result<queue::Unsynced, String> {
    with_db(db, |c| queue::activity_unsynced(c, &user_id, &device_id, since_ms))
}

// ---- Screenshot commands (see screenshot.rs) ----------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn screenshot_configure(
    shooter: State<Arc<screenshot::Shooter>>,
    mode: String,
    user_id: Option<String>,
    device_id: Option<String>,
    session_id: Option<String>,
    interval_seconds: u32,
    quality: u8,
    max_dimension: u32,
) -> screenshot::ShotStatus {
    let scope = match (user_id, device_id, session_id) {
        (Some(user_id), Some(device_id), Some(session_id)) => Some(screenshot::Scope { user_id, device_id, session_id }),
        _ => None,
    };
    let cfg = screenshot::Config { interval_ms: i64::from(interval_seconds.max(60)) * 1000, quality: f32::from(quality.min(100)), max_dimension: max_dimension.clamp(320, 3840) };
    shooter.configure(mode, scope, cfg)
}

#[tauri::command]
fn screenshot_status(shooter: State<Arc<screenshot::Shooter>>) -> screenshot::ShotStatus {
    shooter.status()
}

/// Shows the macOS Screen Recording prompt (first time only). Only on the employee's click.
#[tauri::command]
fn screenshot_request_permission() -> bool {
    screenshot::platform::request_permission()
}

#[tauri::command]
fn screenshot_summary(db: Db, user_id: String, device_id: String) -> Result<screenshot::Summary, String> {
    with_db(db, |c| screenshot::summary(c, &user_id, &device_id, screenshot::LOCAL_CAP_BYTES))
}

#[tauri::command]
fn screenshot_next(db: Db, user_id: String, device_id: String, now_ms: i64) -> Result<Option<screenshot::ShotRow>, String> {
    with_db(db, |c| screenshot::next_upload(c, &user_id, &device_id, now_ms))
}

/// Raw bytes to the webview (ArrayBuffer), checksum-verified.
#[tauri::command]
fn screenshot_read(db: Db, dir: State<ScreenshotDir>, id: String) -> Result<tauri::ipc::Response, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    screenshot::read(&conn, &dir.0, &id).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn screenshot_mark(db: Db, id: String, outcome: String, reason: Option<String>, now_ms: i64) -> Result<(), String> {
    with_db(db, |c| screenshot::mark(c, &id, &outcome, reason.as_deref(), now_ms))
}

#[tauri::command]
fn screenshot_dismiss(db: Db, dir: State<ScreenshotDir>, user_id: String, device_id: String) -> Result<usize, String> {
    with_db(db, |c| screenshot::dismiss(c, &dir.0, &user_id, &device_id))
}

struct ScreenshotDir(std::path::PathBuf);
/// Keeps the single-instance lock open for the app's lifetime.
#[allow(dead_code)]
struct InstanceLock(std::fs::File);

#[tauri::command]
fn kv_get(db: Db, key: String) -> Result<Option<String>, String> {
    with_db(db, |c| queue::kv_get(c, &key))
}

#[tauri::command]
fn kv_set(db: Db, key: String, value: Option<String>) -> Result<(), String> {
    with_db(db, |c| queue::kv_set(c, &key, value.as_deref()))
}

#[tauri::command]
fn save_refresh_token(token: String) -> Result<(), String> {
    credential()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_refresh_token() -> Result<Option<String>, String> {
    match credential()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_refresh_token() -> Result<(), String> {
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Dev-only end-to-end harness --------------------------------------------
// Debug builds only: `WF_E2E_SCRIPT=<file.js>` evaluates that script in the main window after each
// page load, so the real app (webview, Keychain, SQLite) can be driven without UI-automation
// permissions. Both commands are no-ops in release builds.

#[tauri::command]
fn e2e_log(line: String) {
    if cfg!(debug_assertions) {
        eprintln!("[e2e] {line}");
    }
}

#[tauri::command]
fn e2e_exit(app: tauri::AppHandle, code: i32) {
    if cfg!(debug_assertions) {
        app.exit(code);
    }
}

fn e2e_script() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::fs::read_to_string(std::env::var("WF_E2E_SCRIPT").ok()?).ok()
}

/// One running copy per user: a second instance would start a second activity collector and
/// screenshot worker on the same queue. Held (advisory `flock`) for the process lifetime; the OS
/// releases it on exit or crash, so a stale lock file never blocks the next start.
#[cfg(unix)]
fn single_instance(dir: &std::path::Path) -> std::io::Result<Option<std::fs::File>> {
    use std::os::fd::AsRawFd;
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("instance.lock"))?;
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    Ok(locked.then_some(file))
}

#[cfg(not(unix))]
fn single_instance(dir: &std::path::Path) -> std::io::Result<Option<std::fs::File>> {
    // ponytail: Windows needs a named mutex (CreateMutexW); not implemented with the Windows collector.
    std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("instance.lock")).map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let e2e = e2e_script();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_info,
            save_refresh_token,
            load_refresh_token,
            clear_refresh_token,
            installation_id,
            queue_add,
            queue_list,
            queue_ack,
            queue_reject,
            queue_dismiss_rejected,
            kv_get,
            kv_set,
            activity_configure,
            activity_status,
            activity_list,
            activity_ack,
            activity_reject,
            activity_dismiss_rejected,
            activity_unsynced,
            screenshot_configure,
            screenshot_status,
            screenshot_request_permission,
            screenshot_summary,
            screenshot_next,
            screenshot_read,
            screenshot_mark,
            screenshot_dismiss,
            e2e_log,
            e2e_exit
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // Owner-only access to the queue and its WAL files (see docs/security.md, encryption at rest).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
            let Some(lock) = single_instance(&dir)? else {
                eprintln!("[lifecycle] another copy of Insight Workfolio is already running; this copy exits without recording anything");
                std::process::exit(0);
            };
            app.manage(InstanceLock(lock));
            let (conn, moved_aside) = queue::open_or_recover(&dir.join("attendance-queue.db"))?;
            if let Some(path) = moved_aside {
                eprintln!("[queue] damaged queue moved aside to {}", path.display());
                // kv values are JSON (read by the webview with JSON.parse).
                let value = serde_json::to_string(&path.display().to_string())?;
                queue::kv_set(&conn, "queue_recovered", Some(&value))?;
            }
            // Crash recovery: intervals left open by a previous run end at their last checkpoint.
            let recovered = queue::activity_recover(&conn)?;
            if recovered > 0 {
                eprintln!("[activity] recovered {recovered} interval(s) from an unclean shutdown");
                // Shown once in the app (kv values are JSON): what was kept, and that the downtime is not recorded.
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                queue::kv_set(&conn, "activity_recovered", Some(&serde_json::json!({ "count": recovered, "atMs": now }).to_string()))?;
            }
            // Screenshot files: private directory (owner only), UUID file names.
            let shots = dir.join("screenshots");
            std::fs::create_dir_all(&shots)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&shots, std::fs::Permissions::from_mode(0o700))?;
            }
            let r = screenshot::recover(&conn, &shots)?;
            if r != screenshot::Recovered::default() {
                eprintln!("[screenshot] startup recovery: {r:?}");
            }
            app.manage(Mutex::new(conn));
            app.manage(Collector::spawn(app.handle().clone()));
            app.manage(Arc::new(screenshot::Shooter::new(shots.clone(), screenshot::LOCAL_CAP_BYTES)).spawn(app.handle().clone()));
            app.manage(ScreenshotDir(shots));
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            if let (Some(js), tauri::webview::PageLoadEvent::Finished) = (&e2e, payload.event()) {
                let _ = webview.eval(js);
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } => {
                eprintln!("[lifecycle] close requested: {}", window.label());
            }
            WindowEvent::Destroyed => eprintln!("[lifecycle] window destroyed: {}", window.label()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            RunEvent::Ready => eprintln!("[lifecycle] app ready"),
            RunEvent::Exit => eprintln!("[lifecycle] app exiting"),
            _ => {}
        });
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn a_second_instance_cannot_take_the_lock_until_the_first_exits() {
        let dir = std::env::temp_dir().join(format!("wf-instance-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = super::single_instance(&dir).unwrap();
        assert!(first.is_some());
        assert!(super::single_instance(&dir).unwrap().is_none(), "second copy refused: no duplicate workers");
        drop(first); // process exit or crash releases it
        assert!(super::single_instance(&dir).unwrap().is_some());
        std::fs::remove_dir_all(dir).ok();
    }
}
