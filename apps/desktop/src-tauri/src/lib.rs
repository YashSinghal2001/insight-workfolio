mod activity;
mod collector;
mod power;
mod queue;
mod screenshot;
mod session_events;
mod prefs;
mod tray;
// Windows adapters: pure logic compiles (and is tested) everywhere; Win32 calls are cfg(windows).
mod win;

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
    /// Whether this build can collect activity (macOS and Windows yes; other OSes no).
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
// The bundle identifier: scripts/desktop-config.mjs sets WORKFOLIO_KEYCHAIN_SERVICE per WORKFOLIO_ENV
// (staging: com.insightworkfolio.desktop.staging) so staging and production never share credentials.
const KEYCHAIN_SERVICE: &str = match option_env!("WORKFOLIO_KEYCHAIN_SERVICE") {
    Some(s) => s,
    None => "com.insightworkfolio.desktop",
};
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
#[allow(clippy::too_many_arguments)]
fn activity_configure(
    collector: State<Arc<Collector>>,
    db: Db,
    mode: String,
    user_id: Option<String>,
    device_id: Option<String>,
    sample_seconds: u32,
    idle_threshold_seconds: u32,
    idle_excluded_apps: Option<Vec<String>>,
) -> CollectorStatus {
    let scope = user_id.zip(device_id);
    let mut cfg = activity::Config::new(sample_seconds, idle_threshold_seconds);
    cfg.idle_excluded_apps = idle_excluded_apps.unwrap_or_default();
    collector.configure(&db, mode, scope, cfg)
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
    masks: Vec<screenshot::Mask>,
    blur: Option<bool>,
) -> screenshot::ShotStatus {
    let scope = match (user_id, device_id, session_id) {
        (Some(user_id), Some(device_id), Some(session_id)) => Some(screenshot::Scope { user_id, device_id, session_id }),
        _ => None,
    };
    let cfg = screenshot::Config { interval_ms: i64::from(interval_seconds.max(60)) * 1000, quality: f32::from(quality.min(100)), max_dimension: max_dimension.clamp(320, 3840), masks, blur };
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
#[cfg(unix)]
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

// ---- App shell: menu bar, preferences (see tray.rs, prefs.rs) -------------------------

#[tauri::command]
fn prefs_get(store: State<prefs::Store>) -> prefs::Prefs {
    let stored = *store.prefs.lock().unwrap_or_else(|e| e.into_inner());
    prefs::Prefs { launch_at_login: prefs::login_item::enabled(), ..stored }
}

/// Applies immediately; only the fields given change. A launch-at-login failure (not installed
/// as an app bundle, needs approval in System Settings) is returned for the page to show.
#[tauri::command]
fn prefs_set(
    app: tauri::AppHandle,
    store: State<prefs::Store>,
    shell: State<Arc<tray::Shell>>,
    show_seconds: Option<bool>,
    hide_dock_icon: Option<bool>,
    launch_at_login: Option<bool>,
) -> Result<prefs::Prefs, String> {
    {
        let mut p = store.prefs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(on) = hide_dock_icon {
            tray::apply_dock(&app, on)?;
            p.hide_dock_icon = on;
        }
        if let Some(on) = show_seconds {
            shell.set_show_seconds(on);
            p.show_seconds = on;
        }
        prefs::save(&store.path, &p).map_err(|e| e.to_string())?;
    }
    if let Some(on) = launch_at_login {
        prefs::login_item::set(on)?;
    }
    Ok(prefs_get(store))
}

#[tauri::command]
fn tray_update(
    app: tauri::AppHandle,
    shell: State<Arc<tray::Shell>>,
    state: String,
    label: String,
    since: Option<String>,
    monitoring: Option<String>,
) -> Result<(), String> {
    if !tray::STATES.contains(&state.as_str()) {
        return Err(format!("unknown state {state}"));
    }
    let since_ms = since.as_deref().map(tray::parse_since).transpose()?;
    shell.update(&app, state, label, since_ms, monitoring).map_err(|e| e.to_string())
}

// ---- Dev-only end-to-end harness --------------------------------------------
// Debug builds only: `WF_E2E_SCRIPT=<file.js>` evaluates that script in the main window after each
// page load, so the real app (webview, Keychain, SQLite) can be driven without UI-automation
// permissions. These commands are no-ops in release builds.

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

/// The system idle counter the collector reads (ms since the last input), so the harness can tell
/// whether the operator touched the Mac. A counter only, no new permission; `None` in release builds.
#[tauri::command]
fn e2e_idle_ms() -> Option<i64> {
    cfg!(debug_assertions).then(activity::platform::idle_ms)
}

fn e2e_script() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::fs::read_to_string(std::env::var("WF_E2E_SCRIPT").ok()?).ok()
}

