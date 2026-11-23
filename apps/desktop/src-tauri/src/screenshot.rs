//! Screenshot capture: one worker thread for the app's lifetime, a durable local queue (SQLite
//! metadata + private WebP files) and the capture itself (macOS ScreenCaptureKit, Windows GDI).
//!
//! The webview decides whether capture is allowed (clocked in, not on a break, device active,
//! screenshots enabled, screenshot notice acknowledged). Right before every capture this worker
//! also checks the OS Screen Recording permission, the screen lock, sleep, and local storage.
//! Only the primary display is captured. Nothing is ever captured silently: the app shows the
//! state, next capture and last capture at all times.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub interval_ms: i64,
    pub quality: f32,
    pub max_dimension: u32,
    /// Privacy masks from the server policy, blacked out before encoding.
    pub masks: Vec<Mask>,
    /// Whole-image blur from the server policy. `None` = the setting received was unreadable:
    /// capture pauses rather than risk an unblurred screenshot.
    pub blur: Option<bool>,
}

/// What the worker holds while nothing is captured (stopped, signed out, quitting). The values in
/// force while capturing always come from the server policy via `screenshot_configure`; these mirror
/// `DEFAULT_SCREENSHOT_SETTINGS` (packages/shared) only so the idle worker has a valid configuration.
impl Default for Config {
    fn default() -> Self {
        Config { interval_ms: 300_000, quality: 70.0, max_dimension: 1920, masks: Vec::new(), blur: Some(false) }
    }
}

/// Mask coordinates are fractions of the frame in units of 1/`MASK_SCALE` (server: `SCREENSHOT_MASK_SCALE`).
pub const MASK_SCALE: u32 = 10_000;
pub const MASK_MAX: usize = 20;
const MASKS_INVALID: &str = "Screenshots paused: the privacy mask settings received from the server are invalid.";
const BLUR_INVALID: &str = "Screenshots paused: the blur setting received from the server is invalid.";
/// `ShotStatus::skipped` starts with this when a due capture was attempted and failed (capture,
/// encoding or the local save). The UI tells it apart from "Not taken: …" (locked, asleep, no
/// permission) and "Paused: …" (storage) by this prefix (CAPTURE_FAILED in monitoring.ts). Never
/// latched: the next interval tries again.
pub const CAPTURE_FAILED: &str = "Capture failed: ";

/// A rectangle filled black on the captured pixels before the image is encoded: the covered
/// pixels are never written to disk or uploaded. Reported to the server with each screenshot.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mask {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

/// Same rules as the server's schema; anything else stops capture instead of capturing unmasked.
pub fn masks_valid(masks: &[Mask]) -> bool {
    let scale = MASK_SCALE;
    masks.len() <= MASK_MAX
        && masks.iter().all(|m| m.w > 0 && m.h > 0 && u32::from(m.x) + u32::from(m.w) <= scale && u32::from(m.y) + u32::from(m.h) <= scale)
}

/// Fills each mask with black. Edges are rounded outwards, so a mask always covers at least its
/// share of the frame at any resolution.
pub fn apply_masks(frame: &mut Frame, masks: &[Mask]) {
    let (w, h, s) = (u64::from(frame.width), u64::from(frame.height), u64::from(MASK_SCALE));
    if frame.rgb.len() as u64 != w * h * 3 {
        return; // rejected by encode(); never written
    }
    let stride = frame.width as usize * 3;
    for m in masks {
        let x0 = (u64::from(m.x) * w / s).min(w) as usize;
        let x1 = ((u64::from(m.x) + u64::from(m.w)) * w).div_ceil(s).min(w) as usize;
        let y0 = (u64::from(m.y) * h / s).min(h) as usize;
        let y1 = ((u64::from(m.y) + u64::from(m.h)) * h).div_ceil(s).min(h) as usize;
        if x0 >= x1 {
            continue;
        }
        for row in y0..y1 {
            frame.rgb[row * stride + x0 * 3..row * stride + x1 * 3].fill(0);
        }
    }
}

/// Blur radius for a frame: 1/120 of the longest edge, at least 8 px (16 px at 1920, 32 px at 3840).
/// Three box passes of this radius approximate a Gaussian with sigma ~ radius, several times the
/// height of on-screen text, so text and faces become unreadable smudges. Scaling with the frame
/// keeps the effect the same whatever `max_dimension` is.
pub fn blur_radius(width: u32, height: u32) -> usize {
    (width.max(height) / 120).max(8) as usize
}

/// Strong whole-image blur, in place: three separable box-blur passes (horizontal then vertical),
/// each O(pixels) with running sums whatever the radius. Edges average over the pixels inside
/// the frame. Extra memory: one row plus a ring of `radius + 1` rows (~0.4 MB at 3840 px), never
/// a second copy of the frame. Called before encoding: unblurred pixels never reach disk.
pub fn apply_blur(frame: &mut Frame) {
    let (w, h) = (frame.width as usize, frame.height as usize);
    if w == 0 || h == 0 || frame.rgb.len() != w * h * 3 {
        return; // rejected by encode(); never written
    }
    let r = blur_radius(frame.width, frame.height);
    // Fixed-point reciprocal of each window size: out = (sum * inv + half) >> 24, no division per pixel.
    let inv = |count: usize| ((1u64 << 24) + count as u64 / 2) / count as u64;
    let window = |i: usize, n: usize| (i + r).min(n - 1) - i.saturating_sub(r) + 1;
    let px = |sum: u32, inv: u64| ((u64::from(sum) * inv + (1 << 23)) >> 24).min(255) as u8;
    let inv_x: Vec<u64> = (0..w).map(|x| inv(window(x, w))).collect();
    let stride = w * 3;
    let mut line = vec![0u8; stride];
    let mut sums = vec![0u32; stride];
    let mut ring = vec![0u8; (r + 1) * stride];
    for _ in 0..3 {
        for row in frame.rgb.chunks_exact_mut(stride) {
            line.copy_from_slice(row);
            for c in 0..3 {
                let mut sum: u32 = (0..=r.min(w - 1)).map(|x| u32::from(line[x * 3 + c])).sum();
                for x in 0..w {
                    row[x * 3 + c] = px(sum, inv_x[x]);
                    if x + r + 1 < w {
                        sum += u32::from(line[(x + r + 1) * 3 + c]);
                    }
                    if x >= r {
                        sum -= u32::from(line[(x - r) * 3 + c]);
                    }
                }
            }
        }
        // Vertical: column sums for all columns at once, row by row (cache friendly). Rows above
        // the current one are already blurred, so their originals are kept in the ring.
        sums.fill(0);
        for y in 0..=r.min(h - 1) {
            for (s, &v) in sums.iter_mut().zip(&frame.rgb[y * stride..(y + 1) * stride]) {
                *s += u32::from(v);
            }
        }
        for y in 0..h {
            let slot = (y % (r + 1)) * stride;
            let k = inv(window(y, h));
            let row = &mut frame.rgb[y * stride..(y + 1) * stride];
            // The slot holds the original of row y - r - 1, which leaves the window now.
            let leaving = y > r;
            for i in 0..stride {
                let orig = row[i];
                if leaving {
                    sums[i] -= u32::from(ring[slot + i]);
                }
                ring[slot + i] = orig;
                row[i] = px(sums[i], k);
            }
            if y + r + 1 < h {
                for (s, &v) in sums.iter_mut().zip(&frame.rgb[(y + r + 1) * stride..(y + r + 2) * stride]) {
                    *s += u32::from(v);
                }
            }
        }
    }
}

