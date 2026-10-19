//! Screenshot capture: one worker thread for the app's lifetime, a durable local queue (SQLite
//! metadata + private WebP files) and the macOS capture itself (ScreenCaptureKit).
//!
//! The webview decides whether capture is allowed (clocked in, not on a break, device active,
//! screenshots enabled, screenshot notice acknowledged). Right before every capture this worker
//! also checks the OS Screen Recording permission, the screen lock, sleep, and local storage.
//! Only the primary display is captured. Nothing is ever captured silently: the app shows the
//! state, next capture and last capture at all times.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Local screenshot files kept on this computer, all users. At the cap, capture pauses (nothing is
/// deleted to make room); at 80 % the app warns. ~2,500 screenshots at a typical 200 KB.
pub const LOCAL_CAP_BYTES: i64 = 500 * 1024 * 1024;
/// Capture also pauses when the disk has less free space than this (protects the attendance queue).
pub const MIN_FREE_DISK_BYTES: u64 = 1024 * 1024 * 1024;
/// A screenshot confirmed by cloud storage stays on this computer this long before its file is removed.
pub const STORED_GRACE_MS: i64 = 24 * 3_600_000;
/// Wall and monotonic clocks drifting apart by more than this between two ticks = sleep or clock change.
const GAP_TOLERANCE_MS: i64 = 5_000;
const TICK: Duration = Duration::from_secs(1);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Pixels of one capture, RGB, tightly packed.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub interval_ms: i64,
    pub quality: f32,
    pub max_dimension: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub user_id: String,
    pub device_id: String,
    /// Local attendance session (clock-in id) the captures belong to; the server re-derives it.
    pub session_id: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub at_ms: i64,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub capture_ms: u64,
    pub encode_ms: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShotStatus {
    /// This build can capture (macOS 14+); the Windows capture is not implemented.
    pub supported: bool,
    pub mode: String,
    /// Mode is ACTIVE with an employee/device/session scope: captures happen on schedule.
    pub capturing: bool,
    /// Screen Recording permission (CGPreflightScreenCaptureAccess); checked on every status call.
    pub permission: bool,
    /// Why the last due capture did not happen (screen locked, no permission, storage full).
    pub skipped: Option<String>,
    pub next_capture_ms: Option<i64>,
    /// Last screenshot saved on this computer (not yet a confirmed upload).
    pub last_capture: Option<CaptureInfo>,
    /// Latest stretch the worker could not observe (sleep, suspended app, clock change).
    pub last_gap_ms: Option<(i64, i64)>,
    pub error: Option<String>,
}

/// The OS side of a capture; faked in tests.
pub trait Os: Send + Sync {
    fn permission(&self) -> bool;
    fn locked(&self) -> bool;
    fn free_bytes(&self, dir: &Path) -> Option<u64>;
    fn capture(&self, max_dimension: u32) -> Result<Frame, String>;
}

struct State {
    mode: String,
    scope: Option<Scope>,
    cfg: Config,
    last_tick: Option<(i64, i64)>,
    last_cleanup_ms: i64,
    status: ShotStatus,
}

pub struct Shooter {
    state: Mutex<State>,
    /// Bumped by every configure: a capture that started under an older configuration is discarded.
    generation: AtomicU64,
    dir: PathBuf,
    cap_bytes: i64,
    started: Instant,
}

impl Shooter {
    pub fn new(dir: PathBuf, cap_bytes: i64) -> Shooter {
        Shooter {
            state: Mutex::new(State {
                mode: "STOPPED".into(),
                scope: None,
                cfg: Config { interval_ms: 300_000, quality: 70.0, max_dimension: 1920 },
                last_tick: None,
                last_cleanup_ms: 0,
                status: ShotStatus {
                    supported: platform::SUPPORTED,
                    mode: "STOPPED".into(),
                    capturing: false,
                    permission: false,
                    skipped: None,
                    next_capture_ms: None,
                    last_capture: None,
                    last_gap_ms: None,
                    error: None,
                },
            }),
            generation: AtomicU64::new(0),
            dir,
            cap_bytes,
            started: Instant::now(),
        }
    }

    /// Starts the one capture thread (no duplicate workers within the app).
    pub fn spawn(self: Arc<Self>, app: AppHandle) -> Arc<Self> {
        let worker = self.clone();
        std::thread::Builder::new()
            .name("screenshot-capture".into())
            .spawn(move || {
                let os = platform::Native;
                loop {
                    std::thread::sleep(TICK);
                    worker.tick(&app.state::<Mutex<Connection>>(), &os, now_ms(), worker.started.elapsed().as_millis() as i64);
                }
            })
            .expect("spawn screenshot worker");
        self
    }

