//! Foreground-application activity tracking: turns periodic samples into non-overlapping
//! ACTIVE (one application) / IDLE intervals. Pure logic here; OS calls in `platform`.
//!
//! Collected per sample: the foreground application's name and bundle identifier, seconds
//! since the last keyboard/mouse input (a counter only, never the input itself) and whether
//! the screen is locked or another user's session is in front. No window titles, documents, URLs, keystrokes or screenshots.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// Bundle identifier, e.g. "com.apple.Safari" (absent for some processes).
    pub id: Option<String>,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Kind {
    Active,
    Idle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Interval {
    pub id: String,
    pub kind: Kind,
    /// Only for ACTIVE intervals.
    pub app: Option<App>,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Sample {
    /// Wall clock (Unix ms): used for timestamps.
    pub wall_ms: i64,
    /// Monotonic clock that stops while the computer sleeps: used to detect sleep and clock changes.
    pub mono_ms: i64,
    pub app: Option<App>,
    /// Time since the last keyboard/mouse input; negative = no valid reading.
    pub idle_ms: i64,
    /// Not observable: screen locked, Mac going to sleep, or this user's session not in front
    /// (fast user switching, logout). Nothing is attributed, neither ACTIVE nor IDLE.
    pub locked: bool,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub sample_ms: i64,
    pub idle_threshold_ms: i64,
    /// Long single-app intervals are split so they upload regularly.
    pub max_interval_ms: i64,
    /// Server policy (W22): app identifiers whose foreground use is never idle (e.g. video calls).
    pub idle_excluded_apps: Vec<String>,
}

impl Config {
    pub fn new(sample_secs: u32, idle_secs: u32) -> Self {
        Config {
            sample_ms: i64::from(sample_secs.max(1)) * 1000,
            idle_threshold_ms: i64::from(idle_secs.max(1)) * 1000,
            max_interval_ms: 15 * 60 * 1000,
            idle_excluded_apps: Vec::new(),
        }
    }
}

/// W22: whether the foreground app is on the server's idle-exclusion list (recorded identifier: bundle id
/// on macOS, exe file name on Windows; case-insensitive). Such an app in front counts as input.
pub fn idle_excluded(app: Option<&App>, excluded: &[String]) -> bool {
    match app.and_then(|a| a.id.as_deref()) {
        Some(id) => excluded.iter().any(|e| e.eq_ignore_ascii_case(id)),
        None => false,
    }
}

pub struct Tracker {
    pub cfg: Config,
    pub open: Option<Interval>,
    /// Closed ACTIVE intervals with no input seen since they ended (an app came to the front by
    /// itself after the user's last input). Released unchanged at the next input; if idle comes
    /// first they are cut back to the last input. Checkpointed like `open` until released.
    pub held: Vec<Interval>,
    /// Last sample: wall, monotonic, last input (wall).
    last: Option<(i64, i64, i64)>,
    /// Start of the current unobserved stretch, until the next observable sample ends it.
    unobserved_from: Option<i64>,
    /// Latest stretch that could not be observed (sleep, suspended process, clock change):
    /// (last trustworthy sample, first sample after it), wall-clock ms. Shown to the employee.
    pub last_gap: Option<(i64, i64)>,
}

fn new_interval(kind: Kind, app: Option<App>, start_ms: i64, end_ms: i64) -> Interval {
    Interval { id: uuid::Uuid::new_v4().to_string(), kind, app, start_ms, end_ms }
}

impl Tracker {
    pub fn new(cfg: Config) -> Self {
        Tracker { cfg, open: None, held: Vec::new(), last: None, unobserved_from: None, last_gap: None }
    }

    /// Feeds one sample. Returns the intervals it closed (never overlapping, never empty).
    pub fn sample(&mut self, s: &Sample) -> Vec<Interval> {
        // `out` is final; `closed` is final only once input after its end has been seen.
        let mut out = Vec::new();
        let mut closed = Vec::new();
        let mut prev_wall = None;
        // No valid idle reading (not evidence of input), a locked screen or another session in
        // front: unobserved until the next observable sample. Never counted as idle or active.
        let observable = s.idle_ms >= 0 && !s.locked;
        // An excluded app in front is treated as input now: never idle while it is in front.
        let idle_ms = if idle_excluded(s.app.as_ref(), &self.cfg.idle_excluded_apps) { s.idle_ms.min(0) } else { s.idle_ms };
        if let Some((last_wall, last_mono, _)) = self.last {
            let (dw, dm) = (s.wall_ms - last_wall, s.mono_ms - last_mono);
            // Sleep (monotonic clock paused), a suspended process, or a wall-clock change: the time
            // since the last sample cannot be attributed, so close at the last trustworthy sample.
            // Nothing is estimated for the gap; it stays unobserved.
            let tolerance = self.cfg.sample_ms.max(5_000);
            if dw < 0 || (dw - dm).abs() > tolerance || dm > 3 * self.cfg.sample_ms + 5_000 || !observable {
                self.unobserved_from.get_or_insert(last_wall);
                self.release_all(&mut out, last_wall);
            } else {
                prev_wall = Some(last_wall);
            }
        }
        // When the user last touched keyboard/mouse, from the system idle counter. A foreground app
        // change is not input and does not move this.
        let last_input = s.wall_ms - idle_ms.max(0);
        self.last = Some((s.wall_ms, s.mono_ms, last_input));
        let gap = |from: i64| (from, s.wall_ms.max(from));
        if !observable {
            self.last_gap = self.unobserved_from.map(gap);
            return out;
        }
        if let Some(from) = self.unobserved_from.take() {
            self.last_gap = Some(gap(from));
        }

        let (kind, app) = if idle_ms >= self.cfg.idle_threshold_ms {
            (Kind::Idle, None)
        } else if let Some(app) = &s.app {
            (Kind::Active, Some(app.clone()))
        } else {
            // No foreground application (e.g. login window): attribute nothing.
            if let Some(mut open) = self.open.take() {
                open.end_ms = s.wall_ms;
                push(&mut closed, open);
            }
            return self.settle(out, closed, last_input);
        };
        // Idle reaches back to the last input, across intervals held since then.
        let floor = self.held.first().map(|h| h.start_ms);
        if kind == Kind::Idle {
            for mut h in self.held.drain(..) {
                h.end_ms = h.end_ms.min(last_input);
                push(&mut out, h);
            }
        }

        match self.open.take() {
            None => {
                let start = match (kind, floor) {
                    (Kind::Idle, Some(f)) => last_input.clamp(f, s.wall_ms),
                    _ => s.wall_ms,
                };
                self.open = Some(new_interval(kind, app, start, s.wall_ms));
            }
            Some(mut open) => {
                let same = open.kind == kind && open.app == app;
                // Split long intervals only while input is recent, so a later idle transition can
                // never reach back into an already closed (uploaded) interval.
                let split = same && s.wall_ms - open.start_ms >= self.cfg.max_interval_ms && idle_ms < self.cfg.sample_ms;
                if same && !split {
                    open.end_ms = s.wall_ms;
                    self.open = Some(open);
                } else {
                    // Idle starts at the last input (retroactively), and ends at the new input (both
                    // exact). An app switch happened at an unknown moment since the previous sample:
                    // split at the midpoint, halving the worst-case error and removing the bias toward
                    // the previous app. A long-interval split is at the sample itself.
                    let boundary = if open.kind != kind {
                        // An excluded app counted as input until it was last seen in front (W22).
                        let lo = if idle_excluded(open.app.as_ref(), &self.cfg.idle_excluded_apps) { open.end_ms } else { floor.unwrap_or(open.start_ms) };
                        last_input.clamp(lo, s.wall_ms)
                    } else if let (false, Some(prev)) = (split, prev_wall) {
                        ((prev + s.wall_ms) / 2).clamp(open.start_ms, s.wall_ms)
                    } else {
                        s.wall_ms
                    };
                    open.end_ms = boundary;
                    push(&mut closed, open);
                    self.open = Some(new_interval(kind, app, boundary, s.wall_ms));
                }
            }
        }
        self.settle(out, closed, last_input)
    }

    /// Releases closed intervals that input has happened since (and idle ones); holds the rest, in order.
    fn settle(&mut self, mut out: Vec<Interval>, mut closed: Vec<Interval>, last_input: i64) -> Vec<Interval> {
        self.held.append(&mut closed);
        // An excluded app's interval was "input" throughout, so it is never cut back by later idle.
        let excluded = &self.cfg.idle_excluded_apps;
        let ready = self.held.iter().take_while(|i| i.kind == Kind::Idle || i.end_ms <= last_input || idle_excluded(i.app.as_ref(), excluded)).count();
        out.extend(self.held.drain(..ready));
        out
    }

    /// Unobserved time follows: held intervals stand as they are (the threshold was never reached
    /// while observed) and the open one ends at `end_ms`.
    fn release_all(&mut self, out: &mut Vec<Interval>, end_ms: i64) {
        out.append(&mut self.held);
        if let Some(mut open) = self.open.take() {
            open.end_ms = open.end_ms.min(end_ms);
            push(out, open);
        }
    }

    /// The OS reported a lock, sleep or session switch at `at_ms`: unobserved from then on, without
    /// waiting for the next sample. The open interval runs to the transition (at most one sample
    /// period past the last sample, and an active one never past the idle threshold); held ones
    /// stand as they are. The next observable sample starts afresh and reports the gap.
    pub fn interrupt(&mut self, at_ms: i64) -> Vec<Interval> {
        let mut out = Vec::new();
        let Some((last_wall, _, last_input)) = self.last else { return out };
        let mut end = at_ms.clamp(last_wall, last_wall + self.cfg.sample_ms);
        if let Some(open) = &mut self.open {
            if open.kind == Kind::Active {
                end = end.min(last_input + self.cfg.idle_threshold_ms).max(open.end_ms);
            }
            open.end_ms = end;
        }
        self.unobserved_from.get_or_insert(end);
        self.release_all(&mut out, i64::MAX);
        out
    }

    /// Monitoring paused/stopped (break, clock-out, sign-out): close the open interval. It is
    /// extended to `wall_ms` by at most one sample period (the time since the last sample).
    pub fn stop(&mut self, wall_ms: i64) -> Vec<Interval> {
        self.last = None;
        self.unobserved_from = None;
        if let Some(open) = &mut self.open {
            open.end_ms = open.end_ms.max(wall_ms.min(open.end_ms + self.cfg.sample_ms));
        }
        let mut out = Vec::new();
        self.release_all(&mut out, i64::MAX);
        out
    }
}

fn push(closed: &mut Vec<Interval>, i: Interval) {
    if i.end_ms > i.start_ms {
        closed.push(i);
    }
}

// ---- OS integration ------------------------------------------------------------------

pub mod platform {
    pub use imp::{frontmost, idle_ms, on_console, screen_locked, SUPPORTED};

    #[cfg(target_os = "macos")]
    mod imp {
        use super::super::App;
        use objc2::rc::{autoreleasepool, Retained};
        use objc2::runtime::AnyObject;
        use objc2_app_kit::NSRunningApplication;
        use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
        use std::ffi::c_void;

        pub const SUPPORTED: bool = true;

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            // Seconds since the last input event of any type. Reads a counter only; no event
            // contents, no event tap, no Accessibility permission.
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
            // Current login-session properties (copy rule: caller releases).
            fn CGSessionCopyCurrentDictionary() -> *mut c_void;
            // On-screen windows, front to back (copy rule). Without Screen Recording permission
            // macOS omits window titles; we never read them either way.
            fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut c_void;
        }
        const ON_SCREEN_ONLY: u32 = 1 << 0;
        const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
        const COMBINED_SESSION_STATE: i32 = 0;
        const ANY_INPUT_EVENT: u32 = u32::MAX;

        type Dict = NSDictionary<NSString, AnyObject>;

        fn number(dict: &Dict, key: &str) -> Option<i64> {
            dict.objectForKey(&NSString::from_str(key))?.downcast::<NSNumber>().ok().map(|n| n.longLongValue())
        }

        /// Foreground application: owner of the frontmost normal (layer 0) on-screen window,
        /// resolved to its name and bundle identifier. Queried fresh from the window server each
        /// time (NSWorkspace.frontmostApplication was observed to go stale inside the app).
        /// Reads only the owner process ID and layer; no permission is required.
        pub fn frontmost() -> Option<App> {
            autoreleasepool(|_| unsafe {
                let raw = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0);
                let windows = Retained::<NSArray<Dict>>::from_raw(raw.cast())?;
                let pid = windows.iter().find(|w| number(w, "kCGWindowLayer") == Some(0)).and_then(|w| number(&w, "kCGWindowOwnerPID"))?;
                let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
                // Some names carry invisible bidi marks (WhatsApp: U+200E); strip them so names group cleanly.
                let name = app.localizedName()?.to_string();
                let name = name.trim_matches(|c: char| c.is_whitespace() || matches!(c, '\u{200e}' | '\u{200f}'));
                (!name.is_empty()).then(|| App { id: app.bundleIdentifier().map(|s| s.to_string()), name: name.to_string() })
            })
        }

        pub fn idle_ms() -> i64 {
            let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
            // Invalid readings are negative (unobserved), never 0, which would look like fresh input.
            if secs.is_finite() && secs >= 0.0 { (secs * 1000.0) as i64 } else { -1 }
        }

        /// One flag of this login session's CGSession dictionary (`None`: no dictionary or no key).
        fn session_flag(key: &str) -> Option<bool> {
            autoreleasepool(|_| unsafe {
                let raw = CGSessionCopyCurrentDictionary();
                // CFDictionary is toll-free bridged to NSDictionary; from_raw takes ownership (+1).
                let dict = Retained::<NSDictionary<NSString, AnyObject>>::from_raw(raw.cast())?;
                dict.objectForKey(&NSString::from_str(key)).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.boolValue())
            })
        }

        pub fn screen_locked() -> bool {
            session_flag("CGSSessionScreenIsLocked").unwrap_or(false)
        }

        /// False while another user's session is in front (fast user switching). Unknown = true,
        /// so a missing key never stops monitoring by itself.
        pub fn on_console() -> bool {
            session_flag("kCGSSessionOnConsoleKey").unwrap_or(true)
        }
    }

    /// Windows: foreground executable's file name (identifier, never the full path) and FileDescription (name),
    /// GetLastInputInfo idle ticks, input-desktop lock check, console/connected session check.
    #[cfg(windows)]
    mod imp {
        pub use crate::win::activity::{frontmost, idle_ms_now as idle_ms, on_console, screen_locked};
        pub const SUPPORTED: bool = true;
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    mod imp {
        // Unsupported OS: nothing is collected here.
        use super::super::App;
        pub const SUPPORTED: bool = false;
        pub fn frontmost() -> Option<App> {
            None
        }
        pub fn idle_ms() -> i64 {
            0
        }
        pub fn screen_locked() -> bool {
            false
        }
        pub fn on_console() -> bool {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 15_000;
    fn app(name: &str) -> Option<App> {
        Some(App { id: Some(format!("com.example.{name}")), name: name.into() })
    }
    fn tracker() -> Tracker {
        Tracker::new(Config::new(15, 300))
    }
    /// A sample at t seconds (wall == monotonic unless shifted).
    fn at(t: i64, a: &str, idle_s: i64) -> Sample {
        Sample { wall_ms: t * 1000, mono_ms: t * 1000, app: app(a), idle_ms: idle_s * 1000, locked: false }
    }
    fn run(t: &mut Tracker, samples: &[Sample]) -> Vec<Interval> {
        samples.iter().flat_map(|s| t.sample(s)).collect()
    }
    fn summary(v: &[Interval]) -> Vec<(Kind, Option<String>, i64, i64)> {
        v.iter().map(|i| (i.kind, i.app.as_ref().map(|a| a.name.clone()), i.start_ms / 1000, i.end_ms / 1000)).collect()
    }

    #[test]
    fn app_switching_creates_consecutive_non_overlapping_intervals() {
        let mut t = tracker();
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 1), at(30, "Safari", 2), at(45, "Safari", 1), at(60, "Code", 0)]);
        // Switches are seen at 30 s and 60 s; each happened at an unknown moment in the 15 s before,
        // so the boundary is the midpoint (22.5 s, 52.5 s): at most half a sample period off.
        let ms: Vec<_> = closed.iter().map(|i| (i.app.as_ref().unwrap().name.as_str(), i.start_ms, i.end_ms)).collect();
        assert_eq!(ms, [("Code", 0, 22_500), ("Safari", 22_500, 52_500)]);
        let last = t.stop(65_000).pop().unwrap();
        assert_eq!((last.start_ms, last.end_ms), (52_500, 65_000), "extended to the stop time");
    }

    /// Samples every 15 s from `from` to `to` (inclusive); input last happened at `last_input`.
    fn every(from: i64, to: i64, a: &str, last_input: i64) -> Vec<Sample> {
        (from..=to).step_by(15).map(|t| at(t, a, (t - last_input).max(0))).collect()
    }

    #[test]
    fn idle_threshold_is_retroactive_and_never_counted_as_app_usage() {
        let mut t = tracker();
        // Input until t=90, then none: idle reaches 300 s at t=390. Input resumes at t=430.
        let mut samples = every(0, 90, "Code", 90);
        for s in samples.iter_mut() {
            s.idle_ms = 0;
        }
        samples.extend(every(105, 420, "Code", 90));
        samples.push(at(435, "Code", 5));
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 90), (Kind::Idle, None, 90, 430)]);
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 430_000)));
    }

    #[test]
    fn below_threshold_inactivity_stays_active() {
        let mut t = tracker();
        let mut samples = every(0, 210, "Code", 0); // 210 s without input: under 300 s
        samples.push(at(225, "Code", 2));
        let closed = run(&mut t, &samples);
        assert!(closed.is_empty());
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms, o.end_ms)), Some((Kind::Active, 0, 225_000)));
    }

    #[test]
    fn screen_lock_seen_only_by_polling_is_unobserved_and_unlock_resumes() {
        let mut t = tracker();
        let mut locked = at(30, "Code", 10);
        locked.locked = true;
        let mut still = at(45, "Code", 25);
        still.locked = true;
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), locked, still]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 15)], "ends at the last observable sample");
        assert_eq!(t.last_gap, Some((15_000, 45_000)), "shown as not recorded while it lasts");
        assert!(run(&mut t, &[at(60, "Code", 0)]).is_empty());
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 60_000)));
        assert_eq!(t.last_gap, Some((15_000, 60_000)), "neither active nor idle while locked");
    }

    #[test]
    fn sleep_closes_at_the_last_sample_and_does_not_count_the_gap() {
        let mut t = tracker();
        let mut after_wake = at(3_615, "Code", 0);
        after_wake.mono_ms = 45_000; // monotonic clock did not advance during sleep
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(30, "Code", 0), after_wake]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 30)]);
        assert_eq!(t.open.as_ref().map(|o| o.start_ms), Some(3_615_000), "new interval after wake");
        assert_eq!(t.last_gap, Some((30_000, 3_615_000)), "the sleep is reported as unobserved");
    }

    #[test]
    fn clock_changes_and_stalls_close_the_interval() {
        // Wall clock set back an hour.
        let mut t = tracker();
        let mut back = at(45, "Code", 0);
        back.wall_ms -= 3_600_000;
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(30, "Code", 0), back]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 30)]);
        // Process stalled for 5 minutes with both clocks advancing (e.g. App Nap).
        let mut t = tracker();
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(315, "Code", 0)]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 15)]);
    }

    #[test]
    fn long_intervals_split_only_while_input_is_recent() {
        let mut t = tracker();
        let samples: Vec<_> = (0..=61).map(|i| at(i * S / 1000, "Code", 0)).collect(); // 0..915 s
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 900)]);
        assert_eq!(t.open.as_ref().map(|o| o.start_ms), Some(900_000));
    }

    #[test]
    fn no_foreground_app_attributes_nothing() {
        let mut t = tracker();
        let mut none = at(30, "Code", 0);
        none.app = None;
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), none.clone(), at(45, "Safari", 0)]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 30)]);
        assert_eq!(t.open.as_ref().map(|o| o.start_ms), Some(45_000));
    }

    #[test]
    fn stop_without_samples_or_with_empty_interval_returns_nothing() {
        let mut t = tracker();
        assert!(t.stop(1_000).is_empty());
        t.sample(&at(10, "Code", 0));
        assert!(t.stop(10_000).is_empty(), "zero-length interval dropped");
    }

    #[test]
    fn idle_recovery_starts_activity_at_the_first_input() {
        let mut t = tracker();
        // Idle from 0 s; input resumes at 342 s and is first seen at the 345 s sample.
        let mut samples: Vec<_> = (0..=330).step_by(15).map(|s| at(s, "Code", 400 + s)).collect();
        samples.push(at(345, "Code", 3));
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Idle, None, 0, 342)]);
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 342_000)), "exact, not rounded to the sample");
    }

    #[test]
    fn locked_screen_never_counts_as_app_usage_even_with_recent_input() {
        let mut t = tracker();
        let mut samples = vec![at(0, "Code", 0), at(15, "Code", 0)];
        for s in (30..=120).step_by(15) {
            let mut l = at(s, "loginwindow", 0); // input at the lock screen (typing the password)
            l.locked = true;
            samples.push(l);
        }
        samples.push(at(135, "Code", 0));
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 15)]);
        assert!(t.open.as_ref().is_some_and(|o| o.start_ms == 135_000 && o.app == app("Code")), "never loginwindow");
    }

    // ---- OS transitions (session_events): injected like the OS would deliver them ----------

    #[test]
    fn lock_event_closes_at_the_lock_not_the_next_sample_and_unlock_resumes() {
        let mut t = tracker();
        run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0)]);
        let closed = t.interrupt(22_000); // locked 7 s after the last sample
        assert_eq!(closed.iter().map(|i| (i.kind, i.start_ms, i.end_ms)).collect::<Vec<_>>(), [(Kind::Active, 0, 22_000)]);
        let mut locked = at(30, "loginwindow", 0); // typing the password: input, but locked
        locked.locked = true;
        assert!(run(&mut t, &[locked]).is_empty() && t.open.is_none());
        assert!(run(&mut t, &[at(31, "Code", 0)]).is_empty(), "unlock: sampled right away");
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 31_000)));
        assert_eq!(t.last_gap, Some((22_000, 31_000)), "the locked stretch is neither active nor idle");
    }

    #[test]
    fn a_transition_never_extends_activity_past_the_idle_threshold_or_one_sample() {
        let mut t = tracker();
        // Last input at 0; sample at 285 s (idle 285 s < 300 s, still active); locked at 299 s.
        run(&mut t, &every(0, 285, "Code", 0));
        let closed = t.interrupt(299_000);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 299)]);
        let mut t = tracker();
        run(&mut t, &every(0, 285, "Code", 0));
        let closed = t.interrupt(320_000); // late delivery: never past input + threshold (300 s)
        assert_eq!(closed[0].end_ms, 300_000);
        let mut t = tracker();
        run(&mut t, &[at(0, "Code", 0)]);
        assert_eq!(t.interrupt(3_600_000)[0].end_ms, 15_000, "at most one sample period past the last sample");
        assert!(tracker().interrupt(1_000).is_empty(), "nothing observed yet");
    }

    #[test]
    fn sleep_event_with_a_wall_clock_jump_records_nothing_while_asleep() {
        let mut t = tracker();
        run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0)]);
        let closed = t.interrupt(20_000); // WillSleep
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 20)]);
        // Woke an hour later: the wall clock jumped, the monotonic one did not move. The screen is
        // locked at wake, then unlocked.
        let mut wake = at(3_620, "loginwindow", 3_600);
        wake.mono_ms = 20_000;
        wake.locked = true;
        let mut unlocked = at(3_650, "Code", 1);
        unlocked.mono_ms = 50_000;
        assert!(run(&mut t, &[wake, unlocked]).is_empty());
        assert_eq!(t.last_gap, Some((20_000, 3_650_000)));
        assert_eq!(t.open.as_ref().map(|o| o.start_ms), Some(3_650_000));
    }

    #[test]
    fn user_switch_is_unobserved_even_though_input_continues() {
        let mut t = tracker();
        run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0)]);
        let closed = t.interrupt(16_000); // SessionResigned: another user switched in
        assert_eq!(closed[0].end_ms, 16_000);
        // The other user types: the idle counter is fresh, the CGSession is off console.
        let away: Vec<_> = (30..=600).step_by(15).map(|s| Sample { locked: true, ..at(s, "Safari", 0) }).collect();
        assert!(run(&mut t, &away).is_empty() && t.open.is_none() && t.held.is_empty());
        assert!(run(&mut t, &[at(615, "Code", 2)]).is_empty());
        assert_eq!(t.last_gap, Some((16_000, 615_000)));
    }

    #[test]
    fn rapid_lock_unlock_toggles_never_overlap_or_double_count() {
        let mut t = tracker();
        let mut closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0)]);
        for k in 0..20 {
            closed.extend(t.interrupt(15_000 + k * 100)); // lock … unlock … lock within a second
            closed.extend(t.interrupt(15_050 + k * 100));
        }
        closed.extend(run(&mut t, &[at(18, "Code", 0), at(33, "Code", 0)]));
        closed.extend(t.interrupt(34_000));
        closed.extend(t.interrupt(34_000));
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 15), (Kind::Active, Some("Code".into()), 18, 34)]);
        assert!(closed.windows(2).all(|w| w[1].start_ms >= w[0].end_ms));
    }

    // ---- Automatic foreground switches (an app comes to the front without input) ----------

    fn active_ms(v: &[Interval]) -> i64 {
        v.iter().filter(|i| i.kind == Kind::Active).map(|i| i.end_ms - i.start_ms).sum()
    }
    /// Input until 90 s, then none: Code until `switch_at`, then `next` comes to the front by itself.
    fn walked_away(switch_at: i64, next: &str, until: i64) -> Vec<Sample> {
        (0..=until).step_by(15).map(|t| at(t, if t >= switch_at { next } else { "Code" }, (t - 90).max(0))).collect()
    }

    #[test]
    fn a_automatic_switch_after_input_stops_does_not_extend_active_time() {
        let mut t = tracker();
        // Mail comes to the front at ~142.5 s, 52.5 s after the last input. Before the fix Code was
        // closed (and uploaded) at 142.5 s and idle could only reach back to there.
        let mut samples = walked_away(150, "Mail", 420);
        let first = run(&mut t, &samples[..=10]); // through the 150 s sample
        assert!(first.is_empty(), "the switch alone releases nothing");
        assert_eq!(summary(&t.held), vec![(Kind::Active, Some("Code".into()), 0, 142)], "held: no input since it ended");
        assert_eq!(samples[10].idle_ms, 60_000, "the switch sample still carries the system idle time");
        samples.push(at(435, "Mail", 5)); // input again at 430
        let closed = [first, run(&mut t, &samples[11..])].concat();
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 90), (Kind::Idle, None, 90, 430)]);
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 430_000)));
        assert!(t.held.is_empty());
        // Identical to the same morning without the automatic switch.
        let mut plain = tracker();
        let mut same = walked_away(i64::MAX, "Code", 420);
        same.push(at(435, "Code", 5));
        assert_eq!(summary(&run(&mut plain, &same)), summary(&closed));
    }

    #[test]
    fn b_switches_during_established_idle_create_no_active_time() {
        let mut t = tracker();
        let apps = ["Code", "Mail", "Safari", "Slack"];
        // Last input at 0 s; apps keep changing by themselves; input again at 612 s.
        let mut samples: Vec<_> = (0..=600).step_by(15).map(|s| at(s, apps[(s / 15 % 4) as usize], s)).collect();
        samples.push(at(615, "Slack", 3));
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Idle, None, 0, 612)], "no active interval from switches alone");
        assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Active, 612_000)));
    }

    #[test]
    fn c_switches_with_input_or_before_the_threshold_keep_midpoint_attribution() {
        // A switch the user made: released at the next sample with input, boundary unchanged.
        let mut t = tracker();
        assert!(run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(30, "Safari", 12)]).is_empty(), "input at 18 s, before the 22.5 s midpoint");
        let closed = run(&mut t, &[at(45, "Safari", 1)]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 22)]);
        assert_eq!(closed[0].end_ms, 22_500, "midpoint kept");
        // An automatic switch, then the user is back before the threshold: present all along, so
        // both apps keep their time exactly as before the fix.
        let mut t = tracker();
        let mut samples = walked_away(150, "Mail", 195);
        samples.push(at(210, "Mail", 4));
        let closed = run(&mut t, &samples);
        assert_eq!(closed.iter().map(|i| (i.app.as_ref().unwrap().name.as_str(), i.start_ms, i.end_ms)).collect::<Vec<_>>(), [("Code", 0, 142_500)]);
        assert_eq!(t.open.as_ref().map(|o| (o.start_ms, o.end_ms)), Some((142_500, 210_000)));
        assert!(samples.iter().all(|s| s.idle_ms >= 0) && samples[10].idle_ms == 60_000, "no input inferred from the switch");
    }

    #[test]
    fn d_real_input_after_idle_resumes_at_the_input_without_overlap() {
        let mut t = tracker();
        let mut samples = walked_away(150, "Mail", 510);
        samples.push(at(525, "Safari", 13)); // input at 512 s, seen at 525 s
        let closed = run(&mut t, &samples);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 90), (Kind::Idle, None, 90, 512)]);
        let open = t.open.as_ref().unwrap();
        assert_eq!((open.kind, open.start_ms, open.app.as_ref().unwrap().name.as_str()), (Kind::Active, 512_000, "Safari"));
        assert_eq!(closed[1].end_ms, open.start_ms, "contiguous: no gap, no overlap");
    }

    #[test]
    fn e_threshold_boundary_with_jitter_splits_exactly_at_the_last_input() {
        for (last, after) in [(299_900, 315_100), (299_999, 300_000)] {
            let mut t = tracker();
            let s = |ms: i64, app: &str| Sample { wall_ms: ms, mono_ms: ms, app: app_named(app), idle_ms: (ms - 90_000).max(0), locked: false };
            let mut samples: Vec<_> = (0..=7).map(|i| s(i * 15_000 - 100 * (i % 3), "Code")).collect(); // jittered, input through 90 s
            for ms in (120_000..90_000 + last).step_by(15_000) {
                samples.push(s(ms, "Code"));
            }
            samples.push(s(90_000 + last, "Mail")); // automatic switch just before the threshold
            samples.push(s(90_000 + after, "Mail")); // at or just past it
            let closed = run(&mut t, &samples);
            assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 90)], "last {last}");
            assert_eq!(closed[0].end_ms, 90_000);
            assert_eq!(t.open.as_ref().map(|o| (o.kind, o.start_ms)), Some((Kind::Idle, 90_000)), "idle from the last input, not the switch");
            assert!(t.held.is_empty());
        }
    }

    #[test]
    fn f_sleep_or_clock_change_after_a_switch_counts_no_gap_and_no_more_than_without_it() {
        for jump in ["sleep", "clock back"] {
            let mut t = tracker();
            let mut samples = walked_away(150, "Mail", 165);
            let mut after = at(165 + 3_600, "Mail", 3_600);
            if jump == "sleep" {
                after.mono_ms = 180_000; // monotonic clock stopped while asleep
            } else {
                after.wall_ms = 120_000; // wall clock set back
                after.mono_ms = 180_000;
            }
            samples.push(after);
            let closed = run(&mut t, &samples);
            // Nothing past the last trustworthy sample (165 s); the threshold was never reached while
            // observed, so the total is what it is without the switch (Code 0–165 s).
            assert!(closed.iter().all(|i| i.end_ms <= 165_000 && i.end_ms > i.start_ms), "{jump}");
            assert_eq!(active_ms(&closed), 165_000, "{jump}");
            assert_eq!(t.last_gap.map(|g| g.0), Some(165_000), "{jump}: reported as unobserved");
            assert!(t.held.is_empty(), "{jump}");
        }
    }

    #[test]
    fn g_break_or_clock_out_while_held_releases_once_and_nothing_restarts() {
        let mut t = tracker();
        run(&mut t, &walked_away(150, "Mail", 180));
        assert_eq!(t.held.len(), 1);
        let closed = t.stop(185_000);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 142), (Kind::Active, Some("Mail".into()), 142, 185)]);
        assert!(t.held.is_empty() && t.open.is_none());
        assert!(t.stop(200_000).is_empty(), "nothing left to release twice");
        // While paused the collector takes no samples at all (see collector tests).
    }

    #[test]
    fn h_missing_or_invalid_idle_readings_attribute_nothing() {
        let mut t = tracker();
        let mut bad = at(45, "Mail", 0);
        bad.idle_ms = -1;
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(30, "Code", 0), bad]);
        assert_eq!(summary(&closed), vec![(Kind::Active, Some("Code".into()), 0, 30)], "ends at the last valid sample");
        assert_eq!(t.last_gap, Some((30_000, 45_000)), "unobserved, not active");
        assert!(t.open.is_none());
        assert_eq!(run(&mut t, &[at(60, "Mail", 0)]), vec![]);
        assert_eq!(t.open.as_ref().map(|o| o.start_ms), Some(60_000), "fresh start at the next valid sample");
        // While held: released as observed, nothing added.
        let mut t = tracker();
        let mut samples = walked_away(150, "Mail", 165);
        let mut bad = at(180, "Mail", 0);
        bad.idle_ms = -1;
        samples.push(bad);
        let closed = run(&mut t, &samples);
        assert_eq!(active_ms(&closed), 165_000);
        // An inconsistent jump of the counter can only make time idle, never active.
        let mut t = tracker();
        let closed = run(&mut t, &[at(0, "Code", 0), at(15, "Code", 0), at(30, "Code", 10_000)]);
        assert_eq!(active_ms(&closed), 0);
    }

    #[test]
    fn automatic_switches_never_change_total_active_time() {
        // The same timeline twice: once with apps coming to the front by themselves while nobody
        // touches the computer, once without. Totals must match; only per-app attribution differs.
        let apps = ["Code", "Safari", "Mail", "Slack"];
        let mut rng = Lcg(7);
        let (mut with, mut without) = (tracker(), tracker());
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let (mut wall, mut mono, mut last_input) = (1_700_000_000_000_i64, 0_i64, 1_700_000_000_000_i64);
        let (mut front, mut used, mut away, mut locked) = (0, 0, 0_i64, false);
        for _ in 0..50_000 {
            let step = 15_000 + rng.next(400) as i64 - 200;
            wall += step;
            mono += step;
            match rng.next(1000) {
                0..=2 => wall += 60_000 + rng.next(3_600_000) as i64, // sleep
                3..=4 => locked = !locked,
                5..=40 => away = wall + rng.next(900_000) as i64, // walks away for up to 15 min
                _ => {}
            }
            if wall >= away && rng.next(10) < 7 {
                last_input = wall - rng.next(step as u64) as i64;
                if rng.next(20) == 0 {
                    front = rng.next(4) as usize; // the user switches apps
                }
                used = front;
            } else if rng.next(15) == 0 {
                front = rng.next(4) as usize; // an app comes to the front by itself
            }
            let s = |app: usize| Sample { wall_ms: wall, mono_ms: mono, app: app_named(apps[app]), idle_ms: wall - last_input, locked };
            a.extend(with.sample(&s(front)));
            b.extend(without.sample(&s(if wall - last_input < step { front } else { used })));
        }
        a.extend(with.stop(wall));
        b.extend(without.stop(wall));
        for v in [&a, &b] {
            assert!(v.windows(2).all(|w| w[1].start_ms >= w[0].end_ms && w[0].end_ms > w[0].start_ms), "chronological, non-empty");
        }
        assert_eq!(active_ms(&a), active_ms(&b), "automatic switches add no active time");
        assert!(a.len() > b.len(), "the switches were exercised ({} vs {} intervals)", a.len(), b.len());
    }

    /// Deterministic pseudo-random generator (no dependency).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, n: u64) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) % n
        }
    }

    #[test]
    fn a_long_random_workday_never_overlaps_counts_gaps_or_exceeds_observed_time() {
        // 100,000 samples (~17 days of 15 s samples) with app switches, idle spells, locks, sleeps,
        // clock jumps and sampling jitter.
        let mut rng = Lcg(42);
        let mut t = tracker();
        let (mut wall, mut mono, mut last_input) = (1_700_000_000_000_i64, 0_i64, 1_700_000_000_000_i64);
        let apps = ["Code", "Safari", "Mail", "Slack"];
        let (mut app, mut locked) = (0, false);
        let mut gaps = Vec::new();
        let mut closed = Vec::new();
        for _ in 0..100_000 {
            let step = 15_000 + rng.next(400) as i64 - 200; // ±200 ms jitter
            wall += step;
            mono += step;
            match rng.next(1000) {
                0..=2 => {
                    let sleep = 60_000 + rng.next(3_600_000) as i64; // sleep: monotonic clock stops
                    gaps.push((wall - step, wall + sleep));
                    wall += sleep;
                }
                3 => wall += 600_000, // wall clock set forward 10 min
                4..=60 => app = rng.next(4) as usize,
                61..=63 => locked = !locked,
                _ => {}
            }
            if rng.next(10) < 7 {
                last_input = wall - rng.next(step as u64) as i64;
            }
            let s = Sample { wall_ms: wall, mono_ms: mono, app: app_named(apps[app]), idle_ms: wall - last_input, locked };
            closed.extend(t.sample(&s));
        }
        closed.extend(t.stop(wall));
        let mut prev_end = i64::MIN;
        let mut total = 0;
        for i in &closed {
            assert!(i.end_ms > i.start_ms, "non-empty");
            assert!(i.start_ms >= prev_end, "chronological, never overlapping");
            assert_eq!(i.kind == Kind::Idle, i.app.is_none(), "idle carries no app");
            // Split at the first sample with recent input after 15 min; a quieter stretch turns idle within 5 min.
            assert!(i.end_ms - i.start_ms <= 21 * 60_000 || i.kind == Kind::Idle, "active intervals are split regularly");
            for (gs, ge) in &gaps {
                assert!(i.end_ms <= *gs + 1 || i.start_ms >= *ge - 1, "nothing recorded across a sleep gap");
            }
            prev_end = i.end_ms;
            total += i.end_ms - i.start_ms;
        }
        let span = closed.last().unwrap().end_ms - closed[0].start_ms;
        let slept: i64 = gaps.iter().map(|(s, e)| e - s).sum();
        assert!(total <= span - slept, "never more than the observed time");
        assert!(closed.len() > 1_000, "a busy dataset: {} intervals", closed.len());
    }

    fn app_named(name: &str) -> Option<App> {
        Some(App { id: Some(format!("com.example.{name}")), name: name.into() })
    }

    #[test]
    fn excluded_app_in_front_is_never_idle_and_survives_a_later_idle_stretch() {
        let ex = vec!["COM.EXAMPLE.ZOOM".to_string()];
        assert!(idle_excluded(app("Zoom").as_ref(), &ex), "case-insensitive identifier match");
        assert!(!idle_excluded(app("Code").as_ref(), &ex));
        assert!(!idle_excluded(Some(&App { id: None, name: "com.example.Zoom".into() }), &ex), "identifier only, never the name");
        assert!(!idle_excluded(None, &ex));

        let mut cfg = Config::new(15, 300);
        cfg.idle_excluded_apps = ex;
        let mut t = Tracker::new(cfg);
        // Last input at t=0; a call in Zoom from 15 s to 900 s with no keyboard/mouse input, then the
        // desktop (Finder) is left untouched until the idle threshold is long past.
        let mut samples = vec![at(0, "Code", 0)];
        samples.extend(every(15, 900, "Zoom", 0));
        samples.extend(every(915, 1500, "Finder", 0));
        let mut v = run(&mut t, &samples);
        v.extend(t.stop(1_500_000));
        let sum = summary(&v);
        assert!(sum.iter().any(|(k, a, s, e)| *k == Kind::Active && a.as_deref() == Some("Zoom") && *s <= 15 && *e >= 900), "the call counts as active: {sum:?}");
        assert!(sum.iter().all(|(k, a, _, _)| *k == Kind::Active || a.is_none()));
        assert!(sum.iter().any(|(k, _, _, e)| *k == Kind::Idle && *e >= 1485), "idle after leaving the call: {sum:?}");
        // Without the exclusion the same samples are idle from t=300.
        let mut plain = Tracker::new(Config::new(15, 300));
        let mut w = run(&mut plain, &samples);
        w.extend(plain.stop(1_500_000));
        assert!(summary(&w).iter().all(|(k, a, _, e)| *k == Kind::Idle || a.as_deref() != Some("Zoom") || *e <= 300));
    }
}
