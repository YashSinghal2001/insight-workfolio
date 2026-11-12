//! Login-session lifecycle from macOS: screen lock/unlock, system sleep/wake, display sleep/wake
//! and fast user switching or logout (session resign/become active). Notifications give the exact
//! moment of each transition; the CGSession dictionary (`activity::platform`) stays the level check
//! and the fallback if a notification is missed. Nothing about the content of the session is read.
//!
//! Consumers: the activity collector (`subscribe` + `observable_now`) and, later, the screenshot
//! worker (`observable_now` before and after a capture).

use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Locked,
    Unlocked,
    WillSleep,
    DidWake,
    // Display off/on: informational on macOS; on Windows (console display state) it is what
    // stops screenshots of a dark display.
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    ScreensSlept,
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    ScreensWoke,
    /// Another user switched in (fast user switching) or this user is logging out.
    SessionResigned,
    SessionActive,
}

impl Event {
    /// From here on nothing may be attributed (ACTIVE or IDLE) until observation resumes.
    pub fn interrupts(self) -> bool {
        matches!(self, Event::Locked | Event::WillSleep | Event::SessionResigned)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub event: Event,
    /// Wall clock (Unix ms) when macOS delivered the notification.
    pub at_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub locked: bool,
    pub asleep: bool,
    /// Displays asleep (informational: input wakes them, the idle counter keeps running).
    pub display_asleep: bool,
    /// Another user's session is in front, or this user is logging out.
    pub session_inactive: bool,
    pub last_transition_ms: Option<i64>,
}

impl SessionState {
    pub fn apply(mut self, t: Transition) -> SessionState {
        match t.event {
            Event::Locked => self.locked = true,
            Event::Unlocked => self.locked = false,
            Event::WillSleep => self.asleep = true,
            Event::DidWake => self.asleep = false,
            Event::ScreensSlept => self.display_asleep = true,
            Event::ScreensWoke => self.display_asleep = false,
            Event::SessionResigned => self.session_inactive = true,
            Event::SessionActive => self.session_inactive = false,
        }
        self.last_transition_ms = Some(t.at_ms);
        self
    }

    #[cfg(test)]
    pub fn observable(&self) -> bool {
        !(self.locked || self.asleep || self.session_inactive)
    }
}

struct Shared {
    state: SessionState,
    /// Monotonic time of the last WillSleep. The monotonic clock stops during sleep, so if a minute
    /// of awake time has passed since, the Mac is awake even if DidWake was never delivered.
    asleep_at: Option<Instant>,
    subscribers: Vec<Sender<Transition>>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { state: SessionState { locked: false, asleep: false, display_asleep: false, session_inactive: false, last_transition_ms: None }, asleep_at: None, subscribers: Vec::new() });
const ASLEEP_SELF_HEAL: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Current snapshot (cheap: one uncontended lock).
pub fn current() -> SessionState {
    let Ok(s) = SHARED.lock() else { return SessionState::default() };
    let mut state = s.state;
    state.asleep &= s.asleep_at.is_some_and(|t| t.elapsed() < ASLEEP_SELF_HEAL);
    state
}

/// Every transition from now on, in order. Dropping the receiver unsubscribes.
pub fn subscribe() -> Receiver<Transition> {
    let (tx, rx) = channel();
    if let Ok(mut s) = SHARED.lock() {
        s.subscribers.push(tx);
    }
    rx
}

/// Records a transition and broadcasts it. Called by the macOS observers on the main thread; must
/// stay quick (no I/O, no sampling).
pub fn publish(event: Event) {
    let t = Transition { event, at_ms: now_ms() };
    let Ok(mut s) = SHARED.lock() else { return };
    s.state = s.state.apply(t);
    match event {
        Event::WillSleep => s.asleep_at = Some(Instant::now()),
        Event::DidWake => s.asleep_at = None,
        _ => {}
    }
    s.subscribers.retain(|tx| tx.send(t).is_ok());
    eprintln!("[session] {event:?}");
}

/// A lock notification counts on its own for this long, in case the CGSession flag lags behind it.
const LOCK_GRACE_MS: i64 = 5_000;

/// Whether this user's session can be observed right now: screen not locked, Mac not going to
/// sleep, this user's session in front. Event state for exact timing, the CGSession dictionary as
/// the level: a stale or missed unlock/become-active notification can never stop monitoring for good.
pub fn observable_now() -> bool {
    unobservable_now() == (false, false)
}

/// Why the session cannot be observed right now: (screen locked or secure desktop, away = going
/// to sleep or another user's session in front). The collector records the first as IDLE and
/// nothing for the second; `away` wins when both are set.
pub fn unobservable_now() -> (bool, bool) {
    use crate::activity::platform;
    let s = current();
    let recent = s.last_transition_ms.is_some_and(|t| now_ms() - t < LOCK_GRACE_MS);
    (platform::screen_locked() || (s.locked && recent), !platform::on_console() || s.asleep || (s.session_inactive && recent))
}

// ---- macOS observers -----------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::{publish, Event};
    use objc2::rc::Retained;
    use objc2::runtime::NSObjectProtocol;
    use objc2::{define_class, msg_send, sel, AllocAnyThread};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification,
        NSWorkspaceSessionDidBecomeActiveNotification, NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationSuspensionBehavior, NSObject, NSString};

    const LOCKED: &str = "com.apple.screenIsLocked";
    const UNLOCKED: &str = "com.apple.screenIsUnlocked";

    fn workspace_events() -> [(&'static NSString, Event); 6] {
        // SAFETY: AppKit's notification-name constants are immutable, valid for the process lifetime.
        unsafe {
            [
                (NSWorkspaceWillSleepNotification, Event::WillSleep),
                (NSWorkspaceDidWakeNotification, Event::DidWake),
                (NSWorkspaceScreensDidSleepNotification, Event::ScreensSlept),
                (NSWorkspaceScreensDidWakeNotification, Event::ScreensWoke),
                (NSWorkspaceSessionDidResignActiveNotification, Event::SessionResigned),
                (NSWorkspaceSessionDidBecomeActiveNotification, Event::SessionActive),
            ]
        }
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; Observer has no Drop and no ivars.
        #[unsafe(super(NSObject))]
        #[name = "WFSessionObserver"]
        struct Observer;

        // SAFETY: NSObjectProtocol has no safety requirements.
        unsafe impl NSObjectProtocol for Observer {}

        impl Observer {
            // SAFETY: the signature matches a notification selector.
            #[unsafe(method(notified:))]
            fn notified(&self, n: &NSNotification) {
                let name = n.name();
                let event = match name.to_string().as_str() {
                    LOCKED => Some(Event::Locked),
                    UNLOCKED => Some(Event::Unlocked),
                    _ => workspace_events().into_iter().find(|(n, _)| **n == *name).map(|(_, e)| e),
                };
                if let Some(e) = event {
                    publish(e);
                }
            }
        }
    );

    /// Registers the observers. Call once, from the main thread (Tauri `setup`): AppKit delivers
    /// these on the main run loop. The observer lives for the rest of the process.
    pub fn start() {
        let observer: Retained<Observer> = unsafe { msg_send![Observer::alloc(), init] };
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        for (name, _) in workspace_events() {
            // SAFETY: `observer` responds to `notified:` and is never deallocated (leaked below).
            unsafe { workspace.addObserver_selector_name_object(&observer, sel!(notified:), Some(name), None) };
        }
        // AppKit suspends distributed notifications while the app is in the background unless
        // asked to deliver immediately; the lock state matters most exactly then.
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        for name in [LOCKED, UNLOCKED] {
            unsafe {
                distributed.addObserver_selector_name_object_suspensionBehavior(
                    &observer,
                    sel!(notified:),
                    Some(&NSString::from_str(name)),
                    None,
                    NSNotificationSuspensionBehavior::DeliverImmediately,
                )
            };
        }
        // Notification centers do not retain selector-based observers.
        std::mem::forget(observer);
    }
}

