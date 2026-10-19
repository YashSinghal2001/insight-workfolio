//! The single activity-collection worker. The webview decides the monitoring mode from the
//! attendance state; this thread samples only while the mode is ACTIVE.

use crate::activity::{platform, App, Config, Kind, Sample, Tracker};
use crate::queue;
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
    pub error: Option<String>,
    pub last_sample_ms: Option<i64>,
    /// Start of the current idle interval (idle is attributed from the last input).
    pub idle_since_ms: Option<i64>,
    /// Latest unobserved stretch while monitoring (sleep, suspended app, clock change): [start, end] ms.
    pub last_gap_ms: Option<(i64, i64)>,
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
                status: CollectorStatus {
                    supported: platform::SUPPORTED,
                    mode: "STOPPED".into(),
                    collecting: false,
                    current_app: None,
                    idle: false,
                    locked: false,
                    error: None,
                    last_sample_ms: None,
                    idle_since_ms: None,
                    last_gap_ms: None,
                },
            }),
            started: Instant::now(),
            wake: AtomicBool::new(false),
        }
    }

    /// Starts the one worker thread for the app's lifetime (no duplicate workers).
    pub fn spawn(app: AppHandle) -> Arc<Collector> {
        let collector = Arc::new(Collector::new());
        let worker = collector.clone();
        std::thread::Builder::new()
            .name("activity-collector".into())
            .spawn(move || {
                let mut last = Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    let period = worker.state.lock().map(|s| s.tracker.cfg.sample_ms).unwrap_or(15_000);
                    if worker.wake.swap(false, Ordering::SeqCst) || last.elapsed() >= Duration::from_millis(period as u64) {
                        last = Instant::now();
                        worker.tick(&app.state::<Mutex<Connection>>());
                    }
                }
            })
            .expect("spawn activity collector");
        collector
    }

    fn take_sample(&self) -> Sample {
        Sample {
            wall_ms: now_ms(),
            mono_ms: self.started.elapsed().as_millis() as i64,
            app: platform::frontmost(),
            idle_ms: platform::idle_ms(),
            locked: platform::screen_locked(),
        }
    }

    fn tick(&self, db: &Mutex<Connection>) {
        let Ok(mut st) = self.state.lock() else { return };
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
        let sample = self.take_sample();
        Self::record(&mut st, db, &user, &device, sample);
    }

    /// One sample into the tracker and the local queue (split from `tick` so tests feed samples).
    fn record(st: &mut State, db: &Mutex<Connection>, user: &str, device: &str, sample: Sample) {
        let closed = st.tracker.sample(&sample);
        st.status.current_app = sample.app.clone();
        st.status.locked = sample.locked;
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
        let Ok(mut st) = self.state.lock() else { return self.status() };
        let was_active = st.mode == "ACTIVE";
        let scope_changed = st.scope != scope;
        if was_active && (mode != "ACTIVE" || scope_changed) {
            let closed = st.tracker.stop(now_ms());
            if let (Some((user, device)), Ok(conn)) = (st.scope.clone(), db.lock()) {
                let _ = queue::activity_checkpoint(&conn, &user, &device, &closed, []);
            }
        }
        st.tracker.cfg = cfg;
        st.mode = mode;
        st.scope = scope;
        st.status.mode = st.mode.clone();
        st.status.collecting = st.mode == "ACTIVE" && platform::SUPPORTED && st.scope.is_some();
        if !st.status.collecting {
            st.status.current_app = None;
            st.status.idle = false;
            st.status.idle_since_ms = None;
        }
        if st.status.collecting && (!was_active || scope_changed) {
            // First sample right away. Not sampled here: sync commands run on the main thread,
            // which the sample itself needs.
            self.wake.store(true, Ordering::SeqCst);
        }
        st.status.clone()
    }

    pub fn status(&self) -> CollectorStatus {
        self.state.lock().map(|s| s.status.clone()).unwrap_or(CollectorStatus {
            supported: platform::SUPPORTED,
            mode: "ERROR".into(),
            collecting: false,
            current_app: None,
            idle: false,
            locked: false,
            error: Some("Collector unavailable".into()),
            last_sample_ms: None,
            idle_since_ms: None,
            last_gap_ms: None,
        })
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

    fn sample(t: i64, app: &str, idle_s: i64) -> Sample {
        Sample { wall_ms: t * 1000, mono_ms: t * 1000, app: Some(App { id: None, name: app.into() }), idle_ms: idle_s * 1000, locked: false }
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
