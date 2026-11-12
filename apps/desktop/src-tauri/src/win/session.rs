//! Windows session and power notifications → `session_events`: lock/unlock, fast user switching,
//! Remote Desktop connect/disconnect, logon/logoff, suspend/resume. A dedicated thread owns a
//! message-only window and its message loop. As on macOS the polled state (input desktop, console
//! session; `activity::platform`) stays the authority, so a missed notification never sticks.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::session_events::Event;

// Win32 values (WinUser.h / WtsApi32.h), so the mapping is testable on every host; a Windows test
// checks them against windows-sys.
pub const WM_POWERBROADCAST: u32 = 0x0218;
pub const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
pub const PBT_APMSUSPEND: u32 = 4;
pub const PBT_APMRESUMESUSPEND: u32 = 7;
pub const PBT_APMRESUMEAUTOMATIC: u32 = 18;
pub const PBT_POWERSETTINGCHANGE: u32 = 0x8013;
pub const WTS_CONSOLE_CONNECT: u32 = 1;
pub const WTS_CONSOLE_DISCONNECT: u32 = 2;
pub const WTS_REMOTE_CONNECT: u32 = 3;
pub const WTS_REMOTE_DISCONNECT: u32 = 4;
pub const WTS_SESSION_LOGON: u32 = 5;
pub const WTS_SESSION_LOGOFF: u32 = 6;
pub const WTS_SESSION_LOCK: u32 = 7;
pub const WTS_SESSION_UNLOCK: u32 = 8;

/// The `session_events` transition for a window message, if any. Resume arrives as
/// RESUMEAUTOMATIC and, after user input, RESUMESUSPEND too: both are DidWake (idempotent).
pub fn event_for(msg: u32, wparam: usize) -> Option<Event> {
    let w = u32::try_from(wparam).ok()?;
    match (msg, w) {
        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(Event::Locked),
        (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => Some(Event::Unlocked),
        (WM_WTSSESSION_CHANGE, WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOGOFF) => Some(Event::SessionResigned),
        (WM_WTSSESSION_CHANGE, WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT | WTS_SESSION_LOGON) => Some(Event::SessionActive),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(Event::WillSleep),
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) => Some(Event::DidWake),
        _ => None,
    }
}

/// `GUID_CONSOLE_DISPLAY_STATE` data: 0 = display off, 1 = on, 2 = dimmed (still showing).
/// Anything else is unknown and changes nothing.
pub fn display_event(state: u32) -> Option<Event> {
    match state {
        0 => Some(Event::ScreensSlept),
        1 | 2 => Some(Event::ScreensWoke),
        _ => None,
    }
}

#[cfg(windows)]
pub use imp::start;