// Windows: WTS session + suspend/resume notifications on a message-only window thread.
// `observable_now` combines them with the polled input-desktop/console checks exactly as on macOS.
#[cfg(windows)]
mod imp {
    pub use crate::win::session::start;
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn start() {}
}

pub use imp::start;

#[cfg(test)]
mod tests {
    use super::*;

    fn t(event: Event, at_ms: i64) -> Transition {
        Transition { event, at_ms }
    }

    #[test]
    fn transitions_update_the_snapshot_and_rapid_toggles_end_in_the_last_state() {
        let mut s = SessionState::default();
        assert!(s.observable());
        for (i, e) in [Event::Locked, Event::Unlocked, Event::Locked, Event::Unlocked, Event::Locked].into_iter().enumerate() {
            s = s.apply(t(e, i as i64));
        }
        assert!(s.locked && !s.observable());
        assert_eq!(s.last_transition_ms, Some(4));
        s = s.apply(t(Event::Unlocked, 5)).apply(t(Event::WillSleep, 6));
        assert!(s.asleep && !s.observable());
        s = s.apply(t(Event::DidWake, 7)).apply(t(Event::SessionResigned, 8));
        assert!(!s.asleep && s.session_inactive && !s.observable());
        s = s.apply(t(Event::SessionActive, 9)).apply(t(Event::ScreensSlept, 10));
        assert!(s.display_asleep && s.observable(), "display sleep alone is not unobserved: the idle counter covers it");
        assert!([Event::Locked, Event::WillSleep, Event::SessionResigned].iter().all(|e| e.interrupts()));
        assert!(![Event::Unlocked, Event::DidWake, Event::SessionActive, Event::ScreensSlept, Event::ScreensWoke].iter().any(|e| e.interrupts()));
    }

    #[test]
    fn subscribers_get_every_transition_in_order_and_dropped_ones_are_removed() {
        let a = subscribe();
        let b = subscribe();
        drop(b);
        publish(Event::ScreensSlept);
        publish(Event::ScreensWoke);
        let got: Vec<_> = a.try_iter().map(|t| t.event).collect();
        assert_eq!(got, [Event::ScreensSlept, Event::ScreensWoke]);
        assert!(!current().display_asleep && current().last_transition_ms.is_some());
        drop(a);
        publish(Event::ScreensWoke);
        assert!(SHARED.lock().unwrap().subscribers.is_empty(), "dropped receivers are pruned");
        // Same test (global state): a user switch stops observation at once, for the collector and
        // the screenshot worker alike (both call observable_now).
        publish(Event::SessionResigned);
        assert!(!observable_now(), "another user's session in front: nothing is observed or captured");
        publish(Event::SessionActive);
    }
}