/// A timesheet export file name, as made by `timesheetFilename` (packages/shared/src/export.ts):
/// `workfolio-timesheet-draft1_<CODE>_<YYYY-MM-DD>_<YYYY-MM-DD>.csv|.xlsx`, optionally with the
/// " (n)" wry adds instead of overwriting an existing file.
fn is_export_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("workfolio-timesheet-draft1_") else { return false };
    let Some(stem) = rest.strip_suffix(".csv").or_else(|| rest.strip_suffix(".xlsx")) else { return false };
    let stem = match stem.rsplit_once(" (") {
        Some((base, n)) => match n.strip_suffix(')') {
            Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => base,
            _ => return false,
        },
        None => stem,
    };
    let date = |d: &str| d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    let Some((code, dates)) = stem.split_at_checked(stem.len().saturating_sub(22)) else { return false };
    !code.is_empty()
        && dates.len() == 22
        && dates.starts_with('_')
        && date(&dates[1..11])
        && &dates[11..12] == "_"
        && date(&dates[12..])
        && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Downloads the app accepts: a file the page itself made in memory (`blob:`), named like an
/// export, saved directly in the Downloads folder (no other folder, no path tricks).
fn allowed_download(url: &tauri::Url, destination: &std::path::Path, downloads: Option<&std::path::Path>) -> bool {
    url.scheme() == "blob"
        && downloads.is_some_and(|d| destination.parent() == Some(d))
        && destination.file_name().and_then(|n| n.to_str()).is_some_and(is_export_name)
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

// Windows: tauri-plugin-single-instance (registered in `run`). It takes the named mutex
// `com.insightworkfolio.desktop-sim` (session-local namespace) while the app is built, before
// `setup` opens the queue or starts any worker; a second launch hands its arguments to the first
// copy over WM_COPYDATA, grants it the foreground (AllowSetForegroundWindow) and exits. The first
// copy then opens its window through the same path as the tray (`tray::open_main`), so tao's own
// visibility state stays right; showing the window from the other process (FindWindowW +
// ShowWindow) would not update it and a later close-to-tray would fail to hide it.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // No WebView2 runtime: explain in a message box and exit cleanly instead of vanishing.
    #[cfg(windows)]
    if !win::webview2::ensure() {
        return;
    }
    let e2e = e2e_script();
    let builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        eprintln!("[lifecycle] opened again while running: showing the existing window");
        tray::open_main(app);
    }));
    builder
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
            prefs_get,
            prefs_set,
            tray_update,
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
            e2e_idle_ms,
            e2e_exit
        ])
        .setup(|app| {
            // Local (never roaming) app data: on Windows %LOCALAPPDATA%\com.insightworkfolio.desktop,
            // so the queue and screenshots are not synced to other machines by roaming profiles.
            // macOS: identical to app_data_dir (dirs 7: both are ~/Library/Application Support), so
            // existing queues stay where they are.
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // Owner-only access to the queue and its WAL files (see docs/security.md, encryption at rest).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
            #[cfg(unix)]
            {
                let Some(lock) = single_instance(&dir)? else {
                    eprintln!("[lifecycle] another copy of Insight Workfolio is already running; this copy exits without recording anything");
                    std::process::exit(0);
                };
                app.manage(InstanceLock(lock));
            }
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
            // Lock/sleep/user-switch observers on the main run loop (setup runs on the main thread).
            session_events::start();
            app.manage(Collector::spawn(app.handle().clone()));
            app.manage(Arc::new(screenshot::Shooter::new(shots.clone(), screenshot::LOCAL_CAP_BYTES)).spawn(app.handle().clone()));
            app.manage(ScreenshotDir(shots));
            // The window is built here (config "create": false) to register the download handler:
            // without one, the webview ignores downloads. Only timesheet exports the page made in
            // memory (blob:) are allowed, straight into Downloads; wry adds " (1)" rather than
            // overwrite. Nothing about the file is logged (its name contains the employee code).
            let config = app.config().app.windows.first().cloned().ok_or("no window in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_download(|webview, event| match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        let ok = allowed_download(&url, destination, webview.app_handle().path().download_dir().ok().as_deref());
                        eprintln!("[download] {}", if ok { "accepted" } else { "refused" });
                        ok
                    }
                    tauri::webview::DownloadEvent::Finished { success, .. } => {
                        eprintln!("[download] finished, success: {success}");
                        true
                    }
                    _ => false,
                })
                .build()?;
            // App shell: menu-bar item, Cmd+Q that asks while clocked in, Dock icon preference.
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let store = prefs::Store { path: config_dir.join("prefs.json"), prefs: Mutex::new(prefs::load(&config_dir.join("prefs.json"))) };
            let stored = *store.prefs.lock().unwrap_or_else(|e| e.into_inner());
            app.manage(tray::Shell::init(app.handle(), stored.show_seconds)?);
            app.manage(store);
            #[cfg(target_os = "macos")]
            app.set_menu(tray::app_menu(app.handle())?)?;
            if stored.hide_dock_icon {
                tray::apply_dock(app.handle(), true)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            tray::OPEN_ID => tray::open_main(app),
            tray::QUIT_ID => tray::quit(app),
            _ => {}
        })
        .on_page_load(move |webview, payload| {
            if let (Some(js), tauri::webview::PageLoadEvent::Finished) = (&e2e, payload.event()) {
                let _ = webview.eval(js);
            }
        })
        .on_window_event(|window, event| match event {
            // Closing hides the window; the app keeps running in the menu bar (quit from there).
            WindowEvent::CloseRequested { api, .. } => {
                eprintln!("[lifecycle] close requested, hiding: {}", window.label());
                api.prevent_close();
                tray::hide_main(window);
            }
            WindowEvent::Destroyed => eprintln!("[lifecycle] window destroyed: {}", window.label()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            RunEvent::Ready => eprintln!("[lifecycle] app ready"),
            // Dock icon click, or opening the app again while it runs (LaunchServices reuses this
            // process instead of starting a second copy).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::open_main(_app),
            RunEvent::Exit => {
                eprintln!("[lifecycle] app exiting");
                // A deliberate quit (or logout/shutdown) stops recording now: the open activity
                // interval is closed here, so the next start does not report an unexpected close,
                // and a capture in flight is discarded.
                if let (Some(c), Some(db)) = (_app.try_state::<Arc<Collector>>(), _app.try_state::<Mutex<Connection>>()) {
                    c.configure(&db, "STOPPED".into(), None, activity::Config::new(15, 300));
                }
                if let Some(s) = _app.try_state::<Arc<screenshot::Shooter>>() {
                    let cfg = screenshot::Config { interval_ms: 300_000, quality: 70.0, max_dimension: 1920, masks: Vec::new(), blur: Some(false) };
                    s.configure("STOPPED".into(), None, cfg);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod download_tests {
    use super::{allowed_download, is_export_name};
    use std::path::Path;

    #[test]
    fn only_timesheet_export_names_are_accepted() {
        for ok in [
            "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.csv",
            "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.xlsx",
            "workfolio-timesheet-draft1_A_B_2026-10-01_2026-10-31 (1).csv",
            "workfolio-timesheet-draft1_employee_2026-01-01_2026-04-02 (12).xlsx",
        ] {
            assert!(is_export_name(ok), "{ok}");
        }
        for bad in [
            "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.exe",
            "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.csv.app",
            "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31 (x).csv",
            "workfolio-timesheet-draft1__2026-10-01_2026-10-31.csv",
            "workfolio-timesheet-draft1_EMP 7_2026-10-01_2026-10-31.csv",
            "workfolio-timesheet-draft1_EMP-7_2026-10-1_2026-10-31.csv",
            "workfolio-timesheet-draft1_../x_2026-10-01_2026-10-31.csv",
            "invoice.pdf",
            "",
        ] {
            assert!(!is_export_name(bad), "{bad}");
        }
    }

    #[test]
    fn only_blob_urls_into_the_downloads_folder() {
        let downloads = Path::new("/Users/test/Downloads");
        let name = "workfolio-timesheet-draft1_EMP-7_2026-10-01_2026-10-31.xlsx";
        let blob = tauri::Url::parse("blob:tauri://localhost/0b6f1a3e-0000-4000-8000-000000000000").unwrap();
        assert!(allowed_download(&blob, &downloads.join(name), Some(downloads)));
        let https = tauri::Url::parse("https://example.com/workfolio.xlsx").unwrap();
        assert!(!allowed_download(&https, &downloads.join(name), Some(downloads)), "remote files are refused");
        assert!(!allowed_download(&blob, &Path::new("/Users/test/Library").join(name), Some(downloads)), "other folders");
        assert!(!allowed_download(&blob, &downloads.join("sub").join(name), Some(downloads)), "subfolders");
        assert!(!allowed_download(&blob, &downloads.join("notes.txt"), Some(downloads)), "other names");
        assert!(!allowed_download(&blob, &downloads.join(name), None), "no Downloads folder known");
    }
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