    pub fn tick(&self, db: &Mutex<Connection>, os: &dyn Os, wall: i64, mono: i64) {
        let Some((cfg, scope, generation)) = self.due(db, wall, mono) else { return };
        let skip = |reason: &str| {
            if let Ok(mut st) = self.state.lock() {
                st.status.skipped = Some(reason.into());
            }
        };
        let permission = os.permission();
        if let Ok(mut st) = self.state.lock() {
            st.status.permission = permission;
        }
        if !permission {
            return skip("Not taken: Screen Recording permission is not granted to this app.");
        }
        if os.locked() {
            return skip("Not taken: the screen was locked.");
        }
        let used = db.lock().ok().and_then(|c| local_bytes(&c).ok()).unwrap_or(i64::MAX);
        if used >= self.cap_bytes {
            return skip("Paused: local screenshot storage is full. Capture resumes once screenshots upload.");
        }
        if os.free_bytes(&self.dir).is_some_and(|free| free < MIN_FREE_DISK_BYTES) {
            return skip("Paused: less than 1 GB free disk space on this computer.");
        }

        let t0 = Instant::now();
        let result = os.capture(cfg.max_dimension).and_then(|frame| {
            let t1 = Instant::now();
            let webp = encode(&frame, cfg.quality)?;
            Ok((frame.width, frame.height, webp, t1 - t0, t1.elapsed()))
        });
        let Ok(mut st) = self.state.lock() else { return };
        let (width, height, webp, took, encode_took) = match result {
            Ok(r) => r,
            Err(e) => {
                st.status.error = Some(format!("Screenshot failed: {e}"));
                return;
            }
        };
        // Held state lock: a break/clock-out (configure) cannot slip in between this check and the save.
        if self.generation.load(Ordering::SeqCst) != generation || st.mode != "ACTIVE" || os.locked() {
            st.status.skipped = Some("Not kept: capture was stopped or the screen locked while it was being taken.".into());
            return; // the frame is dropped; nothing was written
        }
        let saved = db.lock().map_err(|e| e.to_string()).and_then(|conn| save(&conn, &self.dir, &scope, wall, width, height, &webp).map_err(|e| e.to_string()));
        match saved {
            Ok(_) => {
                st.status.error = None;
                st.status.skipped = None;
                st.status.last_capture = Some(CaptureInfo {
                    at_ms: wall,
                    width,
                    height,
                    bytes: webp.len(),
                    capture_ms: took.as_millis() as u64,
                    encode_ms: encode_took.as_millis() as u64,
                });
                eprintln!("[screenshot] saved {}x{} {} bytes (capture {} ms, encode {} ms)", width, height, webp.len(), took.as_millis(), encode_took.as_millis());
            }
            Err(e) => st.status.error = Some(format!("Could not save the screenshot on this computer: {e}")),
        }
    }

    /// Bookkeeping under the state lock; returns what to capture when a capture is due.
    fn due(&self, db: &Mutex<Connection>, wall: i64, mono: i64) -> Option<(Config, Scope, u64)> {
        let mut st = self.state.lock().ok()?;
        if let Some((lw, lm)) = st.last_tick {
            let (dw, dm) = (wall - lw, mono - lm);
            if dw < 0 || (dw - dm).abs() > GAP_TOLERANCE_MS || dm > GAP_TOLERANCE_MS {
                st.status.last_gap_ms = Some((lw, wall.max(lw)));
                // After sleep or a clock change: a fresh interval, never an immediate "catch-up" capture.
                if st.status.next_capture_ms.is_some() {
                    st.status.next_capture_ms = Some(wall + st.cfg.interval_ms);
                }
            }
        }
        st.last_tick = Some((wall, mono));
        if wall - st.last_cleanup_ms >= 60_000 {
            st.last_cleanup_ms = wall;
            if let Ok(conn) = db.lock() {
                let _ = cleanup_stored(&conn, &self.dir, wall);
            }
        }
        if !st.status.capturing {
            st.status.next_capture_ms = None;
            return None;
        }
        let interval = st.cfg.interval_ms;
        let next = *st.status.next_capture_ms.get_or_insert(wall + interval);
        if wall < next {
            return None;
        }
        st.status.next_capture_ms = Some(wall + st.cfg.interval_ms);
        Some((st.cfg, st.scope.clone()?, self.generation.load(Ordering::SeqCst)))
    }

    /// Sets the mode decided by the UI. Any change of mode, scope or interval restarts the schedule.
    pub fn configure(&self, mode: String, scope: Option<Scope>, cfg: Config) -> ShotStatus {
        let Ok(mut st) = self.state.lock() else { return self.status() };
        if st.mode != mode || st.scope != scope || st.cfg != cfg {
            self.generation.fetch_add(1, Ordering::SeqCst);
            st.status.next_capture_ms = None;
        }
        st.mode = mode;
        st.scope = scope;
        st.cfg = cfg;
        st.status.mode = st.mode.clone();
        st.status.capturing = st.mode == "ACTIVE" && st.scope.is_some() && platform::SUPPORTED;
        if !st.status.capturing {
            st.status.skipped = None;
        }
        drop(st);
        // Fresh permission, like status(): a stale value here made the UI flip between "On" and
        // "Needs permission" on every poll, restarting the schedule so no capture ever came due.
        self.status()
    }

    pub fn status(&self) -> ShotStatus {
        let mut s = self.state.lock().map(|s| s.status.clone()).unwrap_or_else(|_| ShotStatus {
            supported: platform::SUPPORTED,
            mode: "ERROR".into(),
            capturing: false,
            permission: false,
            skipped: None,
            next_capture_ms: None,
            last_capture: None,
            last_gap_ms: None,
            error: Some("Screenshot worker unavailable".into()),
        });
        // Fresh every time: the employee can revoke the permission in System Settings at any moment.
        s.permission = platform::SUPPORTED && platform::permission();
        s
    }
}

// ---- WebP ------------------------------------------------------------------------------