/// Everything done to captured pixels before encoding: masks, then blur, then the masks again so
/// masked areas stay solid black (the blur would otherwise bleed light into their edges).
pub fn redact(frame: &mut Frame, cfg: &Config) {
    apply_masks(frame, &cfg.masks);
    if cfg.blur == Some(true) {
        apply_blur(frame);
        apply_masks(frame, &cfg.masks);
    }
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
    /// This build can capture (macOS 14+, Windows).
    pub supported: bool,
    pub mode: String,
    /// Mode is ACTIVE with an employee/device/session scope: captures happen on schedule.
    pub capturing: bool,
    /// Screen Recording permission (CGPreflightScreenCaptureAccess); checked on every status call.
    /// Always true on Windows, which has no screen-capture permission.
    pub permission: bool,
    /// Why the last due capture did not happen or was not kept: "Not taken: …" (screen locked,
    /// display asleep, no permission), "Paused: …" (storage) or "Capture failed: …" (`CAPTURE_FAILED`).
    /// Cleared by the next saved capture; never stops the schedule.
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
    /// The captured display is asleep (dark): nothing to capture even when the screen is not locked.
    fn display_asleep(&self) -> bool {
        false
    }
}

/// Lock, sleep and user-switch check for capture, on both OSes. Deliberately redundant: the level
/// checks (lock screen up, session off console) are asked from the OS directly as well as through
/// `session_events`, so capture stays off in those states however activity tracking chooses to
/// classify them (a locked screen may count as idle time there; it is never captured).
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn session_capturable() -> bool {
    use crate::activity::platform::{on_console, screen_locked};
    crate::session_events::observable_now() && !crate::session_events::current().asleep && !screen_locked() && on_console()
}

/// What the employee is told when the local cap is reached. Space comes back when waiting
/// screenshots upload (their local copy is removed after the grace period) and when screenshots the
/// server did not accept are dismissed; those never upload, so say so when they hold space.
fn storage_full_reason(rejected: i64) -> String {
    let base = "Paused: local screenshot storage is full.";
    if rejected > 0 {
        format!("{base} {rejected} screenshot(s) the server did not accept are still kept on this computer and will never upload: dismiss them below to free space. The rest is freed as waiting screenshots upload.")
    } else {
        format!("{base} Capture resumes as waiting screenshots upload and their local copies are removed (24 hours after upload).")
    }
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
    /// No recent keyboard/mouse input (Collector::input_idle), refreshed before every tick. Screenshots are
    /// taken only while the employee is active: idle capture is off.
    pub idle: AtomicBool,
}

