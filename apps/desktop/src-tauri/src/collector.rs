//! The single activity-collection worker. The webview decides the monitoring mode from the
//! attendance state; this thread samples only while the mode is ACTIVE.

use crate::activity::{platform, App, Config, Kind, Sample, Tracker};
use crate::session_events::{self, SessionState, Transition};
use crate::{power, queue};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Screen lock by hand = break is a Windows feature (Win+L). On macOS a lock stays IDLE as it always was.
const LOCK_BREAKS: bool = cfg!(windows);

/// A lock counts as by hand only with keyboard/mouse input this recent (the lock shortcut, the menu, a
/// hot corner): a screen saver or display-sleep lock comes after inactivity and stays IDLE as before.
const MANUAL_LOCK_INPUT_MS: i64 = 30_000;
/// A lock this soon after a wake is the wake's lock screen (sleep handling), not a break.
const WAKE_LOCK_MS: i64 = 10_000;
/// A hand lock becomes a break only if the screen is still locked and the computer is not going to
/// sleep this long after it: closing the lid also locks, and a quick lock/unlock is not a break.
const LOCK_CONFIRM_MS: i64 = 2_000;

/// Sent to the webview (event `screen-lock`): a confirmed hand lock (`locked`, the break starts at
/// `at_ms`) or any unlock (the webview ends the break only if a lock opened it).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenLock {
    pub locked: bool,
    pub at_ms: i64,
}

