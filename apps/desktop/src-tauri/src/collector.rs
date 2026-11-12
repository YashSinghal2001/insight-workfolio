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
use tauri::{AppHandle, Manager};

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
        }
    }
}

struct State {
    mode: String,
    scope: Option<(String, String)>,
    tracker: Tracker,
    status: CollectorStatus,
}

pub struct Collector {
    state: Mutex<State>,
    started: Instant,
    /// Set by `configure` to take the first sample right away instead of one period later.
    wake: AtomicBool,
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
            }),
            started: Instant::now(),
            wake: AtomicBool::new(false),
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
                        worker.on_transition(&app.state::<Mutex<Connection>>(), t, session_events::current());
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
    fn on_transition(&self, db: &Mutex<Connection>, t: Transition, session: SessionState) {
        let mut st = self.lock_state();
        st.status.locked = session.locked;
        st.status.asleep = session.asleep;
        st.status.session_inactive = session.session_inactive;
        if st.mode != "ACTIVE" {
            return;
        }
        if !t.event.interrupts() {
            self.wake.store(true, Ordering::SeqCst);
            return;
        }
        // A locked screen is idle from the lock (the employee notice says so); sleep and a session
        // switch are unobserved: everything closes and nothing stays open.
        let closed = if t.event == session_events::Event::Locked { st.tracker.lock(t.at_ms) } else { st.tracker.interrupt(t.at_ms) };
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
        let sample = self.take_sample();
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

    /// FakeOs: transitions delivered the way session_events would, at chosen times.
    fn deliver(c: &Collector, db: &Mutex<Connection>, session: &mut SessionState, event: session_events::Event, at_s: i64) {
        let t = Transition { event, at_ms: at_s * 1000 };
        *session = session.apply(t);
        c.on_transition(db, t, *session);
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

    /// A locked screen is IDLE from the lock to the unlock, as the employee notice says ("Idle
    /// time: … or the screen is locked", packages/shared/src/activity.ts); sleep and another
    /// user's session record nothing.
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
}