/// Lossy WebP at `quality` (0–100). The result is decoded again to validate it before it is kept.
pub fn encode(frame: &Frame, quality: f32) -> Result<Vec<u8>, String> {
    // The webp crate panics (would kill the worker) instead of erroring on a mismatched buffer.
    if frame.width == 0 || frame.height == 0 || frame.rgb.len() != frame.width as usize * frame.height as usize * 3 {
        return Err("invalid frame size".into());
    }
    let bytes = webp::Encoder::from_rgb(&frame.rgb, frame.width, frame.height)
        .encode_simple(false, quality.clamp(0.0, 100.0))
        .map_err(|e| format!("WebP encoding failed: {e:?}"))?
        .to_vec();
    let check = webp::BitstreamFeatures::new(&bytes).ok_or("WebP output is not readable")?;
    if (check.width(), check.height()) != (frame.width, frame.height) || webp::Decoder::new(&bytes).decode().is_none() {
        return Err("WebP output failed validation".into());
    }
    Ok(bytes)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Longest edge scaled down to `max_dimension` (never up), keeping the aspect ratio.
pub fn fit(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    let long = width.max(height).max(1);
    if long <= max_dimension {
        return (width, height);
    }
    let scale = f64::from(max_dimension) / f64::from(long);
    (((f64::from(width) * scale).round() as u32).max(1), ((f64::from(height) * scale).round() as u32).max(1))
}

// ---- Local queue -------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShotRow {
    pub id: String,
    pub session_id: String,
    pub captured_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub checksum: String,
    pub status: String,
    pub retries: i64,
    pub last_error: Option<String>,
}

const ROW_COLUMNS: &str = "id, session_id, captured_ms, width, height, size_bytes, checksum, status, retries, last_error";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ShotRow> {
    Ok(ShotRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        captured_ms: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        size_bytes: r.get(5)?,
        checksum: r.get(6)?,
        status: r.get(7)?,
        retries: r.get(8)?,
        last_error: r.get(9)?,
    })
}

fn file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.webp"))
}

fn io(e: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

/// Durable save: the row is written first (SAVING), then the file atomically (temp file, fsync,
/// rename, fsync directory), then the row becomes PENDING. A crash in between is repaired by
/// `recover`. Files are named by random UUID only and readable by the owner only.
pub fn save(conn: &Connection, dir: &Path, scope: &Scope, captured_ms: i64, width: u32, height: u32, webp: &[u8]) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO screenshots (id, user_id, device_id, session_id, captured_ms, width, height, size_bytes, checksum, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'SAVING')",
        params![id, scope.user_id, scope.device_id, scope.session_id, captured_ms, width, height, webp.len() as i64, sha256_hex(webp)],
    )?;
    let tmp = dir.join(format!("{id}.webp.tmp"));
    let written = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut f = options.open(&tmp)?;
        f.write_all(webp)?;
        f.sync_all()?;
        std::fs::rename(&tmp, file(dir, &id))?;
        std::fs::File::open(dir)?.sync_all()
    })();
    if let Err(e) = written {
        // Never saved: remove the partial file and its row (no screenshot content is kept).
        let _ = std::fs::remove_file(&tmp);
        conn.execute("DELETE FROM screenshots WHERE id = ?1 AND status = 'SAVING'", params![id])?;
        return Err(io(e));
    }
    conn.execute("UPDATE screenshots SET status = 'PENDING' WHERE id = ?1", params![id])?;
    Ok(id)
}

#[derive(Debug, Default, PartialEq)]
pub struct Recovered {
    pub completed: usize,
    pub failed: usize,
    pub temp_removed: usize,
}

/// At startup: finish or fail interrupted saves, flag queued screenshots whose file is gone or damaged.
/// Never deletes a queued screenshot file; only temp files of saves that never completed.
pub fn recover(conn: &Connection, dir: &Path) -> rusqlite::Result<Recovered> {
    let mut out = Recovered::default();
    for entry in std::fs::read_dir(dir).map_err(io)?.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".webp.tmp") && std::fs::remove_file(entry.path()).is_ok() {
            out.temp_removed += 1;
        }
    }
    let rows: Vec<ShotRow> = conn
        .prepare(&format!("SELECT {ROW_COLUMNS} FROM screenshots WHERE status IN ('SAVING', 'PENDING', 'REGISTERED')"))?
        .query_map([], row)?
        .collect::<rusqlite::Result<_>>()?;
    for r in rows {
        let intact = std::fs::read(file(dir, &r.id)).is_ok_and(|b| sha256_hex(&b) == r.checksum);
        if intact && r.status == "SAVING" {
            conn.execute("UPDATE screenshots SET status = 'PENDING' WHERE id = ?1", params![r.id])?;
            out.completed += 1;
        } else if !intact {
            let reason = if r.status == "SAVING" { "The app closed while this screenshot was being saved; it was not kept." } else { "The screenshot file is missing or damaged on this computer." };
            conn.execute("UPDATE screenshots SET status = 'FAILED', last_error = ?2 WHERE id = ?1", params![r.id, reason])?;
            out.failed += 1;
        }
    }
    Ok(out)
}

/// Next screenshot to upload for this scope: oldest PENDING/REGISTERED whose retry time has come.
pub fn next_upload(conn: &Connection, user_id: &str, device_id: &str, now: i64) -> rusqlite::Result<Option<ShotRow>> {
    conn.query_row(
        &format!(
            "SELECT {ROW_COLUMNS} FROM screenshots WHERE user_id = ?1 AND device_id = ?2 AND status IN ('PENDING', 'REGISTERED')
             AND next_attempt_ms <= ?3 ORDER BY captured_ms, seq LIMIT 1"
        ),
        params![user_id, device_id, now],
        row,
    )
    .optional()
}