#[cfg(windows)]
mod imp {
    use crate::session_events::publish;
    use std::sync::mpsc::sync_channel;
    use std::thread::JoinHandle;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Power::{
        RegisterPowerSettingNotification, RegisterSuspendResumeNotification, UnregisterPowerSettingNotification, UnregisterSuspendResumeNotification, POWERBROADCAST_SETTING,
    };
    use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostThreadMessageW, RegisterClassW, UnregisterClassW, DEVICE_NOTIFY_WINDOW_HANDLE,
        HWND_MESSAGE, MSG, WM_POWERBROADCAST, WM_QUIT, WNDCLASSW,
    };

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if let Some(e) = super::event_for(msg, wparam) {
            publish(e);
        }
        if msg == WM_POWERBROADCAST {
            if wparam == super::PBT_POWERSETTINGCHANGE as usize && lparam != 0 {
                // SAFETY: for PBT_POWERSETTINGCHANGE lparam points to a POWERBROADCAST_SETTING valid
                // for this call; the display state is a DWORD in Data (checked by DataLength).
                let state = unsafe {
                    let s = lparam as *const POWERBROADCAST_SETTING;
                    let g = (&raw const (*s).PowerSetting).read_unaligned();
                    let same = (g.data1, g.data2, g.data3, g.data4)
                        == (GUID_CONSOLE_DISPLAY_STATE.data1, GUID_CONSOLE_DISPLAY_STATE.data2, GUID_CONSOLE_DISPLAY_STATE.data3, GUID_CONSOLE_DISPLAY_STATE.data4);
                    (same && (&raw const (*s).DataLength).read_unaligned() >= 4).then(|| (&raw const (*s).Data).cast::<u32>().read_unaligned())
                };
                if let Some(e) = state.and_then(super::display_event) {
                    publish(e);
                }
            }
            return 1; // TRUE: never deny a power request
        }
        // SAFETY: forwarding the unchanged arguments of a message for our own window.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// The running notification thread. `stop` ends its message loop and joins it (tests only: the
    /// app's thread lives as long as the process).
    #[cfg_attr(not(test), allow(dead_code))]
    pub struct Listener {
        thread_id: u32,
        join: JoinHandle<()>,
    }

    impl Listener {
        pub fn spawn() -> Result<Listener, String> {
            let (tx, rx) = sync_channel(1);
            let join = std::thread::Builder::new().name("session-events".into()).spawn(move || run(tx)).map_err(|e| e.to_string())?;
            let thread_id = rx.recv().map_err(|_| "session thread exited".to_string())??;
            Ok(Listener { thread_id, join })
        }

        #[cfg_attr(not(test), allow(dead_code))]
        pub fn stop(self) {
            // SAFETY: the thread has a message queue (it created a window before reporting its id).
            unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
            let _ = self.join.join();
        }
    }

    /// Starts the notification thread for the rest of the process (Tauri `setup`).
    pub fn start() {
        match Listener::spawn() {
            Ok(l) => std::mem::forget(l),
            Err(e) => eprintln!("[session] notifications unavailable, polling only: {e}"),
        }
    }

    fn run(ready: std::sync::mpsc::SyncSender<Result<u32, String>>) {
        let class: Vec<u16> = "InsightWorkfolioSessionEvents\0".encode_utf16().collect();
        // SAFETY: standard message-only window setup on this thread; everything registered here
        // is unregistered before the thread returns. Zeroed WNDCLASSW is valid (null/None fields).
        unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinstance, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
            if RegisterClassW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                let _ = ready.send(Err(format!("RegisterClassW failed: {}", GetLastError())));
                return;
            }
            let hwnd = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), hinstance, std::ptr::null());
            if hwnd.is_null() {
                let _ = ready.send(Err(format!("CreateWindowExW failed: {}", GetLastError())));
                UnregisterClassW(class.as_ptr(), hinstance);
                return;
            }
            // ponytail: no retry if the session service is not up yet at logon; the polled
            // lock/console checks still cover it. Retry on RPC_S_INVALID_BINDING if that shows up.
            let wts = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != 0;
            if !wts {
                eprintln!("[session] WTSRegisterSessionNotification failed: {}", GetLastError());
            }
            // Message-only windows get no broadcasts: power events need an explicit registration.
            let power = RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE);
            if power == 0 {
                eprintln!("[session] RegisterSuspendResumeNotification failed: {}", GetLastError());
            }
            // Display on/off (screenshots skip a dark display). Windows sends the current state
            // right after registering. Without it the display counts as on: capture never stops
            // because of a missing notification.
            let display = RegisterPowerSettingNotification(hwnd, &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
            if display == 0 {
                eprintln!("[session] RegisterPowerSettingNotification failed: {}", GetLastError());
            }
            let _ = ready.send(Ok(GetCurrentThreadId()));
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
            if wts {
                WTSUnRegisterSessionNotification(hwnd);
            }
            if power != 0 {
                UnregisterSuspendResumeNotification(power);
            }
            if display != 0 {
                UnregisterPowerSettingNotification(display);
            }
            DestroyWindow(hwnd);
            UnregisterClassW(class.as_ptr(), hinstance);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_and_power_messages_map_to_events() {
        let s = |w| event_for(WM_WTSSESSION_CHANGE, w);
        assert_eq!(s(7), Some(Event::Locked));
        assert_eq!(s(8), Some(Event::Unlocked));
        for w in [1, 3, 5] {
            assert_eq!(s(w), Some(Event::SessionActive), "connect/logon {w}");
        }
        for w in [2, 4, 6] {
            assert_eq!(s(w), Some(Event::SessionResigned), "disconnect/logoff {w}");
        }
        assert_eq!(s(9), None, "remote control: no change");
        let p = |w| event_for(WM_POWERBROADCAST, w);
        assert_eq!(p(4), Some(Event::WillSleep));
        assert_eq!(p(18), Some(Event::DidWake));
        assert_eq!(p(7), Some(Event::DidWake));
        assert_eq!(p(10), None, "power status change (battery/AC) is not a transition");
        assert_eq!(p(PBT_POWERSETTINGCHANGE as usize), None, "display state is read from the setting data, not the message");
        assert_eq!([display_event(0), display_event(1), display_event(2)], [Some(Event::ScreensSlept), Some(Event::ScreensWoke), Some(Event::ScreensWoke)], "off; on; dimmed is still showing");
        assert_eq!(display_event(3), None, "unknown state changes nothing: never 'asleep' by default");
        assert_eq!(event_for(0x0010, 7), None, "other messages ignored");
        assert_eq!(event_for(WM_WTSSESSION_CHANGE, usize::MAX), None);
    }

    #[cfg(windows)]
    #[test]
    fn constants_match_windows_sys() {
        use windows_sys::Win32::UI::WindowsAndMessaging as w;
        assert_eq!(
            [WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, PBT_APMSUSPEND, PBT_APMRESUMESUSPEND, PBT_APMRESUMEAUTOMATIC, PBT_POWERSETTINGCHANGE],
            [w::WM_POWERBROADCAST, w::WM_WTSSESSION_CHANGE, w::PBT_APMSUSPEND, w::PBT_APMRESUMESUSPEND, w::PBT_APMRESUMEAUTOMATIC, w::PBT_POWERSETTINGCHANGE]
        );
        assert_eq!(
            [WTS_CONSOLE_CONNECT, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_CONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOGON, WTS_SESSION_LOGOFF, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK],
            [w::WTS_CONSOLE_CONNECT, w::WTS_CONSOLE_DISCONNECT, w::WTS_REMOTE_CONNECT, w::WTS_REMOTE_DISCONNECT, w::WTS_SESSION_LOGON, w::WTS_SESSION_LOGOFF, w::WTS_SESSION_LOCK, w::WTS_SESSION_UNLOCK]
        );
    }

    #[cfg(windows)]
    #[test]
    fn notification_thread_starts_and_stops_cleanly() {
        for _ in 0..2 {
            imp::Listener::spawn().expect("session thread").stop();
        }
    }
}