/// Whether a lock at `at_ms` was made by hand while working: displays on, not going to sleep, this
/// user's session in front, not just woken, not already idle, and recent input.
fn manual_lock(session: &SessionState, idle_ms: i64, tracker_idle: bool, last_wake_ms: Option<i64>, at_ms: i64) -> bool {
    !session.asleep
        && !session.display_asleep
        && !session.session_inactive
        && !tracker_idle
        && (0..MANUAL_LOCK_INPUT_MS).contains(&idle_ms)
        && !last_wake_ms.is_some_and(|w| at_ms - w < WAKE_LOCK_MS)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStatus {
    /// Whether this platform has a collector (macOS yes; Windows pending).
    pub supported: bool,
    /// Last mode set by the UI (ACTIVE, STOPPED, PAUSED_BREAK, …).
    pub mode: String,
    pub collecting: bool,
    pub current_app: Option<App>,
    pub idle: bool,
    pub locked: bool,
    /// The Mac is going to sleep (shown only until wake; nothing is recorded meanwhile).
    pub asleep: bool,
    /// Another user's session is in front, or this user is logging out: nothing is recorded.
    pub session_inactive: bool,
    /// Seconds since the last keyboard/mouse input at the last sample (a counter only).
    pub idle_seconds: Option<i64>,
    /// The policy in force (from the server via `activity_configure`).
    pub idle_threshold_seconds: i64,
    pub sample_seconds: i64,
    /// App Nap is turned off for this app while monitoring is on (see power.rs).
    pub app_nap_prevented: bool,
    pub error: Option<String>,
    pub last_sample_ms: Option<i64>,
    /// Start of the current idle interval (idle is attributed from the last input).
    pub idle_since_ms: Option<i64>,
    /// Latest unobserved stretch while monitoring (sleep, suspended app, clock change): [start, end] ms.
    pub last_gap_ms: Option<(i64, i64)>,
    /// Windows: a hand lock is a break (from the lock until unlock; set while it is being confirmed
    /// too). Nothing is attributed meanwhile. Always false on macOS.
    pub lock_break: bool,
}

impl CollectorStatus {
    fn new(mode: &str, error: Option<String>) -> CollectorStatus {
        let cfg = Config::new(15, 300);
        CollectorStatus {
            supported: platform::SUPPORTED,
            mode: mode.into(),
            collecting: false,
            current_app: None,
            idle: false,
            locked: false,
            asleep: false,
            session_inactive: false,
            idle_seconds: None,
            idle_threshold_seconds: cfg.idle_threshold_ms / 1000,
            sample_seconds: cfg.sample_ms / 1000,
            app_nap_prevented: false,
            error,
            last_sample_ms: None,
            idle_since_ms: None,
            last_gap_ms: None,
            lock_break: false,
        }
    }
}

struct State {
    mode: String,
    scope: Option<(String, String)>,
    tracker: Tracker,
    status: CollectorStatus,
    /// Lock time of a hand lock waiting for LOCK_CONFIRM_MS before it becomes a break.
    pending_lock: Option<i64>,
    /// Last wake (wall ms), so the lock screen at wake is not taken for a hand lock.
    last_wake_ms: Option<i64>,
}

pub struct Collector {
    state: Mutex<State>,
    started: Instant,
    /// Set by `configure` to take the first sample right away instead of one period later.
    wake: AtomicBool,
    /// Whether a hand lock is a break (LOCK_BREAKS; tests set it to cover the Windows behaviour anywhere).
    lock_breaks: bool,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Collector {
    fn new() -> Collector {
        Collector {
            state: Mutex::new(State {
                mode: "STOPPED".into(),
                scope: None,
                tracker: Tracker::new(Config::new(15, 300)),
                status: CollectorStatus::new("STOPPED", None),
                pending_lock: None,
                last_wake_ms: None,
            }),
            started: Instant::now(),
            wake: AtomicBool::new(false),
            lock_breaks: LOCK_BREAKS,
        }
    }

    /// Starts the one worker thread for the app's lifetime (no duplicate workers).
    pub fn spawn(app: AppHandle) -> Arc<Collector> {
        let collector = Arc::new(Collector::new());
        let worker = collector.clone();
        let transitions = session_events::subscribe();
        std::thread::Builder::new()
            .name("activity-collector".into())
            .spawn(move || {
                let mut last = Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    for t in transitions.try_iter() {
                        worker.on_transition(&app.state::<Mutex<Connection>>(), t, session_events::current(), platform::idle_ms());
                        if t.event == session_events::Event::Unlocked {
                            let _ = app.emit("screen-lock", ScreenLock { locked: false, at_ms: t.at_ms });
                        }
                    }
                    if let Some(at_ms) = worker.due_lock_break(now_ms(), session_events::current()) {
                        let _ = app.emit("screen-lock", ScreenLock { locked: true, at_ms });
                    }
                    let period = worker.lock_state().tracker.cfg.sample_ms;
                    if worker.wake.swap(false, Ordering::SeqCst) || last.elapsed() >= Duration::from_millis(period as u64) {
                        last = Instant::now();
                        worker.tick(&app.state::<Mutex<Connection>>());
                    }
                }
            })
            .expect("spawn activity collector");
        collector
    }

    /// The state, even after a panic poisoned its lock: the tracker starts afresh (its open interval
    /// ends at the last checkpoint, like after a crash) instead of recording nothing until restart.
    // Release builds abort on panic, so this matters for debug builds and tests only.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| {
            let mut st = poisoned.into_inner();
            st.tracker = Tracker::new(st.tracker.cfg.clone());
            self.state.clear_poison();
            st
        })
    }

    fn take_sample(&self) -> Sample {
        let (locked, away) = session_events::unobservable_now();
        Sample {
            wall_ms: now_ms(),
            mono_ms: self.started.elapsed().as_millis() as i64,
            app: platform::frontmost(),
            idle_ms: platform::idle_ms(),
            locked,
            away,
        }
    }

    /// A lock, sleep or session switch from the OS (session_events): attribution stops at the moment
    /// it happened, not at the next sample. Unlock, wake or the session coming back takes a sample
    /// right away (it is unobserved until the screen is actually unlocked and this session in front).
    ///
    /// A lock by hand while working (`manual_lock`) is a break, not idle: activity ends at the lock and
    /// nothing is attributed while locked; `due_lock_break` then tells the webview to start the break.
    fn on_transition(&self, db: &Mutex<Connection>, t: Transition, session: SessionState, idle_ms: i64) {
        use session_events::Event::*;
        let mut st = self.lock_state();
        st.status.locked = session.locked;
        st.status.asleep = session.asleep;
        st.status.session_inactive = session.session_inactive;
        match t.event {
            Unlocked => {
                st.pending_lock = None;
                if std::mem::take(&mut st.status.lock_break) {
                    // The locked stretch was a break, not an unobserved gap: nothing to explain.
                    st.tracker.last_gap = None;
                    st.status.last_gap_ms = None;
                }
            }
            WillSleep | SessionResigned => {
                // A lock still being confirmed was the sleep's or the switch's: not a break.
                if st.pending_lock.take().is_some() {
                    st.status.lock_break = false;
                }
            }
            DidWake => st.last_wake_ms = Some(t.at_ms),
            _ => {}
        }
        if st.mode != "ACTIVE" {
            return;
        }
        if !t.event.interrupts() {
            self.wake.store(true, Ordering::SeqCst);
            return;
        }
        // A hand lock is a break (unobserved here; attendance records it). Any other lock (after
        // inactivity, at wake) is idle from the lock as before; sleep and a session switch are
        // unobserved: everything closes and nothing stays open.
        let tracker_idle = st.tracker.open.as_ref().is_some_and(|o| o.kind == Kind::Idle);
        let closed = if t.event != Locked {
            st.tracker.interrupt(t.at_ms)
        } else if st.status.lock_break {
            Vec::new() // a repeated lock notification: the break is already under way
        } else if self.lock_breaks && manual_lock(&session, idle_ms, tracker_idle, st.last_wake_ms, t.at_ms) {
            st.pending_lock = Some(t.at_ms);
            st.status.lock_break = true;
            st.tracker.interrupt(t.at_ms)
        } else {
            st.tracker.lock(t.at_ms)
        };
        st.status.current_app = None;
        st.status.idle = st.tracker.open.as_ref().is_some_and(|o| o.kind == Kind::Idle);
        st.status.idle_since_ms = st.tracker.open.as_ref().filter(|o| o.kind == Kind::Idle).map(|o| o.start_ms);
        if let (Some((user, device)), Ok(conn)) = (st.scope.clone(), db.lock()) {
            let st = &mut *st;
            if let Err(e) = queue::activity_checkpoint(&conn, &user, &device, &closed, st.tracker.held.iter().chain(&st.tracker.open)) {
                st.status.error = Some(format!("Could not save activity locally: {e}"));
            }
        }
    }

    /// The lock time of a hand lock that has lasted LOCK_CONFIRM_MS while monitoring, still locked and
    /// awake: from now on it is a break (once; `None` otherwise). A lock cancelled by an unlock, sleep
    /// or the end of monitoring meanwhile is dropped.
    fn due_lock_break(&self, now_ms: i64, session: SessionState) -> Option<i64> {
        let mut st = self.lock_state();
        let at_ms = st.pending_lock.filter(|at| now_ms - at >= LOCK_CONFIRM_MS)?;
        st.pending_lock = None;
        if st.mode != "ACTIVE" || !session.locked || session.asleep || session.session_inactive {
            st.status.lock_break = false;
            return None;
        }
        Some(at_ms)
    }

    fn tick(&self, db: &Mutex<Connection>) {
        let mut st = self.lock_state();
        if st.mode != "ACTIVE" && st.status.error.is_some() {
            // The UI paused monitoring because of this error: clear it once the local queue is
            // writable and under the backlog limit again, so the UI can resume (no restart needed).
            if let Ok(conn) = db.lock()
                && queue::activity_backlog(&conn).is_ok_and(|n| n < queue::MAX_PENDING_ACTIVITY)
            {
                st.status.error = None;
            }
            return;
        }
        if st.mode != "ACTIVE" || !platform::SUPPORTED {
            return;
        }
        let Some((user, device)) = st.scope.clone() else { return };
        let session = session_events::current();
        if session.asleep {
            return; // between WillSleep and the actual sleep: nothing to observe
        }
        let mut sample = self.take_sample();
        if st.status.lock_break {
            // During a lock break nothing is attributed until the webview pauses monitoring: never IDLE.
            if sample.locked {
                sample.away = true;
            } else {
                st.status.lock_break = false; // unlocked without a notification
            }
        }
        st.status.locked = platform::screen_locked() || session.locked;
        st.status.session_inactive = !platform::on_console() || session.session_inactive;
        st.status.asleep = false;
        Self::record(&mut st, db, &user, &device, sample);
    }

    /// One sample into the tracker and the local queue (split from `tick` so tests feed samples).
    fn record(st: &mut State, db: &Mutex<Connection>, user: &str, device: &str, sample: Sample) {
        let closed = st.tracker.sample(&sample);
        let hidden = sample.locked || sample.away;
        st.status.current_app = if hidden { None } else { sample.app.clone() };
        st.status.idle_seconds = (sample.idle_ms >= 0 && !hidden).then_some(sample.idle_ms / 1000);
        st.status.idle = st.tracker.open.as_ref().is_some_and(|o| o.kind == Kind::Idle);
        st.status.idle_since_ms = st.tracker.open.as_ref().filter(|o| o.kind == Kind::Idle).map(|o| o.start_ms);
        st.status.last_gap_ms = st.tracker.last_gap;
        st.status.last_sample_ms = Some(sample.wall_ms);
        let result = (|| -> rusqlite::Result<()> {
            let conn = db.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
            if queue::activity_backlog(&conn)? >= queue::MAX_PENDING_ACTIVITY {
                return Err(rusqlite::Error::InvalidParameterName("backlog".into()));
            }
            queue::activity_checkpoint(&conn, user, device, &closed, st.tracker.held.iter().chain(&st.tracker.open))
        })();
        match result {
            Ok(()) => st.status.error = None,
            Err(rusqlite::Error::InvalidParameterName(_)) => {
                // Backpressure: stop collecting rather than drop unsynced data.
                st.status.error = Some("Too much activity is waiting to upload; monitoring is paused until it syncs.".into());
                st.mode = "ERROR".into();
                st.status.mode = st.mode.clone();
                st.status.collecting = false;
                st.status.app_nap_prevented = power::prevent_app_nap(false);
                let closed = st.tracker.stop(sample.wall_ms);
                if let Ok(conn) = db.lock() {
                    let _ = queue::activity_checkpoint(&conn, user, device, &closed, []);
                }
            }
            Err(e) => st.status.error = Some(format!("Could not save activity locally: {e}")),
        }
    }

    /// Sets the monitoring mode decided by the UI. Leaving ACTIVE closes the open interval.
    pub fn configure(&self, db: &Mutex<Connection>, mode: String, scope: Option<(String, String)>, cfg: Config) -> CollectorStatus {
        let mut st = self.lock_state();
        let was_active = st.mode == "ACTIVE";
        let scope_changed = st.scope != scope;
        if was_active && (mode != "ACTIVE" || scope_changed) {
            let closed = st.tracker.stop(now_ms());
            if let (Some((user, device)), Ok(conn)) = (st.scope.clone(), db.lock()) {
                let _ = queue::activity_checkpoint(&conn, &user, &device, &closed, []);
            }
        }
        st.status.idle_threshold_seconds = cfg.idle_threshold_ms / 1000;
        st.status.sample_seconds = cfg.sample_ms / 1000;
        st.tracker.cfg = cfg;
        st.mode = mode;
        st.scope = scope;
        st.status.mode = st.mode.clone();
        st.status.collecting = st.mode == "ACTIVE" && platform::SUPPORTED && st.scope.is_some();
        // Only while monitoring is on; released on break, clock-out, sign-out or error.
        st.status.app_nap_prevented = power::prevent_app_nap(st.status.collecting);
        if !st.status.collecting {
            st.status.current_app = None;
            st.status.idle = false;
            st.status.idle_since_ms = None;
            st.status.idle_seconds = None;
        }
        if st.status.collecting && (!was_active || scope_changed) {
            // First sample right away. Not sampled here: sync commands run on the main thread,
            // which the sample itself needs.
            self.wake.store(true, Ordering::SeqCst);
        }
        st.status.clone()
    }

    /// Whether screenshots must be skipped as idle right now: the tracker's verdict while it is collecting
    /// (idle, or the screen locked; idle-excluded apps such as calls are not idle), otherwise no input for the
    /// idle threshold. An idle time that cannot be read counts as idle: nothing is captured unobserved.
    pub fn input_idle(&self) -> bool {
        let st = self.lock_state();
        if st.status.collecting {
            return st.status.idle || st.status.locked;
        }
        let ms = platform::idle_ms();
        ms < 0 || ms >= st.tracker.cfg.idle_threshold_ms
    }

    pub fn status(&self) -> CollectorStatus {
        self.lock_state().status.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_clears_once_the_queue_is_healthy_so_monitoring_can_resume() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        {
            let mut st = c.state.lock().unwrap();
            st.mode = "ERROR".into();
            st.status.error = Some("Could not save activity locally: disk full".into());
        }
        c.tick(&db);
        assert_eq!(c.status().error, None, "error cleared; the UI re-decides ACTIVE");
        c.state.lock().unwrap().status.error = Some("still failing".into());
        db.lock().unwrap().execute_batch("DROP TABLE activity").unwrap();
        c.tick(&db);
        assert!(c.status().error.is_some(), "kept while the queue is still unusable");
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn a_panic_while_holding_the_state_does_not_stop_the_collector_for_good() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        active(&c);
        feed(&c, &db, sample(0, "Code", 0));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = c.state.lock().unwrap();
            panic!("simulated tracker panic");
        }));
        assert!(c.state.is_poisoned());
        assert!(c.status().last_sample_ms.is_some(), "status still readable");
        assert!(!c.state.is_poisoned() && c.lock_state().tracker.open.is_none(), "tracker reset to a clean state");
        assert_eq!(c.lock_state().mode, "ACTIVE", "still monitoring");
        feed(&c, &db, sample(15, "Code", 0));
        feed(&c, &db, sample(30, "Code", 0));
        assert_eq!(rows(&db, "OPEN"), vec![("ACTIVE".into(), Some("Code".into()), 15, 30)], "recording again");
        crate::queue::tests::remove_db(&path);
    }

    fn sample(t: i64, app: &str, idle_s: i64) -> Sample {
        Sample { wall_ms: t * 1000, mono_ms: t * 1000, app: Some(App { id: None, name: app.into() }), idle_ms: idle_s * 1000, locked: false, away: false }
    }
    fn rows(db: &Mutex<Connection>, status: &str) -> Vec<(String, Option<String>, i64, i64)> {
        let conn = db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT kind, app_name, start_ms / 1000, end_ms / 1000 FROM activity WHERE status = ?1 ORDER BY start_ms").unwrap();
        stmt.query_map([status], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect()
    }
    fn active(c: &Collector) {
        let mut st = c.state.lock().unwrap();
        st.mode = "ACTIVE".into();
        st.scope = Some(("user-1".into(), "device-1".into()));
    }
    /// Input until 90 s, Code in front; Mail comes to the front by itself at ~142.5 s.
    fn walk_away(c: &Collector, db: &Mutex<Connection>, until: i64) {
        for t in (0..=until).step_by(15) {
            let mut st = c.state.lock().unwrap();
            Collector::record(&mut st, db, "user-1", "device-1", sample(t, if t >= 150 { "Mail" } else { "Code" }, (t - 90).max(0)));
        }
    }
    /// Mail stays in front, no input since 90 s.
    fn walk_away_from(c: &Collector, db: &Mutex<Connection>, from: i64, until: i64) {
        for t in (from..=until).step_by(15) {
            let mut st = c.state.lock().unwrap();
            Collector::record(&mut st, db, "user-1", "device-1", sample(t, "Mail", t - 90));
        }
    }

    #[test]
    fn held_intervals_are_checkpointed_cut_back_without_leftovers_and_nothing_is_sampled_while_paused() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        active(&c);
        walk_away(&c, &db, 150);
        assert!(rows(&db, "PENDING").is_empty(), "nothing uploadable yet");
        let code = |end| ("ACTIVE".to_string(), Some("Code".to_string()), 0, end);
        assert_eq!(rows(&db, "OPEN"), vec![code(142), ("ACTIVE".into(), Some("Mail".into()), 142, 150)], "held + open checkpointed");
        walk_away_from(&c, &db, 165, 390);
        assert_eq!(rows(&db, "PENDING"), vec![code(90)], "cut back to the last input");
        assert_eq!(rows(&db, "OPEN"), vec![("IDLE".into(), None, 90, 390)], "the emptied Mail row does not linger");

        let scope = Some(("user-1".to_string(), "device-1".to_string()));
        for mode in ["PAUSED_BREAK", "STOPPED"] {
            let status = c.configure(&db, mode.into(), if mode == "STOPPED" { None } else { scope.clone() }, Config::new(15, 300));
            assert!(!status.collecting, "{mode}");
            let before = (rows(&db, "PENDING"), rows(&db, "OPEN"));
            c.tick(&db); // the collector thread's tick: returns before sampling while not ACTIVE
            assert_eq!((rows(&db, "PENDING"), rows(&db, "OPEN")), before, "{mode}: no sample, no rows");
        }
        assert_eq!(rows(&db, "PENDING").iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["ACTIVE", "IDLE"]);
        assert!(rows(&db, "OPEN").is_empty());
        crate::queue::tests::remove_db(&path);
    }

    /// FakeOs: transitions delivered the way session_events would, at chosen times. The idle counter
    /// reads 10 minutes (no recent input), so a lock here is the inactivity kind (see `deliver_input`).
    fn deliver(c: &Collector, db: &Mutex<Connection>, session: &mut SessionState, event: session_events::Event, at_s: i64) {
        deliver_input(c, db, session, event, at_s, 600_000);
    }
    fn deliver_input(c: &Collector, db: &Mutex<Connection>, session: &mut SessionState, event: session_events::Event, at_s: i64, idle_ms: i64) {
        let t = Transition { event, at_ms: at_s * 1000 };
        *session = session.apply(t);
        c.on_transition(db, t, *session, idle_ms);
    }
    fn feed(c: &Collector, db: &Mutex<Connection>, s: Sample) {
        Collector::record(&mut c.state.lock().unwrap(), db, "user-1", "device-1", s);
    }
    fn locked(t: i64) -> Sample {
        Sample { locked: true, ..sample(t, "loginwindow", 0) }
    }
    fn away(t: i64) -> Sample {
        Sample { away: true, ..sample(t, "loginwindow", 0) }
    }

    /// A screen that locks after inactivity is IDLE from the lock to the unlock, as before (a lock by
    /// hand is a break: see the lock_break tests); sleep and another user's session record nothing.
    #[test]
    fn lock_is_idle_while_sleep_and_user_switch_record_nothing_and_all_close_at_the_transition() {
        use session_events::Event::*;
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        active(&c);
        let mut os = SessionState::default();
        let code = |a, b| ("ACTIVE".to_string(), Some("Code".to_string()), a, b);

        let idle = |a, b| ("IDLE".to_string(), None, a, b);
        // Lock at 20 s: the open interval is closed and uploadable at once, not at the next sample.
        feed(&c, &db, sample(0, "Code", 0));
        feed(&c, &db, sample(15, "Code", 0));
        deliver(&c, &db, &mut os, Locked, 20);
        assert_eq!(rows(&db, "PENDING"), vec![code(0, 20)]);
        assert_eq!(rows(&db, "OPEN"), vec![idle(20, 20)], "idle starts at the lock");
        let st = c.status();
        assert!(st.locked && st.idle && st.idle_since_ms == Some(20_000) && st.current_app.is_none());
        for t in (30..=90).step_by(15) {
            feed(&c, &db, locked(t));
        }
        assert_eq!(rows(&db, "OPEN"), vec![idle(20, 90)], "IDLE while locked, even with input at the lock screen");
        deliver(&c, &db, &mut os, Unlocked, 95);
        assert!(c.wake.swap(false, Ordering::SeqCst), "unlock samples right away");
        assert!(!c.status().locked);
        feed(&c, &db, sample(95, "Code", 0));
        assert_eq!(c.status().last_gap_ms, None, "locked time is idle, not a gap");
        assert!(!c.status().idle);

        // Sleep at 100 s, wake an hour later (wall clock jumped, monotonic did not), locked at wake.
        feed(&c, &db, sample(99, "Code", 0));
        deliver(&c, &db, &mut os, WillSleep, 100);
        assert!(c.status().asleep);
        deliver(&c, &db, &mut os, DidWake, 3_700);
        deliver(&c, &db, &mut os, Locked, 3_700);
        feed(&c, &db, Sample { mono_ms: 115_000, ..locked(3_715) });
        deliver(&c, &db, &mut os, Unlocked, 3_720);
        feed(&c, &db, Sample { mono_ms: 120_000, ..sample(3_720, "Code", 1) });
        assert_eq!(c.status().last_gap_ms, Some((100_000, 3_715_000)), "the sleep; the locked screen after wake is idle");

        // Fast user switch at 3 730 s; the other user's input never counts.
        deliver(&c, &db, &mut os, SessionResigned, 3_730);
        assert!(c.status().session_inactive);
        for t in (3_735..=4_000).step_by(15) {
            feed(&c, &db, Sample { mono_ms: t * 1000 - 3_600_000, ..away(t) });
        }
        deliver(&c, &db, &mut os, SessionActive, 4_005);
        assert!(!c.status().session_inactive);
        c.configure(&db, "STOPPED".into(), None, Config::new(15, 300));

        assert_eq!(rows(&db, "PENDING"), vec![code(0, 20), idle(20, 95), code(95, 100), idle(3_715, 3_720), code(3_720, 3_730)]);
        assert!(rows(&db, "OPEN").is_empty());
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn transitions_while_not_monitoring_record_nothing_and_policy_is_applied() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        let mut os = SessionState::default();
        deliver(&c, &db, &mut os, session_events::Event::Locked, 10);
        deliver(&c, &db, &mut os, session_events::Event::Unlocked, 11);
        assert!(!c.wake.load(Ordering::SeqCst), "no sample while STOPPED");
        assert!(rows(&db, "PENDING").is_empty() && rows(&db, "OPEN").is_empty());
        let scope = Some(("user-1".to_string(), "device-1".to_string()));
        let st = c.configure(&db, "PAUSED_BREAK".into(), scope, Config::new(5, 30));
        assert_eq!((st.sample_seconds, st.idle_threshold_seconds), (5, 30), "server policy in force");
        assert!(!st.app_nap_prevented, "App Nap opt-out only while monitoring is on");
        assert_eq!(c.state.lock().unwrap().tracker.cfg.idle_threshold_ms, 30_000);
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn a_deliberate_quit_closes_everything_so_nothing_is_reported_as_a_crash() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        active(&c);
        walk_away(&c, &db, 165);
        // What RunEvent::Exit does (lib.rs).
        c.configure(&db, "STOPPED".into(), None, Config::new(15, 300));
        assert!(rows(&db, "OPEN").is_empty());
        assert_eq!(queue::activity_recover(&db.lock().unwrap()).unwrap(), 0, "no 'closed unexpectedly' notice after Quit");
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn held_intervals_survive_a_crash_like_the_open_interval() {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        let c = Collector::new();
        active(&c);
        walk_away(&c, &db, 165);
        // The app dies here; at the next start OPEN rows end at their last checkpoint.
        assert_eq!(queue::activity_recover(&db.lock().unwrap()).unwrap(), 2);
        assert_eq!(rows(&db, "PENDING"), vec![("ACTIVE".into(), Some("Code".into()), 0, 142), ("ACTIVE".into(), Some("Mail".into()), 142, 165)]);
        crate::queue::tests::remove_db(&path);
    }

    // ---- Screen lock by hand = break (synthetic OS events, temporary database) ----------------

    fn db() -> (std::path::PathBuf, Mutex<Connection>) {
        let path = std::env::temp_dir().join(format!("wf-collector-test-{}.db", uuid::Uuid::new_v4()));
        let db = Mutex::new(queue::open(&path).unwrap());
        (path, db)
    }
    /// What the webview does on the `screen-lock` event: the break pauses monitoring, the unlock resumes it.
    fn set_mode(c: &Collector, db: &Mutex<Connection>, mode: &str) {
        c.configure(db, mode.into(), Some(("user-1".into(), "device-1".into())), Config::new(15, 300));
    }

    /// The Windows collector, on any host: WTS_SESSION_LOCK/UNLOCK, PBT_APMSUSPEND/RESUME and the console
    /// display state arrive as these Event values (win/session.rs `event_for`, tested there).
    fn windows_collector() -> Collector {
        Collector { lock_breaks: true, ..Collector::new() }
    }

    #[test]
    fn windows_win_l_is_a_break_never_idle_and_activity_resumes_only_after_the_unlock() {
        use session_events::Event::*;
        let (path, db) = db();
        let c = windows_collector();
        active(&c);
        let mut os = SessionState::default();
        feed(&c, &db, sample(0, "Code", 0));
        feed(&c, &db, sample(15, "Code", 0));
        deliver_input(&c, &db, &mut os, Locked, 20, 400); // the lock shortcut was the last input
        assert_eq!(rows(&db, "PENDING"), vec![("ACTIVE".into(), Some("Code".into()), 0, 20)], "activity ends at the lock");
        assert!(rows(&db, "OPEN").is_empty(), "no IDLE interval opens");
        assert!(!c.status().idle && c.status().locked);
        assert_eq!(c.due_lock_break(21_000, os), None, "not before LOCK_CONFIRM_MS");
        assert_eq!(c.due_lock_break(22_000, os), Some(20_000), "break starts at the lock time");
        assert_eq!(c.due_lock_break(30_000, os), None, "reported once");
        assert!(c.status().lock_break);
        // Repeated lock notifications while locked: still one break, still nothing idle.
        deliver_input(&c, &db, &mut os, Locked, 25, 0);
        assert_eq!(c.due_lock_break(40_000, os), None, "no duplicate break");
        // Locked samples before the webview pauses monitoring: unobserved, never IDLE.
        feed(&c, &db, Sample { away: true, ..locked(30) });
        assert!(rows(&db, "OPEN").is_empty() && rows(&db, "PENDING").len() == 1);
        set_mode(&c, &db, "PAUSED_BREAK");
        deliver_input(&c, &db, &mut os, Unlocked, 600, 0);
        assert!(!c.status().lock_break && !c.status().locked);
        set_mode(&c, &db, "ACTIVE"); // BREAK_END queued by the webview
        // Activity detection resumes from the first sample after the unlock; nothing assumed before it.
        feed(&c, &db, sample(601, "Mail", 0));
        feed(&c, &db, sample(616, "Mail", 0));
        assert_eq!(rows(&db, "OPEN"), vec![("ACTIVE".into(), Some("Mail".into()), 601, 616)]);
        assert_eq!(c.status().last_gap_ms, None, "a break is not an unobserved gap");
        assert!(rows(&db, "PENDING").iter().all(|r| r.0 != "IDLE"), "no idle anywhere");
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn windows_suspend_resume_display_off_and_screen_saver_locks_are_not_breaks() {
        use session_events::Event::*;
        let (path, db) = db();
        let c = windows_collector();
        active(&c);
        let mut os = SessionState::default();
        feed(&c, &db, sample(0, "Code", 0));
        // Lid closed right after typing: lock, then sleep within LOCK_CONFIRM_MS → sleep handling, no break.
        deliver_input(&c, &db, &mut os, Locked, 10, 200);
        deliver_input(&c, &db, &mut os, WillSleep, 11, 200);
        assert_eq!(c.due_lock_break(20_000, os), None, "system sleep is not a break");
        assert!(!c.status().lock_break, "the lock being confirmed was the sleep's");
        // Wake into the lock screen: the lock right after the wake is not a break either.
        deliver_input(&c, &db, &mut os, DidWake, 3_600, 0);
        deliver_input(&c, &db, &mut os, Unlocked, 3_601, 0);
        deliver_input(&c, &db, &mut os, Locked, 3_605, 0);
        assert_eq!(c.due_lock_break(3_700_000, os), None, "lock at wake");
        deliver_input(&c, &db, &mut os, Unlocked, 3_700, 0);
        // Display slept after inactivity, then the screen locked: idle as before.
        feed(&c, &db, Sample { mono_ms: 3_000, ..sample(3_701, "Code", 0) });
        deliver_input(&c, &db, &mut os, ScreensSlept, 3_710, 0);
        deliver_input(&c, &db, &mut os, Locked, 3_711, 0);
        assert_eq!(c.due_lock_break(3_800_000, os), None, "display sleep lock");
        assert!(rows(&db, "OPEN").iter().any(|r| r.0 == "IDLE"), "idle from the lock, as before");
        deliver_input(&c, &db, &mut os, ScreensWoke, 3_800, 0);
        deliver_input(&c, &db, &mut os, Unlocked, 3_800, 0);
        // Screen saver lock after 2 minutes without input: not by hand, idle as before.
        deliver_input(&c, &db, &mut os, Locked, 3_900, 120_000);
        assert_eq!(c.due_lock_break(4_000_000, os), None, "inactivity lock");
        deliver_input(&c, &db, &mut os, Unlocked, 3_950, 0);
        // A lock-unlock flap shorter than LOCK_CONFIRM_MS: no break.
        deliver_input(&c, &db, &mut os, Locked, 4_000, 100);
        deliver_input(&c, &db, &mut os, Unlocked, 4_001, 0);
        assert_eq!(c.due_lock_break(4_010_000, os), None, "quick lock/unlock");
        // While not monitoring (clocked out, on a break, no consent): never a break from a lock.
        set_mode(&c, &db, "STOPPED");
        deliver_input(&c, &db, &mut os, Locked, 5_000, 100);
        assert_eq!(c.due_lock_break(5_010_000, os), None, "not monitoring");
        crate::queue::tests::remove_db(&path);
    }

    #[test]
    fn hand_lock_classification() {
        let awake = SessionState::default();
        assert!(manual_lock(&awake, 500, false, None, 100_000));
        assert!(manual_lock(&awake, 29_999, false, Some(80_000), 100_000), "woke 20 s before");
        assert!(!manual_lock(&awake, 30_000, false, None, 100_000), "no recent input");
        assert!(!manual_lock(&awake, -1, false, None, 100_000), "idle counter unreadable: not assumed");
        assert!(!manual_lock(&awake, 500, true, None, 100_000), "already idle");
        assert!(!manual_lock(&awake, 500, false, Some(95_000), 100_000), "just woke");
        assert!(!manual_lock(&SessionState { asleep: true, ..awake }, 500, false, None, 100_000));
        assert!(!manual_lock(&SessionState { display_asleep: true, ..awake }, 500, false, None, 100_000));
        assert!(!manual_lock(&SessionState { session_inactive: true, ..awake }, 500, false, None, 100_000));
    }

    /// macOS keeps its behaviour: a lock is IDLE from the lock to the unlock, even right after input,
    /// and nothing is ever sent to start a break (com.apple.screenIsLocked is the same Locked event).
    #[test]
    fn macos_lock_stays_idle_and_never_starts_a_break() {
        use session_events::Event::*;
        #[cfg(target_os = "macos")]
        assert!(!Collector::new().lock_breaks, "lock breaks are off in the macOS build");
        let (path, db) = db();
        let c = Collector { lock_breaks: false, ..Collector::new() };
        active(&c);
        let mut os = SessionState::default();
        feed(&c, &db, sample(0, "Code", 0));
        feed(&c, &db, sample(15, "Code", 0));
        deliver_input(&c, &db, &mut os, Locked, 20, 400); // Ctrl+Cmd+Q, right after typing
        assert_eq!(rows(&db, "OPEN"), vec![("IDLE".into(), None, 20, 20)], "idle starts at the lock, as before");
        assert_eq!(c.due_lock_break(30_000, os), None, "no break");
        assert!(!c.status().lock_break && c.status().idle && c.status().locked);
        for t in (30..=90).step_by(15) {
            feed(&c, &db, locked(t));
        }
        assert_eq!(rows(&db, "OPEN"), vec![("IDLE".into(), None, 20, 90)], "IDLE while locked");
        deliver_input(&c, &db, &mut os, Unlocked, 95, 0);
        feed(&c, &db, sample(95, "Code", 0));
        assert_eq!(rows(&db, "PENDING"), vec![("ACTIVE".into(), Some("Code".into()), 0, 20), ("IDLE".into(), None, 20, 95)]);
        crate::queue::tests::remove_db(&path);
    }
}
