//! App Nap opt-out (Windows: EcoQoS throttling opt-out) while activity monitoring is ACTIVE, so the
//! OS does not throttle the collector's timer when the window is hidden. macOS:
//! `NSActivityUserInitiatedAllowingIdleSystemSleep` only. Neither keeps the computer or its displays awake. Released as soon as monitoring stops or pauses.

use std::sync::Mutex;

/// At most one activity at a time; `set` is idempotent. Dropping the token ends the activity.
pub struct Hold<T> {
    token: Option<T>,
}

impl<T> Hold<T> {
    pub const fn new() -> Self {
        Hold { token: None }
    }

    /// Begins (once) or ends (once) the activity; returns whether it is held.
    pub fn set(&mut self, on: bool, begin: impl FnOnce() -> T) -> bool {
        if on && self.token.is_none() {
            self.token = Some(begin());
        } else if !on {
            self.token = None;
        }
        self.token.is_some()
    }
}

static APP_NAP: Mutex<Hold<imp::Token>> = Mutex::new(Hold::new());

/// Opts out of App Nap while `monitoring` is true. Returns whether the opt-out is in force.
pub fn prevent_app_nap(monitoring: bool) -> bool {
    APP_NAP.lock().map(|mut h| h.set(monitoring, imp::begin)).unwrap_or(false)
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    pub struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // SAFETY: the activity token is an opaque immutable object; NSProcessInfo's begin/end activity
    // methods are thread-safe, and the token is only passed back to `endActivity:`.
    unsafe impl Send for Token {}

    pub fn begin() -> Token {
        let reason = NSString::from_str("Recording activity while clocked in (Insight Workfolio)");
        Token(NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason))
    }

    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: the token came from beginActivityWithOptions:reason: and is ended exactly once.
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
        }
    }
}

/// `PROCESS_POWER_THROTTLING_STATE` masks (ControlMask, StateMask) for EXECUTION_SPEED (= 1):
/// while held, the control bit is set and the state bit clear (throttling explicitly off); released,
/// both clear (Windows decides again, the default).
#[cfg_attr(not(windows), allow(dead_code))]
pub const fn throttling_masks(held: bool) -> (u32, u32) {
    const EXECUTION_SPEED: u32 = 1;
    if held { (EXECUTION_SPEED, 0) } else { (0, 0) }
}

/// Windows: opts the process out of EcoQoS execution-speed throttling ("Efficiency mode") while
/// recording, so the collector's timer keeps its period when the window is hidden. Never touches
/// SetThreadExecutionState: sleep and display sleep are unaffected. `appNapPrevented` in the status
/// means "background throttling disabled" here.
#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_STATE};

    pub struct Token;

    fn apply(held: bool) {
        let (control, state) = super::throttling_masks(held);
        let s = PROCESS_POWER_THROTTLING_STATE { Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION, ControlMask: control, StateMask: state };
        // SAFETY: valid pseudo-handle and a correctly sized, initialised struct. Failure (older
        // Windows without the class) only means the default policy stays in force.
        let ok = unsafe { SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, (&raw const s).cast(), size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32) };
        if ok == 0 {
            eprintln!("[power] SetProcessInformation(ProcessPowerThrottling) failed");
        }
    }

    pub fn begin() -> Token {
        apply(true);
        Token
    }

    impl Drop for Token {
        fn drop(&mut self) {
            apply(false);
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub struct Token;
    pub fn begin() -> Token {
        Token
    }
}

#[cfg(test)]
mod tests {
    use super::Hold;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static BEGUN: AtomicUsize = AtomicUsize::new(0);
    static ENDED: AtomicUsize = AtomicUsize::new(0);
    struct Fake;
    impl Drop for Fake {
        fn drop(&mut self) {
            ENDED.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn begin() -> Fake {
        BEGUN.fetch_add(1, Ordering::SeqCst);
        Fake
    }
    fn counts() -> (usize, usize) {
        (BEGUN.load(Ordering::SeqCst), ENDED.load(Ordering::SeqCst))
    }

    #[test]
    fn windows_throttling_opt_out_masks() {
        assert_eq!(super::throttling_masks(true), (1, 0), "control EXECUTION_SPEED, state off = never throttled");
        assert_eq!(super::throttling_masks(false), (0, 0), "released: the system decides");
        #[cfg(windows)]
        assert_eq!(windows_sys::Win32::System::Threading::PROCESS_POWER_THROTTLING_EXECUTION_SPEED, 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_throttling_opt_out_applies_and_restores() {
        let mut h = Hold::new();
        assert!(h.set(true, super::imp::begin));
        assert!(!h.set(false, super::imp::begin));
    }

    #[test]
    fn begins_once_ends_once_and_is_idempotent() {
        let mut h = Hold::new();
        assert!(!h.set(false, begin), "stopping while not held does nothing");
        assert_eq!(counts(), (0, 0));
        assert!(h.set(true, begin) && h.set(true, begin) && h.set(true, begin));
        assert_eq!(counts(), (1, 0), "one activity however often ACTIVE is re-applied");
        assert!(!h.set(false, begin) && !h.set(false, begin));
        assert_eq!(counts(), (1, 1), "ended exactly once");
        assert!(h.set(true, begin));
        drop(h);
        assert_eq!(counts(), (2, 2), "a new activity after resuming; dropped with the holder");
    }
}