/// The file's bytes, verified against the checksum recorded at capture. A damaged file is marked FAILED.
pub fn read(conn: &Connection, dir: &Path, id: &str) -> Result<Vec<u8>, String> {
    let checksum: String = conn
        .query_row("SELECT checksum FROM screenshots WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let bytes = std::fs::read(file(dir, id)).map_err(|e| e.to_string());
    if bytes.as_ref().is_ok_and(|b| sha256_hex(b) == checksum) {
        return bytes;
    }
    let _ = conn.execute("UPDATE screenshots SET status = 'FAILED', last_error = 'The screenshot file is missing or damaged on this computer.' WHERE id = ?1", params![id]);
    Err("Screenshot file is missing or damaged".into())
}

/// Upload outcomes reported by the webview. RETRY backs off exponentially (30 s … 1 h); never deletes.
pub fn mark(conn: &Connection, id: &str, outcome: &str, reason: Option<&str>, now: i64) -> rusqlite::Result<()> {
    match outcome {
        "REGISTERED" => conn.execute("UPDATE screenshots SET status = 'REGISTERED', last_error = NULL WHERE id = ?1 AND status = 'PENDING'", params![id])?,
        "STORED" => conn.execute(
            "UPDATE screenshots SET status = 'STORED', stored_ms = ?2, last_error = NULL WHERE id = ?1 AND status IN ('PENDING', 'REGISTERED')",
            params![id, now],
        )?,
        "REJECTED" => conn.execute("UPDATE screenshots SET status = 'REJECTED', last_error = ?2 WHERE id = ?1 AND status IN ('PENDING', 'REGISTERED')", params![id, reason])?,
        "RETRY" => conn.execute(
            "UPDATE screenshots SET retries = retries + 1, last_error = ?2,
               next_attempt_ms = ?3 + min(3600000, 30000 * (1 << min(retries, 7))) WHERE id = ?1",
            params![id, reason, now],
        )?,
        _ => return Err(rusqlite::Error::InvalidParameterName(outcome.into())),
    };
    Ok(())
}

/// Removes local files of screenshots confirmed by cloud storage more than the grace period ago.
/// Only STORED: anything not confirmed is never deleted automatically.
pub fn cleanup_stored(conn: &Connection, dir: &Path, now: i64) -> rusqlite::Result<usize> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM screenshots WHERE status = 'STORED' AND stored_ms < ?1")?
        .query_map(params![now - STORED_GRACE_MS], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &ids {
        // File first, then the row: an interrupted cleanup leaves a row to retry, never an orphan file.
        match std::fs::remove_file(file(dir, id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        conn.execute("DELETE FROM screenshots WHERE id = ?1 AND status = 'STORED'", params![id])?;
    }
    Ok(ids.len())
}

/// The employee dismissed failed/rejected screenshots: their files and rows are removed (user action).
pub fn dismiss(conn: &Connection, dir: &Path, user_id: &str, device_id: &str) -> rusqlite::Result<usize> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM screenshots WHERE status IN ('FAILED', 'REJECTED') AND user_id = ?1 AND device_id = ?2")?
        .query_map(params![user_id, device_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &ids {
        let _ = std::fs::remove_file(file(dir, id));
        conn.execute("DELETE FROM screenshots WHERE id = ?1", params![id])?;
    }
    Ok(ids.len())
}

/// Bytes of all screenshot files on this computer (every user), for the storage cap.
pub fn local_bytes(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT coalesce(sum(size_bytes), 0) FROM screenshots WHERE status != 'FAILED'", [], |r| r.get(0))
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Saved locally, not yet confirmed by cloud storage.
    pub waiting: i64,
    /// Of those, how many have failed at least one upload attempt.
    pub retrying: i64,
    pub stored_local: i64,
    pub failed: i64,
    pub rejected: i64,
    pub last_stored_ms: Option<i64>,
    pub last_error: Option<String>,
    pub problems: Vec<String>,
    pub local_bytes: i64,
    pub cap_bytes: i64,
}

pub fn summary(conn: &Connection, user_id: &str, device_id: &str, cap_bytes: i64) -> rusqlite::Result<Summary> {
    let mut s = conn.query_row(
        "SELECT count(CASE WHEN status IN ('SAVING', 'PENDING', 'REGISTERED') THEN 1 END),
                count(CASE WHEN status IN ('PENDING', 'REGISTERED') AND retries > 0 THEN 1 END),
                count(CASE WHEN status = 'STORED' THEN 1 END),
                count(CASE WHEN status = 'FAILED' THEN 1 END),
                count(CASE WHEN status = 'REJECTED' THEN 1 END),
                max(stored_ms)
         FROM screenshots WHERE user_id = ?1 AND device_id = ?2",
        params![user_id, device_id],
        |r| {
            Ok(Summary {
                waiting: r.get(0)?,
                retrying: r.get(1)?,
                stored_local: r.get(2)?,
                failed: r.get(3)?,
                rejected: r.get(4)?,
                last_stored_ms: r.get(5)?,
                cap_bytes,
                ..Summary::default()
            })
        },
    )?;
    s.last_error = conn
        .query_row(
            "SELECT last_error FROM screenshots WHERE user_id = ?1 AND device_id = ?2 AND status IN ('PENDING', 'REGISTERED') AND last_error IS NOT NULL ORDER BY captured_ms DESC LIMIT 1",
            params![user_id, device_id],
            |r| r.get(0),
        )
        .optional()?;
    s.problems = conn
        .prepare("SELECT DISTINCT last_error FROM screenshots WHERE user_id = ?1 AND device_id = ?2 AND status IN ('FAILED', 'REJECTED') LIMIT 10")?
        .query_map(params![user_id, device_id], |r| r.get::<_, Option<String>>(0))?
        .filter_map(|r| r.ok().flatten())
        .collect();
    s.local_bytes = local_bytes(conn)?;
    Ok(s)
}

// ---- OS integration --------------------------------------------------------------------

pub mod platform {
    pub use imp::{permission, request_permission, Native, SUPPORTED};

    #[cfg(target_os = "macos")]
    mod imp {
        use super::super::{fit, Frame, Os};
        use crate::activity;
        use block2::RcBlock;
        use objc2::rc::Retained;
        use objc2::runtime::AnyClass;
        use objc2::AnyThread;
        use objc2_core_foundation::CFRetained;
        use objc2_core_graphics::{CGDataProvider, CGImage, CGImageByteOrderInfo, CGMainDisplayID, CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
        use objc2_foundation::{NSArray, NSError};
        use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration};
        use std::path::Path;
        use std::ptr::NonNull;
        use std::sync::mpsc;
        use std::time::Duration;

        pub const SUPPORTED: bool = true;
        const TIMEOUT: Duration = Duration::from_secs(15);

        /// Whether the user granted Screen Recording to this app. Never prompts.
        pub fn permission() -> bool {
            CGPreflightScreenCaptureAccess()
        }

        /// Shows the macOS permission prompt (first time only; afterwards the user changes it in
        /// System Settings › Privacy & Security › Screen & System Audio Recording). Not bypassable.
        pub fn request_permission() -> bool {
            CGRequestScreenCaptureAccess()
        }

        fn describe(err: *mut NSError) -> String {
            unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "unknown error".into())
        }

        /// ScreenCaptureKit objects are used from the completion queue; only the result crosses threads.
        struct Sendable<T>(T);
        unsafe impl<T> Send for Sendable<T> {}

        /// BGRA (SDR screenshots) → packed RGB.
        fn pixels(image: &CGImage) -> Result<Frame, String> {
            let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
            let stride = CGImage::bytes_per_row(Some(image));
            if CGImage::bits_per_pixel(Some(image)) != 32 || CGImage::byte_order_info(Some(image)) != CGImageByteOrderInfo::Order32Little {
                return Err("unexpected pixel format".into());
            }
            let data = CGImage::data_provider(Some(image)).and_then(|p| CGDataProvider::data(Some(&p))).ok_or("no pixel data")?;
            let bytes = data.to_vec();
            if bytes.len() < stride * h {
                return Err("truncated pixel data".into());
            }
            let mut rgb = Vec::with_capacity(w * h * 3);
            for row in bytes.chunks_exact(stride).take(h) {
                for px in row[..w * 4].as_chunks::<4>().0 {
                    rgb.extend_from_slice(&[px[2], px[1], px[0]]);
                }
            }
            Ok(Frame { width: w as u32, height: h as u32, rgb })
        }

        pub struct Native;

        impl Os for Native {
            fn permission(&self) -> bool {
                permission()
            }

            fn locked(&self) -> bool {
                activity::platform::screen_locked()
            }

            fn free_bytes(&self, dir: &Path) -> Option<u64> {
                let path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()).ok()?;
                let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
                (unsafe { libc::statvfs(path.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize)
            }

            /// The primary display only (CGMainDisplayID), scaled to `max_dimension`, without the cursor.
            fn capture(&self, max_dimension: u32) -> Result<Frame, String> {
                if AnyClass::get(c"SCScreenshotManager").is_none() {
                    return Err("screenshots need macOS 14 or later".into());
                }
                let (tx, rx) = mpsc::sync_channel(1);
                let block = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
                    let r = unsafe { Retained::retain(content) }.ok_or_else(|| describe(err));
                    let _ = tx.send(Sendable(r));
                });
                unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false, true, &block) };
                let content = rx.recv_timeout(TIMEOUT).map_err(|_| "timed out listing displays")?.0?;

                let main = CGMainDisplayID();
                let displays = unsafe { content.displays() };
                let display = displays.iter().find(|d| unsafe { d.displayID() } == main).ok_or("primary display not available")?;
                let none = NSArray::new();
                let filter = unsafe { SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &none) };
                let scale = f64::from(unsafe { filter.pointPixelScale() }).max(1.0);
                let (pw, ph) = ((unsafe { display.width() } as f64 * scale) as u32, (unsafe { display.height() } as f64 * scale) as u32);
                let (w, h) = fit(pw, ph, max_dimension);
                let config = unsafe { SCStreamConfiguration::new() };
                unsafe {
                    config.setWidth(w as usize);
                    config.setHeight(h as usize);
                    config.setShowsCursor(false);
                    config.setPixelFormat(u32::from_be_bytes(*b"BGRA")); // kCVPixelFormatType_32BGRA
                }

                let (tx, rx) = mpsc::sync_channel(1);
                let block = RcBlock::new(move |image: *mut CGImage, err: *mut NSError| {
                    // The image is only valid inside this handler: convert it here.
                    let r = NonNull::new(image).ok_or_else(|| describe(err)).and_then(|p| pixels(&*unsafe { CFRetained::retain(p) }));
                    let _ = tx.send(r);
                });
                unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&block)) };
                rx.recv_timeout(TIMEOUT).map_err(|_| "timed out capturing the screen".to_string())?
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    mod imp {
        // Windows capture is not implemented (see docs/windows.md): nothing is captured here.
        use super::super::{Frame, Os};
        use std::path::Path;
        pub const SUPPORTED: bool = false;
        pub fn permission() -> bool {
            false
        }
        pub fn request_permission() -> bool {
            false
        }
        pub struct Native;
        impl Os for Native {
            fn permission(&self) -> bool {
                false
            }
            fn locked(&self) -> bool {
                false
            }
            fn free_bytes(&self, _: &Path) -> Option<u64> {
                None
            }
            fn capture(&self, _: u32) -> Result<Frame, String> {
                Err("not supported on this operating system".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    const MIN: i64 = 60_000;

    /// A synthetic "screen": light background with dark text-like strokes (realistic for WebP).
    fn screen(w: u32, h: u32) -> Frame {
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                let text = (y % 24 < 14) && (x % 9 < 6) && ((x / 9 + y / 24) % 7 != 0) && (x / 300 + y / 200) % 3 != 2;
                let v = if text { 30 } else { 235 - ((x + y) % 20) as u8 };
                rgb.extend_from_slice(&[v, v, if text { 30 } else { 245 }]);
            }
        }
        Frame { width: w, height: h, rgb }
    }

    struct FakeOs {
        permission: AtomicBool,
        locked: AtomicBool,
        fail: AtomicBool,
        captures: AtomicU64,
        free: u64,
        on_capture: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }
    impl FakeOs {
        fn new() -> FakeOs {
            FakeOs { permission: AtomicBool::new(true), locked: AtomicBool::new(false), fail: AtomicBool::new(false), captures: AtomicU64::new(0), free: u64::MAX, on_capture: Mutex::new(None) }
        }
    }
    impl Os for FakeOs {
        fn permission(&self) -> bool {
            self.permission.load(Ordering::SeqCst)
        }
        fn locked(&self) -> bool {
            self.locked.load(Ordering::SeqCst)
        }
        fn free_bytes(&self, _: &Path) -> Option<u64> {
            Some(self.free)
        }
        fn capture(&self, max_dimension: u32) -> Result<Frame, String> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            if let Some(hook) = self.on_capture.lock().unwrap().as_ref() {
                hook();
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("The user declined TCCs for application, window, display capture".into());
            }
            let (w, h) = fit(2880, 1800, max_dimension);
            Ok(screen(w, h))
        }
    }

    struct Env {
        dir: PathBuf,
        db: Mutex<Connection>,
    }
    impl Env {
        fn new() -> Env {
            let dir = std::env::temp_dir().join(format!("wf-shots-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let db = Mutex::new(crate::queue::open(&dir.join("queue.db")).unwrap());
            Env { dir, db }
        }
        fn rows(&self) -> Vec<ShotRow> {
            let c = self.db.lock().unwrap();
            c.prepare(&format!("SELECT {ROW_COLUMNS} FROM screenshots ORDER BY seq")).unwrap().query_map([], row).unwrap().map(|r| r.unwrap()).collect()
        }
    }
    impl Drop for Env {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn scope() -> Scope {
        Scope { user_id: "u1".into(), device_id: "d1".into(), session_id: "s1".into() }
    }
    const CFG: Config = Config { interval_ms: 5 * MIN, quality: 70.0, max_dimension: 1920 };

    /// Ticks every second from `from` to `to` (ms), wall == monotonic.
    fn run(s: &Shooter, e: &Env, os: &FakeOs, from: i64, to: i64) {
        for t in (from..=to).step_by(1000) {
            s.tick(&e.db, os, t, t);
        }
    }

    #[test]
    fn captures_on_schedule_only_while_active_and_saves_a_valid_private_webp() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        run(&s, &e, &os, 0, 20 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "STOPPED: never captures");

        let configured = s.configure("ACTIVE".into(), Some(scope()), CFG);
        assert_eq!(configured.permission, platform::permission(), "configure reports the current OS permission, not a cached one");
        let start = 20 * MIN + 1000;
        run(&s, &e, &os, start, start + 5 * MIN - 1000);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "first capture one interval after start, not at clock-in");
        assert_eq!(s.status().next_capture_ms, Some(start + 5 * MIN));
        run(&s, &e, &os, start + 5 * MIN, start + 10 * MIN + 500);
        assert_eq!(os.captures.load(Ordering::SeqCst), 2, "one per interval");

        let rows = e.rows();
        assert_eq!(rows.iter().map(|r| (r.status.as_str(), r.captured_ms, r.width, r.height, r.session_id.as_str())).collect::<Vec<_>>(), [
            ("PENDING", start + 5 * MIN, 1920, 1200, "s1"),
            ("PENDING", start + 10 * MIN, 1920, 1200, "s1"),
        ]);
        let bytes = read(&e.db.lock().unwrap(), &e.dir, &rows[0].id).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        assert_eq!(sha256_hex(&bytes), rows[0].checksum);
        assert_eq!(bytes.len() as i64, rows[0].size_bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file(&e.dir, &rows[0].id)).unwrap().permissions().mode() & 0o777, 0o600, "owner-only file");
        }
        let names: Vec<_> = std::fs::read_dir(&e.dir).unwrap().map(|f| f.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".webp")).collect();
        assert!(names.iter().all(|n| uuid::Uuid::parse_str(n.trim_end_matches(".webp")).is_ok()), "UUID file names only: {names:?}");
        let info = s.status().last_capture.unwrap();
        assert_eq!((info.width, info.height, info.at_ms), (1920, 1200, start + 10 * MIN));
    }

    #[test]
    fn break_clock_out_permission_lock_and_errors_prevent_capture() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 0, 4 * MIN);
        s.configure("PAUSED_BREAK".into(), None, CFG);
        run(&s, &e, &os, 4 * MIN + 1000, 30 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "break: nothing");
        assert_eq!(s.status().next_capture_ms, None);

        s.configure("ACTIVE".into(), Some(scope()), CFG);
        os.permission.store(false, Ordering::SeqCst);
        run(&s, &e, &os, 30 * MIN + 1000, 36 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "no permission: not even attempted");
        assert!(s.status().skipped.unwrap().contains("Screen Recording permission"));

        os.permission.store(true, Ordering::SeqCst);
        os.locked.store(true, Ordering::SeqCst);
        run(&s, &e, &os, 36 * MIN + 1000, 41 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "locked: skipped");
        assert_eq!(s.status().skipped.as_deref(), Some("Not taken: the screen was locked."));

        os.locked.store(false, Ordering::SeqCst);
        os.fail.store(true, Ordering::SeqCst); // e.g. permission revoked between the check and the capture
        run(&s, &e, &os, 41 * MIN + 1000, 46 * MIN);
        assert!(s.status().error.unwrap().contains("declined"));
        assert!(e.rows().is_empty(), "nothing saved for a failed capture");

        s.configure("STOPPED".into(), None, CFG);
        os.fail.store(false, Ordering::SeqCst);
        run(&s, &e, &os, 46 * MIN + 1000, 90 * MIN);
        assert!(e.rows().is_empty(), "clocked out: nothing");
    }

    #[test]
    fn a_capture_racing_a_break_or_lock_is_discarded() {
        let e = Env::new();
        let os = Arc::new(FakeOs::new());
        let s = Arc::new(Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES));
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        let shooter = s.clone();
        *os.on_capture.lock().unwrap() = Some(Box::new(move || {
            shooter.configure("PAUSED_BREAK".into(), None, CFG); // the employee starts a break mid-capture
        }));
        run(&s, &e, &os, 0, 5 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 1);
        assert!(e.rows().is_empty(), "frame dropped, nothing written");

        let flag = os.clone();
        *os.on_capture.lock().unwrap() = Some(Box::new(move || flag.locked.store(true, Ordering::SeqCst)));
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 5 * MIN + 1000, 10 * MIN + 1000);
        assert_eq!(os.captures.load(Ordering::SeqCst), 2);
        assert!(e.rows().is_empty(), "locked during the capture: dropped");
    }

    #[test]
    fn sleep_and_clock_changes_restart_the_interval_instead_of_capturing_at_wake() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 0, 2 * MIN);
        // Asleep for an hour: the monotonic clock stops, the wall clock does not.
        let wake = 62 * MIN;
        s.tick(&e.db, &os, wake, 2 * MIN + 1000);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "no capture at wake (usually the lock screen)");
        assert_eq!(s.status().last_gap_ms, Some((2 * MIN, wake)));
        assert_eq!(s.status().next_capture_ms, Some(wake + 5 * MIN));
        for k in 1..=300 {
            s.tick(&e.db, &os, wake + k * 1000, 2 * MIN + 1000 + k * 1000);
        }
        assert_eq!(os.captures.load(Ordering::SeqCst), 1, "resumes one interval after wake");
        // Wall clock set back an hour: also a gap, schedule restarted.
        s.tick(&e.db, &os, wake, 2 * MIN + 302_000);
        assert_eq!(s.status().next_capture_ms, Some(wake + 5 * MIN));
    }

    #[test]
    fn storage_cap_and_low_disk_pause_capture_without_deleting_anything() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), 1); // any saved screenshot reaches this cap
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 0, 15 * MIN);
        assert_eq!(e.rows().len(), 1, "first capture fits, then capture pauses");
        assert!(s.status().skipped.unwrap().contains("storage is full"));
        assert_eq!(e.rows()[0].status, "PENDING", "the unsynced screenshot is kept");

        let low = FakeOs { free: 100 * 1024 * 1024, ..FakeOs::new() };
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &low, 0, 6 * MIN);
        assert_eq!(low.captures.load(Ordering::SeqCst), 0);
        assert!(s.status().skipped.unwrap().contains("free disk space"));
    }

    #[test]
    fn queue_survives_restart_retries_with_backoff_and_only_confirmed_files_are_cleaned_up() {
        let e = Env::new();
        let webp = encode(&screen(64, 40), 70.0).unwrap();
        let (a, b, c) = {
            let conn = e.db.lock().unwrap();
            (save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp).unwrap(), save(&conn, &e.dir, &scope(), 2_000, 64, 40, &webp).unwrap(), save(&conn, &e.dir, &scope(), 3_000, 64, 40, &webp).unwrap())
        };
        // Reopen (app restart): still queued, in capture order.
        let conn = crate::queue::open(&e.dir.join("queue.db")).unwrap();
        assert_eq!(next_upload(&conn, "u1", "d1", 0).unwrap().unwrap().id, a);
        assert!(next_upload(&conn, "u2", "d1", 0).unwrap().is_none(), "scoped to the employee");

        mark(&conn, &a, "RETRY", Some("Server unreachable"), 10_000).unwrap();
        assert_eq!(next_upload(&conn, "u1", "d1", 10_000).unwrap().unwrap().id, b, "a failed upload waits for its retry time");
        assert_eq!(next_upload(&conn, "u1", "d1", 40_000).unwrap().unwrap().id, a, "30 s later it is retried first");
        mark(&conn, &a, "RETRY", Some("Server unreachable"), 40_000).unwrap();
        assert!(next_upload(&conn, "u1", "d1", 40_000 + 59_000).unwrap().is_some_and(|r| r.id == b), "second backoff: 60 s");
        for _ in 0..20 {
            mark(&conn, &a, "RETRY", Some("Storage unavailable"), 0).unwrap();
        }
        let next: i64 = conn.query_row("SELECT next_attempt_ms FROM screenshots WHERE id = ?1", params![a], |r| r.get(0)).unwrap();
        assert_eq!(next, 3_600_000, "backoff capped at one hour; never given up or deleted");

        mark(&conn, &b, "REGISTERED", None, 0).unwrap();
        mark(&conn, &b, "STORED", None, 50_000).unwrap();
        mark(&conn, &c, "REJECTED", Some("Captured outside clocked-in time"), 0).unwrap();
        let sum = summary(&conn, "u1", "d1", LOCAL_CAP_BYTES).unwrap();
        assert_eq!((sum.waiting, sum.retrying, sum.stored_local, sum.rejected, sum.last_stored_ms), (1, 1, 1, 1, Some(50_000)));
        assert_eq!(sum.last_error.as_deref(), Some("Storage unavailable"));
        assert_eq!(sum.problems, ["Captured outside clocked-in time"]);
        assert_eq!(sum.local_bytes, 3 * webp.len() as i64);

        assert_eq!(cleanup_stored(&conn, &e.dir, 50_000 + STORED_GRACE_MS - 1).unwrap(), 0, "kept during the grace period");
        assert_eq!(cleanup_stored(&conn, &e.dir, 10 * STORED_GRACE_MS).unwrap(), 1, "only the confirmed one, even long after");
        assert!(!file(&e.dir, &b).exists() && file(&e.dir, &a).exists() && file(&e.dir, &c).exists());
        assert_eq!(dismiss(&conn, &e.dir, "u1", "d1").unwrap(), 1, "the employee dismisses the rejected one");
        assert!(!file(&e.dir, &c).exists());
        assert_eq!(next_upload(&conn, "u1", "d1", i64::MAX).unwrap().unwrap().id, a, "the unsynced screenshot is still there");
    }

    #[test]
    fn crash_recovery_completes_interrupted_saves_and_flags_damaged_files() {
        let e = Env::new();
        let webp = encode(&screen(64, 40), 70.0).unwrap();
        let conn = e.db.lock().unwrap();
        let ok = save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp).unwrap();
        let renamed = save(&conn, &e.dir, &scope(), 2_000, 64, 40, &webp).unwrap();
        let lost = save(&conn, &e.dir, &scope(), 3_000, 64, 40, &webp).unwrap();
        let damaged = save(&conn, &e.dir, &scope(), 4_000, 64, 40, &webp).unwrap();
        // Crashed after the rename but before PENDING; crashed before the rename; file corrupted on disk.
        conn.execute("UPDATE screenshots SET status = 'SAVING' WHERE id IN (?1, ?2)", params![renamed, lost]).unwrap();
        std::fs::rename(file(&e.dir, &lost), e.dir.join(format!("{lost}.webp.tmp"))).unwrap();
        std::fs::write(file(&e.dir, &damaged), b"RIFF garbage").unwrap();

        let r = recover(&conn, &e.dir).unwrap();
        assert_eq!(r, Recovered { completed: 1, failed: 2, temp_removed: 1 });
        let status = |id: &str| conn.query_row("SELECT status FROM screenshots WHERE id = ?1", params![id], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!([status(&ok), status(&renamed), status(&lost), status(&damaged)], ["PENDING", "PENDING", "FAILED", "FAILED"]);
        assert!(file(&e.dir, &damaged).exists(), "a damaged file is flagged, not deleted");
        assert_eq!(recover(&conn, &e.dir).unwrap(), Recovered::default(), "idempotent");
        assert!(read(&conn, &e.dir, &ok).is_ok());
        std::fs::write(file(&e.dir, &ok), b"tampered").unwrap();
        assert!(read(&conn, &e.dir, &ok).is_err(), "integrity checked before every upload");
        assert_eq!(status(&ok), "FAILED");
    }

    /// Real capture of the primary display (macOS). Run explicitly:
    /// `cargo test --release native_capture -- --ignored --nocapture`. Never prompts: without the
    /// Screen Recording permission it only reports that.
    #[test]
    #[ignore]
    fn native_capture_benchmark() {
        if !platform::permission() {
            eprintln!("[native] Screen Recording permission NOT granted to this process: no capture attempted");
            return;
        }
        let os = platform::Native;
        for max in [1920, 1280] {
            let t = Instant::now();
            let frame = os.capture(max).expect("capture");
            let took = t.elapsed();
            let t = Instant::now();
            let webp = encode(&frame, 70.0).unwrap();
            eprintln!("[native] {}x{} capture {} ms, encode {} ms, {} KB (q70)", frame.width, frame.height, took.as_millis(), t.elapsed().as_millis(), webp.len() / 1024);
        }
    }

    #[test]
    fn webp_scaling_quality_and_benchmark() {
        assert_eq!(fit(2880, 1800, 1920), (1920, 1200));
        assert_eq!(fit(1280, 800, 1920), (1280, 800), "never upscaled");
        assert_eq!(fit(1800, 2880, 1920), (1200, 1920), "portrait");
        let frame = screen(1920, 1200);
        let raw = frame.rgb.len();
        let t = Instant::now();
        let q70 = encode(&frame, 70.0).unwrap();
        let took = t.elapsed();
        let q40 = encode(&frame, 40.0).unwrap();
        assert!(q70.len() < raw / 10, "{} bytes for {} raw", q70.len(), raw);
        assert!(q40.len() < q70.len(), "lower quality, smaller file");
        let decoded = webp::Decoder::new(&q70).decode().unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1920, 1200));
        eprintln!("[bench] 1920x1200 synthetic screen: q70 {} bytes, q40 {} bytes, encode {} ms ({})", q70.len(), q40.len(), took.as_millis(), if cfg!(debug_assertions) { "debug" } else { "release" });
        assert!(encode(&Frame { width: 10, height: 10, rgb: vec![0; 10] }, 70.0).is_err(), "short buffer refused, not a crash");
    }
}