impl Shooter {
    pub fn new(dir: PathBuf, cap_bytes: i64) -> Shooter {
        Shooter {
            state: Mutex::new(State {
                mode: "STOPPED".into(),
                scope: None,
                cfg: Config::default(),
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
            idle: AtomicBool::new(false),
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
                    // No collector state yet = unknown = idle: never captured unobserved.
                    let idle = app.try_state::<Arc<crate::collector::Collector>>().is_none_or(|c| c.input_idle());
                    worker.idle.store(idle, Ordering::SeqCst);
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
        if os.display_asleep() {
            return skip("Not taken: the display was asleep.");
        }
        if self.idle.load(Ordering::SeqCst) {
            return skip("Not taken: no keyboard or mouse input (idle). Screenshots are taken only while you are active.");
        }
        let (used, rejected) = db.lock().ok().and_then(|c| Some((local_bytes(&c).ok()?, rejected_count(&c).ok()?))).unwrap_or((i64::MAX, 0));
        if used >= self.cap_bytes {
            return skip(&storage_full_reason(rejected));
        }
        if os.free_bytes(&self.dir).is_some_and(|free| free < MIN_FREE_DISK_BYTES) {
            return skip("Paused: less than 1 GB free disk space on this computer.");
        }

        let t0 = Instant::now();
        let result = os.capture(cfg.max_dimension).and_then(|mut frame| {
            let t1 = Instant::now();
            // Before anything is encoded or written: the masked and unblurred pixels exist only in this buffer.
            redact(&mut frame, &cfg);
            let webp = encode(&frame, cfg.quality)?;
            Ok((frame.width, frame.height, webp, t1 - t0, t1.elapsed()))
        });
        let Ok(mut st) = self.state.lock() else { return };
        let (width, height, webp, took, encode_took) = match result {
            Ok(r) => r,
            Err(e) => {
                // Not `error`: the UI stops capture on an error, and nothing would ever clear it.
                st.status.skipped = Some(format!("{CAPTURE_FAILED}{e}"));
                return;
            }
        };
        // Held state lock: a break/clock-out (configure) cannot slip in between this check and the save.
        if self.generation.load(Ordering::SeqCst) != generation || st.mode != "ACTIVE" || os.locked() || os.display_asleep() {
            st.status.skipped = Some("Not kept: capture was stopped, or the screen locked or went to sleep, while it was being taken.".into());
            return; // the frame is dropped; nothing was written
        }
        let saved = db.lock().map_err(|e| e.to_string()).and_then(|conn| save(&conn, &self.dir, &scope, wall, width, height, &webp, &cfg.masks, cfg.blur == Some(true)).map_err(|e| e.to_string()));
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
            Err(e) => st.status.skipped = Some(format!("{CAPTURE_FAILED}could not save the screenshot on this computer: {e}")),
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
        Some((st.cfg.clone(), st.scope.clone()?, self.generation.load(Ordering::SeqCst)))
    }

    /// Sets the mode decided by the UI. Any change of mode, scope or interval restarts the schedule.
    pub fn configure(&self, mode: String, scope: Option<Scope>, cfg: Config) -> ShotStatus {
        let Ok(mut st) = self.state.lock() else { return self.status() };
        if st.mode != mode || st.scope != scope || st.cfg != cfg {
            self.generation.fetch_add(1, Ordering::SeqCst);
            st.status.next_capture_ms = None;
        }
        let invalid = if !masks_valid(&cfg.masks) { Some(MASKS_INVALID) } else if cfg.blur.is_none() { Some(BLUR_INVALID) } else { None };
        st.mode = mode;
        st.scope = scope;
        st.cfg = cfg;
        st.status.mode = st.mode.clone();
        st.status.capturing = st.mode == "ACTIVE" && st.scope.is_some() && platform::SUPPORTED && invalid.is_none();
        if let Some(reason) = invalid {
            st.status.error = Some(reason.into());
        } else if matches!(st.status.error.as_deref(), Some(MASKS_INVALID | BLUR_INVALID)) {
            st.status.error = None;
        }
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

/// CPU downscale to `fit(.., max_dimension)` (never up) with a box filter: each output pixel is the
/// rounded mean of the source pixels its area covers. Used where the OS does not scale for us
/// (Windows GDI); on macOS ScreenCaptureKit scales during capture. Returns the frame untouched
/// when it already fits.
// ponytail: span edges are rounded outwards (a source pixel on a fractional boundary counts for
// both neighbours, a slight extra softening); exact area weights if image quality ever matters.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn downscale(frame: Frame, max_dimension: u32) -> Result<Frame, String> {
    let (sw, sh) = (frame.width as usize, frame.height as usize);
    if sw == 0 || sh == 0 || frame.rgb.len() != sw * sh * 3 {
        return Err("invalid frame size".into());
    }
    let (w, h) = fit(frame.width, frame.height, max_dimension);
    if (w, h) == (frame.width, frame.height) {
        return Ok(frame);
    }
    let (dw, dh) = (w as usize, h as usize);
    // Source range [a, b) covered by output index i of d, from s source pixels (s > d here, so b > a).
    let span = |i: usize, d: usize, s: usize| (i * s / d, ((i + 1) * s).div_ceil(d).min(s));
    let cols: Vec<(usize, usize)> = (0..dw).map(|x| span(x, dw, sw)).collect();
    let stride = sw * 3;
    let mut sums = vec![0u32; stride]; // per source column: sum over the current band of rows
    let mut rgb = Vec::with_capacity(dw * dh * 3);
    for y in 0..dh {
        let (y0, y1) = span(y, dh, sh);
        sums.fill(0);
        for row in frame.rgb[y0 * stride..y1 * stride].chunks_exact(stride) {
            for (s, &v) in sums.iter_mut().zip(row) {
                *s += u32::from(v);
            }
        }
        for &(x0, x1) in &cols {
            let n = ((x1 - x0) * (y1 - y0)) as u64;
            for c in 0..3 {
                let total: u64 = sums[x0 * 3 + c..x1 * 3].iter().step_by(3).map(|&v| u64::from(v)).sum();
                rgb.push(((total + n / 2) / n) as u8);
            }
        }
    }
    Ok(Frame { width: w, height: h, rgb })
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
    /// Masks applied to this image at capture time (what the server checks).
    pub masks: Vec<Mask>,
    /// Whether the whole image was blurred before encoding (the server checks it against its policy).
    pub blurred: bool,
}

const ROW_COLUMNS: &str = "id, session_id, captured_ms, width, height, size_bytes, checksum, status, retries, last_error, masks, blurred";

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
        // We write this JSON; were it ever unreadable, [] only passes the server check while no
        // masks are required, and the image itself is unchanged either way.
        masks: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        blurred: r.get::<_, i64>(11)? != 0,
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
#[allow(clippy::too_many_arguments)]
pub fn save(conn: &Connection, dir: &Path, scope: &Scope, captured_ms: i64, width: u32, height: u32, webp: &[u8], masks: &[Mask], blurred: bool) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let masks = serde_json::to_string(masks).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO screenshots (id, user_id, device_id, session_id, captured_ms, width, height, size_bytes, checksum, status, masks, blurred)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'SAVING', ?10, ?11)",
        params![id, scope.user_id, scope.device_id, scope.session_id, captured_ms, width, height, webp.len() as i64, sha256_hex(webp), masks, blurred],
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
        // Directory fsync makes the rename durable on unix. Windows cannot open a directory with
        // File::open (access denied without FILE_FLAG_BACKUP_SEMANTICS) nor flush it; NTFS journals
        // the rename itself.
        #[cfg(unix)]
        std::fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        // Never saved: remove the partial file (or the renamed one, if only the directory fsync
        // failed) and its row: no screenshot content is left behind without a row to account for it.
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(file(dir, &id));
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
    let mut removed = 0;
    for id in &ids {
        // File first, then the row: an interrupted cleanup leaves a row to retry, never an orphan file.
        match std::fs::remove_file(file(dir, id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        removed += conn.execute("DELETE FROM screenshots WHERE id = ?1 AND status = 'STORED'", params![id])?;
    }
    Ok(removed)
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

/// Screenshots the server refused, kept until the employee dismisses them (all users, like the cap).
fn rejected_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT count(*) FROM screenshots WHERE status = 'REJECTED'", [], |r| r.get(0))
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

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            // boolean_t. A level read from the window server: no permission, no notification to miss.
            fn CGDisplayIsAsleep(display: u32) -> i32;
        }

        /// Whether the user granted Screen Recording to this app. Never prompts.
        pub fn permission() -> bool {
            CGPreflightScreenCaptureAccess()
        }

        /// Shows the macOS permission prompt (first time only; afterwards the user changes it in
        /// System Settings › Privacy & Security › Screen & System Audio Recording). Not bypassable.
        ///
        /// macOS prompts once per app identity. When it does not grant (declined earlier, or a grant
        /// left over from another build: an unsigned build's grant is tied to that exact binary), the
        /// Screen Recording pane is opened so the click always leads somewhere.
        pub fn request_permission() -> bool {
            let granted = CGRequestScreenCaptureAccess();
            if !granted {
                let _ = std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").spawn();
            }
            granted
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
            // Runs inside the completion handler: a panic here would abort the app (panic = abort).
            if w == 0 || h == 0 || stride < w * 4 {
                return Err("unexpected image size".into());
            }
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

            /// Screen locked, Mac going to sleep, or another user's session in front (fast user
            /// switching, logout): session_events state plus the CGSession dictionary.
            fn locked(&self) -> bool {
                !super::super::session_capturable()
            }

            fn free_bytes(&self, dir: &Path) -> Option<u64> {
                let path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()).ok()?;
                let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
                (unsafe { libc::statvfs(path.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize)
            }

            /// Display sleep without a lock (no "require password", or inside its delay) would
            /// otherwise capture a dark screen, or the desktop of an employee who has walked away.
            fn display_asleep(&self) -> bool {
                unsafe { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }
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

    /// Windows: GDI capture of the primary monitor (`win::capture`), scaled on the CPU, then the
    /// shared masks → blur → masks → WebP pipeline in `Shooter::tick`.
    #[cfg(windows)]
    mod imp {
        use super::super::{downscale, Frame, Os};
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;

        pub const SUPPORTED: bool = true;

        /// Windows does not ask for screen-capture permission: always granted. The in-app notice
        /// and the always-visible capture state are the employee's disclosure.
        pub fn permission() -> bool {
            true
        }

        /// Nothing to request on Windows.
        pub fn request_permission() -> bool {
            true
        }

        pub struct Native;

        impl Os for Native {
            fn permission(&self) -> bool {
                permission()
            }

            /// Locked or secure desktop (UAC, Ctrl+Alt+Del), sleep, or this session not on the
            /// console: the same session_events rule as macOS.
            fn locked(&self) -> bool {
                !super::super::session_capturable()
            }

            /// Display off without a lock (console display state from `win::session`). Unknown
            /// (no notification received) counts as on, so it never stops capture by itself.
            fn display_asleep(&self) -> bool {
                crate::session_events::current().display_asleep
            }

            fn free_bytes(&self, dir: &Path) -> Option<u64> {
                use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
                let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
                let mut free = 0u64;
                // SAFETY: NUL-terminated path; the unused outputs may be null.
                (unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) } != 0).then_some(free)
            }

            /// The primary display only, without the cursor, scaled to `max_dimension`.
            fn capture(&self, max_dimension: u32) -> Result<Frame, String> {
                downscale(crate::win::capture::primary()?, max_dimension)
            }
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    mod imp {
        // No capture on this operating system: nothing is captured here.
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
        asleep: AtomicBool,
        fail: AtomicBool,
        captures: AtomicU64,
        free: u64,
        on_capture: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }
    impl FakeOs {
        fn new() -> FakeOs {
            FakeOs { permission: AtomicBool::new(true), locked: AtomicBool::new(false), asleep: AtomicBool::new(false), fail: AtomicBool::new(false), captures: AtomicU64::new(0), free: u64::MAX, on_capture: Mutex::new(None) }
        }
    }
    impl Os for FakeOs {
        fn permission(&self) -> bool {
            self.permission.load(Ordering::SeqCst)
        }
        fn locked(&self) -> bool {
            self.locked.load(Ordering::SeqCst)
        }
        fn display_asleep(&self) -> bool {
            self.asleep.load(Ordering::SeqCst)
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
    const CFG: Config = Config { interval_ms: 5 * MIN, quality: 70.0, max_dimension: 1920, masks: Vec::new(), blur: Some(false) };

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
        os.asleep.store(true, Ordering::SeqCst); // display asleep, screen not locked
        run(&s, &e, &os, 41 * MIN + 1000, 46 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "display asleep: not even attempted");
        assert_eq!(s.status().skipped.as_deref(), Some("Not taken: the display was asleep."));

        os.asleep.store(false, Ordering::SeqCst);
        os.fail.store(true, Ordering::SeqCst); // e.g. permission revoked between the check and the capture
        run(&s, &e, &os, 46 * MIN + 1000, 51 * MIN);
        let failed = s.status();
        assert!(failed.skipped.as_deref().is_some_and(|r| r.starts_with(CAPTURE_FAILED) && r.contains("declined")), "{:?}", failed.skipped);
        assert_eq!(failed.error, None, "a failed capture is not an error state: the UI would stop capture for good");
        assert!(failed.capturing && failed.next_capture_ms.is_some(), "the schedule goes on");
        assert!(e.rows().is_empty(), "nothing saved for a failed capture");
        // Not latched: the next interval tries again and, once the cause is gone, saves and clears it.
        run(&s, &e, &os, 51 * MIN + 1000, 56 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 2, "tried again while still failing");
        os.fail.store(false, Ordering::SeqCst);
        run(&s, &e, &os, 56 * MIN + 1000, 61 * MIN);
        assert_eq!((e.rows().len(), s.status().skipped, s.status().error), (1, None, None), "recovered without a restart");

        s.configure("STOPPED".into(), None, CFG);
        run(&s, &e, &os, 61 * MIN + 1000, 90 * MIN);
        assert_eq!(e.rows().len(), 1, "clocked out: nothing more");
    }

    #[test]
    fn idle_is_never_captured_and_input_resumes_capture() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        s.idle.store(true, Ordering::SeqCst);
        run(&s, &e, &os, 0, 30 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "idle: not even attempted");
        assert!(s.status().skipped.is_some_and(|r| r.starts_with("Not taken: no keyboard or mouse input")));
        assert!(s.status().capturing, "the schedule goes on; only the due capture is skipped");
        s.idle.store(false, Ordering::SeqCst); // input again
        run(&s, &e, &os, 30 * MIN + 1000, 36 * MIN);
        assert_eq!((os.captures.load(Ordering::SeqCst), e.rows().len()), (1, 1), "active again: captured");
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

        os.locked.store(false, Ordering::SeqCst);
        let flag = os.clone();
        *os.on_capture.lock().unwrap() = Some(Box::new(move || flag.asleep.store(true, Ordering::SeqCst)));
        run(&s, &e, &os, 10 * MIN + 2000, 15 * MIN + 2000);
        assert_eq!(os.captures.load(Ordering::SeqCst), 3);
        assert!(e.rows().is_empty(), "display went to sleep during the capture: dropped");
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
        let full = s.status().skipped.unwrap();
        assert!(full.contains("storage is full") && full.contains("as waiting screenshots upload") && !full.contains("dismiss"), "{full}");
        assert_eq!(e.rows()[0].status, "PENDING", "the unsynced screenshot is kept");
        // Held by a screenshot the server refused: uploading will never free it, and the message says so.
        let id = e.rows()[0].id.clone();
        mark(&e.db.lock().unwrap(), &id, "REJECTED", Some("Captured outside clocked-in time"), 0).unwrap();
        run(&s, &e, &os, 15 * MIN + 1000, 21 * MIN);
        let full = s.status().skipped.unwrap();
        assert!(full.contains("storage is full") && full.contains("1 screenshot(s) the server did not accept") && full.contains("dismiss them"), "{full}");
        assert_eq!(e.rows().len(), 1, "still nothing deleted to make room");

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
            (save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp, &[], false).unwrap(), save(&conn, &e.dir, &scope(), 2_000, 64, 40, &webp, &[], false).unwrap(), save(&conn, &e.dir, &scope(), 3_000, 64, 40, &webp, &[], false).unwrap())
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
        let ok = save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp, &[], false).unwrap();
        let renamed = save(&conn, &e.dir, &scope(), 2_000, 64, 40, &webp, &[], false).unwrap();
        let lost = save(&conn, &e.dir, &scope(), 3_000, 64, 40, &webp, &[], false).unwrap();
        let damaged = save(&conn, &e.dir, &scope(), 4_000, 64, 40, &webp, &[], false).unwrap();
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

    #[test]
    fn downscale_averages_boxes_keeps_flat_colour_and_refuses_bad_buffers() {
        let f = Frame { width: 4, height: 2, rgb: vec![0, 0, 0, 10, 20, 30, 100, 100, 100, 200, 200, 200, 2, 0, 0, 10, 20, 30, 100, 100, 100, 201, 200, 200] };
        let out = downscale(f, 2).unwrap();
        assert_eq!((out.width, out.height), (2, 1));
        assert_eq!(out.rgb, [6, 10, 15, 150, 150, 150], "rounded means of each 2x2 box");

        let out = downscale(solid(2880, 1800, 77), 1920).unwrap();
        assert_eq!((out.width, out.height), (1920, 1200), "same size as fit()");
        assert!(out.rgb.iter().all(|&v| v == 77), "fractional ratio: flat colour stays exact");
        let out = downscale(solid(1001, 7, 9), 333).unwrap();
        assert_eq!((out.width, out.height, out.rgb.len()), (333, 2, 333 * 2 * 3), "odd sizes");

        let small = screen(1280, 800);
        let copy = small.rgb.clone();
        assert_eq!(downscale(small, 1920).unwrap().rgb, copy, "never upscaled or altered when it fits");
        assert!(downscale(Frame { width: 10, height: 10, rgb: vec![0; 10] }, 5).is_err(), "short buffer refused, not a crash");
        assert!(downscale(Frame { width: 0, height: 10, rgb: Vec::new() }, 5).is_err());
    }

    // ---- Privacy masks (F02) ---------------------------------------------------------------

    fn solid(w: u32, h: u32, v: u8) -> Frame {
        Frame { width: w, height: h, rgb: vec![v; (w * h * 3) as usize] }
    }
    fn px(f: &Frame, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * f.width + x) * 3) as usize;
        [f.rgb[i], f.rgb[i + 1], f.rgb[i + 2]]
    }
    /// Pixels set to 0 as (min_x, min_y, max_x, max_y, count).
    fn black_box(f: &Frame) -> Option<(u32, u32, u32, u32, usize)> {
        let mut b: Option<(u32, u32, u32, u32, usize)> = None;
        for y in 0..f.height {
            for x in 0..f.width {
                if px(f, x, y) == [0, 0, 0] {
                    let e = b.get_or_insert((x, y, x, y, 0));
                    *e = (e.0.min(x), e.1.min(y), e.2.max(x), e.3.max(y), e.4 + 1);
                }
            }
        }
        b
    }
    const M: fn(u16, u16, u16, u16) -> Mask = |x, y, w, h| Mask { x, y, w, h };

    #[test]
    fn masks_cover_the_same_share_at_every_resolution_rounded_outwards() {
        // Left quarter, top tenth: exact at 1920x1080.
        let mut f = solid(1920, 1080, 200);
        apply_masks(&mut f, &[M(0, 0, 2500, 1000)]);
        assert_eq!(black_box(&f), Some((0, 0, 479, 107, 480 * 108)), "x 0..480, y 0..108 exactly");

        // The same mask on a scaled-down 1366x768 frame: 341.5 -> 342 px wide, 76.8 -> 77 px high (outwards).
        let mut f = solid(1366, 768, 200);
        apply_masks(&mut f, &[M(0, 0, 2500, 1000)]);
        assert_eq!(black_box(&f), Some((0, 0, 341, 76, 342 * 77)));

        // Fractional start is rounded down, fractional end up: never a sliver left uncovered.
        let mut f = solid(1000, 1000, 200);
        apply_masks(&mut f, &[M(3333, 3333, 3334, 3334)]); // 333.3 .. 666.7
        assert_eq!(black_box(&f), Some((333, 333, 666, 666, 334 * 334)));

        // Touching the right and bottom edges, and the whole frame.
        let mut f = solid(1920, 1200, 200);
        apply_masks(&mut f, &[M(9000, 9500, 1000, 500)]);
        assert_eq!(black_box(&f), Some((1728, 1140, 1919, 1199, 192 * 60)));
        let mut f = solid(640, 400, 200);
        apply_masks(&mut f, &[M(0, 0, 10_000, 10_000)]);
        assert_eq!(black_box(&f).map(|b| b.4), Some(640 * 400));

        // A tiny mask still covers at least one pixel.
        let mut f = solid(640, 400, 200);
        apply_masks(&mut f, &[M(5000, 5000, 1, 1)]);
        assert_eq!(black_box(&f), Some((320, 200, 320, 200, 1)));
    }

    #[test]
    fn several_masks_overlapping_or_not_and_nothing_outside_them_changes() {
        let mut f = screen(800, 500);
        let before = f.rgb.clone();
        let masks = [M(0, 0, 1000, 1000), M(500, 500, 1000, 1000), M(8000, 0, 2000, 2000)];
        apply_masks(&mut f, &masks);
        let inside = |x: u32, y: u32| (x < 80 && y < 50) || ((40..120).contains(&x) && (25..75).contains(&y)) || (x >= 640 && y < 100);
        for y in 0..500 {
            for x in 0..800 {
                let i = ((y * 800 + x) * 3) as usize;
                if inside(x, y) {
                    assert_eq!(px(&f, x, y), [0, 0, 0], "masked at {x},{y}");
                } else {
                    assert_eq!(&f.rgb[i..i + 3], &before[i..i + 3], "untouched at {x},{y}");
                }
            }
        }
        let mut g = screen(800, 500);
        apply_masks(&mut g, &[]);
        assert_eq!(g.rgb, before, "no masks: the frame is unchanged");
        let mut bad = Frame { width: 10, height: 10, rgb: vec![9; 12] };
        apply_masks(&mut bad, &masks);
        assert_eq!(bad.rgb, vec![9; 12], "a malformed frame is left for encode() to reject, never indexed out of bounds");
    }

    #[test]
    fn mask_validation_matches_the_server_rules() {
        assert!(masks_valid(&[]));
        assert!(masks_valid(&[M(0, 0, 10_000, 10_000), M(9999, 9999, 1, 1)]));
        for bad in [M(0, 0, 0, 10), M(0, 0, 10, 0), M(1, 0, 10_000, 10), M(0, 9_001, 10, 1000), M(10_000, 0, 1, 1), M(u16::MAX, 0, 1, 1)] {
            assert!(!masks_valid(&[bad]), "{bad:?}");
        }
        assert!(masks_valid(&[M(0, 0, 1, 1); MASK_MAX]));
        assert!(!masks_valid(&[M(0, 0, 1, 1); MASK_MAX + 1]));
    }

    #[test]
    fn captures_are_masked_before_encoding_and_record_their_masks() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        let masks = vec![M(0, 0, 5000, 2000), M(7500, 7500, 2500, 2500)];
        s.configure("ACTIVE".into(), Some(scope()), Config { masks: masks.clone(), ..CFG });
        run(&s, &e, &os, 0, 5 * MIN);
        let rows = e.rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].masks, masks, "the masks applied travel with the screenshot to the server");

        // Real WebP round trip of the file on disk (what is uploaded): masked areas are black,
        // the rest still shows the synthetic screen.
        let bytes = read(&e.db.lock().unwrap(), &e.dir, &rows[0].id).unwrap();
        let img = webp::Decoder::new(&bytes).decode().unwrap();
        let (w, h) = (img.width(), img.height());
        assert_eq!((w, h), (1920, 1200));
        let rgba = img.is_alpha();
        let ch = if rgba { 4 } else { 3 };
        let at = |x: u32, y: u32| -> [u8; 3] {
            let i = ((y * w + x) as usize) * ch;
            [img[i], img[i + 1], img[i + 2]]
        };
        let max_in = |x0: u32, y0: u32, x1: u32, y1: u32| (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| *at(x, y).iter().max().unwrap()).max().unwrap();
        // Inside, away from block edges where lossy coding may bleed a little.
        assert!(max_in(8, 8, 952, 232) <= 12, "top-left mask is black in the stored file");
        assert!(max_in(1448, 908, 1912, 1192) <= 12, "bottom-right mask is black in the stored file");
        let reference = screen(1920, 1200);
        let bright = (1000..1400).flat_map(|x| (400..700).map(move |y| (x, y))).filter(|&(x, y)| at(x, y)[2] > 200 && px(&reference, x, y)[2] > 200).count();
        assert!(bright > 50_000, "the unmasked part still shows the screen ({bright} bright pixels)");

        // A later capture under different masks starts a new schedule; old rows keep what they had.
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 5 * MIN + 1000, 10 * MIN + 1000);
        let rows = e.rows();
        assert_eq!(rows.iter().map(|r| r.masks.len()).collect::<Vec<_>>(), [2, 0]);
    }

    #[test]
    fn invalid_masks_pause_capture_instead_of_capturing_unmasked() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        let st = s.configure("ACTIVE".into(), Some(scope()), Config { masks: vec![M(9000, 0, 2000, 10)], ..CFG });
        assert!(!st.capturing);
        assert_eq!(st.error.as_deref(), Some(MASKS_INVALID));
        run(&s, &e, &os, 0, 15 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 0, "nothing captured");
        let st = s.configure("ACTIVE".into(), Some(scope()), Config { masks: vec![M(0, 0, 10, 10)], ..CFG });
        assert!(st.capturing && st.error.is_none(), "valid masks resume capture and clear the message");
    }

    // ---- Whole-image blur -------------------------------------------------------------------

    /// Sum of absolute horizontal and vertical neighbour differences: high for sharp text.
    fn edge_energy(f: &Frame) -> u64 {
        let (w, h) = (f.width as usize, f.height as usize);
        let mut e = 0u64;
        for y in 0..h - 1 {
            for x in 0..w - 1 {
                for c in 0..3 {
                    let v = i64::from(f.rgb[(y * w + x) * 3 + c]);
                    e += (v - i64::from(f.rgb[(y * w + x + 1) * 3 + c])).unsigned_abs() + (v - i64::from(f.rgb[((y + 1) * w + x) * 3 + c])).unsigned_abs();
                }
            }
        }
        e
    }
    const BLUR: Config = Config { interval_ms: 5 * MIN, quality: 70.0, max_dimension: 1920, masks: Vec::new(), blur: Some(true) };

    #[test]
    fn blur_destroys_text_like_detail_everywhere() {
        assert_eq!((blur_radius(640, 400), blur_radius(1920, 1080), blur_radius(3840, 2160), blur_radius(1080, 1920)), (8, 16, 32, 16));
        let mut f = screen(1920, 1200);
        let before = f.rgb.clone();
        let sharp = edge_energy(&f);
        apply_blur(&mut f);
        let soft = edge_energy(&f);
        assert!(soft * 25 < sharp, "edge energy {soft} must fall below 4% of the original {sharp}");
        // Every 16x16 neighbourhood changed: no block of the original survives verbatim.
        for by in (0..1200).step_by(16) {
            for bx in (0..1920).step_by(16) {
                let changed = (by..by + 16).any(|y| (bx..bx + 16).any(|x| {
                    let i = (y * 1920 + x) * 3;
                    f.rgb[i..i + 3] != before[i..i + 3]
                }));
                assert!(changed, "block at {bx},{by} unchanged");
            }
        }
        // Locally, the text strokes are gone: within a 40x40 window the luminance spread is small (what remains is page layout, not strokes).
        let lum = |x: usize, y: usize| i32::from(f.rgb[(y * 1920 + x) * 3]);
        for (x0, y0) in [(100, 100), (900, 600), (1500, 1000)] {
            let vals: Vec<i32> = (y0..y0 + 40).flat_map(|y| (x0..x0 + 40).map(move |x| (x, y))).map(|(x, y)| lum(x, y)).collect();
            let spread = vals.iter().max().unwrap() - vals.iter().min().unwrap();
            assert!(spread < 60, "window at {x0},{y0}: spread {spread} (sharp text is ~200)");
        }
        // Uniform frame: unchanged (averaging only), and malformed frames are left alone.
        let mut flat = solid(300, 200, 123);
        apply_blur(&mut flat);
        assert!(flat.rgb.iter().all(|&v| v == 123));
        let mut bad = Frame { width: 10, height: 10, rgb: vec![9; 12] };
        apply_blur(&mut bad);
        assert_eq!(bad.rgb, vec![9; 12]);
        let mut tiny = solid(1, 1, 50);
        apply_blur(&mut tiny);
        assert_eq!(tiny.rgb, vec![50; 3], "frames smaller than the radius are fine");
    }

    #[test]
    fn masks_are_applied_before_the_blur_and_stay_black() {
        let masks = vec![M(0, 0, 5000, 2000), M(7500, 7500, 2500, 2500)];
        let mut f = screen(1920, 1200);
        redact(&mut f, &Config { masks: masks.clone(), ..BLUR });
        let mut only_masks = solid(1920, 1200, 200);
        apply_masks(&mut only_masks, &masks);
        let mut masked = 0;
        for y in 0..1200 {
            for x in 0..1920 {
                if px(&only_masks, x, y) == [0, 0, 0] {
                    masked += 1;
                    assert_eq!(px(&f, x, y), [0, 0, 0], "masked pixel {x},{y} is solid black after the blur");
                }
            }
        }
        assert_eq!(masked, 960 * 240 + 480 * 300);
        // The rest is blurred, and darkened next to the masks (the black was blurred, not the hidden content).
        assert!(edge_energy(&f) * 20 < edge_energy(&screen(1920, 1200)));
    }

    #[test]
    fn blurred_frames_encode_and_decode_and_blur_off_changes_nothing() {
        let mut f = screen(1920, 1200);
        redact(&mut f, &BLUR);
        let webp = encode(&f, 70.0).unwrap();
        let img = webp::Decoder::new(&webp).decode().unwrap();
        assert_eq!((img.width(), img.height()), (1920, 1200));
        let sharp = encode(&screen(1920, 1200), 70.0).unwrap();
        assert!(webp.len() < sharp.len(), "blurred {} bytes < sharp {} bytes", webp.len(), sharp.len());

        // Off: exactly the masks-only pipeline, same encoded bytes as before blur existed.
        let masks = vec![M(0, 0, 2500, 1000)];
        let mut off = screen(1920, 1200);
        redact(&mut off, &Config { masks: masks.clone(), ..CFG });
        let mut legacy = screen(1920, 1200);
        apply_masks(&mut legacy, &masks);
        assert_eq!(off.rgb, legacy.rgb);
        assert_eq!(encode(&off, 70.0).unwrap(), encode(&legacy, 70.0).unwrap());
        let mut invalid = screen(64, 40);
        redact(&mut invalid, &Config { blur: None, ..CFG });
        assert_eq!(invalid.rgb, screen(64, 40).rgb, "never reached: configure pauses capture first");
    }

    #[test]
    fn blurred_captures_are_saved_blurred_and_recorded_and_invalid_blur_pauses() {
        let e = Env::new();
        let os = FakeOs::new();
        let s = Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), BLUR);
        run(&s, &e, &os, 0, 5 * MIN);
        let rows = e.rows();
        assert_eq!(rows.iter().map(|r| r.blurred).collect::<Vec<_>>(), [true]);
        // The file on disk (what is uploaded) is the blurred image.
        let bytes = read(&e.db.lock().unwrap(), &e.dir, &rows[0].id).unwrap();
        let img = webp::Decoder::new(&bytes).decode().unwrap();
        let rgb: Vec<u8> = if img.is_alpha() { img.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect() } else { img.to_vec() };
        let stored = Frame { width: img.width(), height: img.height(), rgb };
        assert!(edge_energy(&stored) * 20 < edge_energy(&screen(1920, 1200)), "no sharp version is written");
        assert!(!std::fs::read_dir(&e.dir).unwrap().any(|f| f.unwrap().file_name().to_string_lossy().ends_with(".tmp")));

        // Unreadable setting: paused with a reason, nothing captured; a valid one resumes.
        let st = s.configure("ACTIVE".into(), Some(scope()), Config { blur: None, ..BLUR });
        assert!(!st.capturing);
        assert_eq!(st.error.as_deref(), Some(BLUR_INVALID));
        run(&s, &e, &os, 5 * MIN + 1000, 20 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 1, "nothing captured while the blur setting is unreadable");
        let st = s.configure("ACTIVE".into(), Some(scope()), CFG);
        assert!(st.capturing && st.error.is_none());
        run(&s, &e, &os, 20 * MIN + 1000, 25 * MIN + 1000);
        assert_eq!(e.rows().iter().map(|r| r.blurred).collect::<Vec<_>>(), [true, false]);
    }

    #[test]
    fn a_blur_change_during_a_capture_discards_it() {
        let e = Env::new();
        let os = Arc::new(FakeOs::new());
        let s = Arc::new(Shooter::new(e.dir.clone(), LOCAL_CAP_BYTES));
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        let shooter = s.clone();
        *os.on_capture.lock().unwrap() = Some(Box::new(move || {
            shooter.configure("ACTIVE".into(), Some(scope()), BLUR); // blur turned on mid-capture
        }));
        run(&s, &e, &os, 0, 5 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 1);
        assert!(e.rows().is_empty(), "captured under the old (unblurred) setting: dropped, nothing written");
        assert!(s.status().skipped.unwrap().contains("Not kept"));
    }

    #[test]
    fn a_failed_write_keeps_nothing_partial_and_leaves_the_queue_intact() {
        let e = Env::new();
        let webp = encode(&screen(64, 40), 70.0).unwrap();
        let conn = e.db.lock().unwrap();
        let kept = save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp, &[], false).unwrap();
        // The folder is gone (or the disk refuses the write): the save fails cleanly.
        let gone = e.dir.join("missing");
        assert!(save(&conn, &gone, &scope(), 2_000, 64, 40, &webp, &[], true).is_err());
        drop(conn);
        assert_eq!(e.rows().iter().map(|r| (r.id.as_str(), r.status.as_str())).collect::<Vec<_>>(), [(kept.as_str(), "PENDING")], "no SAVING row left, earlier screenshot untouched");
        // Through the worker: an error is shown, capture is not marked done, and it retries next interval.
        let os = FakeOs::new();
        let s = Shooter::new(gone, LOCAL_CAP_BYTES);
        s.configure("ACTIVE".into(), Some(scope()), CFG);
        run(&s, &e, &os, 0, 10 * MIN);
        assert_eq!(os.captures.load(Ordering::SeqCst), 2, "tried again at the next interval");
        let st = s.status();
        assert!(st.skipped.as_deref().is_some_and(|r| r.starts_with(CAPTURE_FAILED) && r.contains("could not save the screenshot on this computer")), "{:?}", st.skipped);
        assert_eq!(st.error, None, "not latched as an error");
        assert!(s.status().last_capture.is_none());
        assert_eq!(e.rows().len(), 1);
    }

    #[test]
    fn retry_after_a_terminal_state_never_resurrects_a_row_and_cleanup_counts_real_removals() {
        let e = Env::new();
        let webp = encode(&screen(64, 40), 70.0).unwrap();
        let conn = e.db.lock().unwrap();
        let a = save(&conn, &e.dir, &scope(), 1_000, 64, 40, &webp, &[], false).unwrap();
        mark(&conn, &a, "STORED", None, 0).unwrap();
        mark(&conn, &a, "RETRY", Some("late failure report"), 0).unwrap();
        mark(&conn, &a, "REJECTED", Some("late"), 0).unwrap();
        mark(&conn, &a, "REGISTERED", None, 0).unwrap();
        assert!(next_upload(&conn, "u1", "d1", i64::MAX).unwrap().is_none(), "a stored screenshot is never uploaded twice");
        assert!(mark(&conn, &a, "BOGUS", None, 0).is_err());
        // A STORED row whose file was already removed (interrupted cleanup) is still cleaned up.
        std::fs::remove_file(file(&e.dir, &a)).unwrap();
        assert_eq!(cleanup_stored(&conn, &e.dir, 2 * STORED_GRACE_MS).unwrap(), 1);
        assert_eq!(cleanup_stored(&conn, &e.dir, 2 * STORED_GRACE_MS).unwrap(), 0, "idempotent");
    }

    /// Blur + WebP encode cost on synthetic frames (no screen capture). Numbers are printed; run
    /// `cargo test --release blur_benchmark -- --nocapture` for release timings.
    #[test]
    fn blur_benchmark() {
        for (w, h) in [(1920u32, 1080u32), (3840, 2160)] {
            let mut f = screen(w, h);
            let t = Instant::now();
            apply_blur(&mut f);
            let blur = t.elapsed();
            let t = Instant::now();
            let webp = encode(&f, 70.0).unwrap();
            let enc = t.elapsed();
            let frame_mb = f.rgb.len() as f64 / 1_048_576.0;
            let extra_kb = ((blur_radius(w, h) + 2) * w as usize * 3 + w as usize * 8) / 1024;
            eprintln!(
                "[bench] {w}x{h} blur r={} {} ms, encode q70 (incl. validation decode) {} ms, {} KB; frame {frame_mb:.1} MB, blur scratch {extra_kb} KB ({})",
                blur_radius(w, h),
                blur.as_millis(),
                enc.as_millis(),
                webp.len() / 1024,
                if cfg!(debug_assertions) { "debug" } else { "release" }
            );
        }
    }

    #[test]
    fn queues_from_before_blur_keep_their_rows_and_report_unblurred() {
        let dir = std::env::temp_dir().join(format!("wf-shots-old-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE screenshots (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                   session_id TEXT NOT NULL, captured_ms INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                   size_bytes INTEGER NOT NULL CHECK (size_bytes > 0), checksum TEXT NOT NULL,
                   status TEXT NOT NULL CHECK (status IN ('SAVING', 'PENDING', 'REGISTERED', 'STORED', 'FAILED', 'REJECTED')),
                   retries INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, stored_ms INTEGER,
                   masks TEXT NOT NULL DEFAULT '[]') STRICT;
                 INSERT INTO screenshots (id, user_id, device_id, session_id, captured_ms, width, height, size_bytes, checksum, status, retries, masks)
                   VALUES ('p', 'u1', 'd1', 's1', 1000, 64, 40, 10, 'x', 'PENDING', 2, '[{\"x\":0,\"y\":0,\"w\":10,\"h\":10}]'),
                          ('r', 'u1', 'd1', 's1', 2000, 64, 40, 10, 'y', 'REGISTERED', 0, '[]'),
                          ('s', 'u1', 'd1', 's1', 3000, 64, 40, 10, 'z', 'STORED', 0, '[]');",
            )
            .unwrap();
        }
        let c = crate::queue::open(&path).unwrap();
        drop(crate::queue::open(&path).unwrap()); // reopening does not add it twice
        let rows: Vec<ShotRow> = c.prepare(&format!("SELECT {ROW_COLUMNS} FROM screenshots ORDER BY seq")).unwrap().query_map([], row).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(
            rows.iter().map(|r| (r.id.as_str(), r.status.as_str(), r.retries, r.masks.len(), r.blurred)).collect::<Vec<_>>(),
            [("p", "PENDING", 2, 1, false), ("r", "REGISTERED", 0, 0, false), ("s", "STORED", 0, 0, false)],
            "every queued row survives the upgrade, unblurred"
        );
        assert!(c.execute("UPDATE screenshots SET blurred = 2 WHERE id = 'p'", []).is_err(), "only 0 or 1");
        drop(c);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn queues_from_before_masks_gain_the_column_and_report_none() {
        let dir = std::env::temp_dir().join(format!("wf-shots-old-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("queue.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE screenshots (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                   session_id TEXT NOT NULL, captured_ms INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                   size_bytes INTEGER NOT NULL CHECK (size_bytes > 0), checksum TEXT NOT NULL,
                   status TEXT NOT NULL CHECK (status IN ('SAVING', 'PENDING', 'REGISTERED', 'STORED', 'FAILED', 'REJECTED')),
                   retries INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, stored_ms INTEGER) STRICT;
                 INSERT INTO screenshots (id, user_id, device_id, session_id, captured_ms, width, height, size_bytes, checksum, status)
                   VALUES ('old', 'u1', 'd1', 's1', 1000, 64, 40, 10, 'x', 'PENDING');",
            )
            .unwrap();
        }
        let c = crate::queue::open(&path).unwrap();
        let c2 = crate::queue::open(&path).unwrap(); // reopening does not add it twice
        drop(c2);
        let r = next_upload(&c, "u1", "d1", 2000).unwrap().unwrap();
        assert_eq!((r.id.as_str(), r.masks.len()), ("old", 0), "captured before masks existed: none applied");
        assert!(!r.blurred, "captured before blur existed: not blurred");
        drop(c);
        std::fs::remove_dir_all(&dir).ok();
    }
}
