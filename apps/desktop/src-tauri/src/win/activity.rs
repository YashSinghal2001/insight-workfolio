//! Windows activity sampling: foreground app, input idle time, lock/secure desktop and whether this
//! user's session is the one in front. Same `Sample` fields as macOS; nothing else is read (no window
//! titles, no command lines, no input contents, no hooks).
//!
//! The pure decisions (name fallback, path normalisation, tick arithmetic, desktop name → locked,
//! console decision) are platform-independent and unit-tested on every host; the Win32 calls are
//! in the `#[cfg(windows)]` adapter below.
#![cfg_attr(not(windows), allow(dead_code))]

/// Name recorded when the foreground process cannot be opened (protected processes such as some
/// anti-malware or system services). Identifier is `None`: it is still ACTIVE time (the user is at
/// the keyboard), just not attributable to a named app. IDLE is decided by the idle counter as usual.
pub const PROTECTED_APP: &str = "Unknown app (protected)";

/// `applicationIdentifier`: the executable's file name only, lowercased (e.g. `chrome.exe`).
/// Never the full path: per-user installs live under `C:\Users\<name>\…`, so a path would send the
/// Windows user name to the server (data minimisation; matches the original docs/windows.md design).
pub fn identifier(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase()
}

/// `applicationName`: the version resource's FileDescription, else the executable's file stem.
pub fn display_name(description: Option<&str>, path: &str) -> String {
    let clean = |s: &str| s.trim_matches(|c: char| c.is_whitespace() || matches!(c, '\0' | '\u{200e}' | '\u{200f}')).to_string();
    if let Some(d) = description.map(clean).filter(|d| !d.is_empty()) {
        return d;
    }
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let stem = match file.rfind('.') {
        Some(i) if i > 0 => &file[..i],
        _ => file,
    };
    let stem = clean(stem);
    if stem.is_empty() { "Unknown app".into() } else { stem }
}

/// UWP / Store apps (Calculator, Settings) run inside a window of this host process.
pub const FRAME_HOST: &str = "applicationframehost.exe";

/// The process of the app hosted in an Application Frame Host window: the first child window owned
/// by another process. `None` (keep the host) while none is, e.g. a suspended or closing app.
pub fn hosted_app_pid(host_pid: u32, child_pids: &[u32]) -> Option<u32> {
    child_pids.iter().copied().find(|&p| p != 0 && p != host_pid)
}

/// Milliseconds since the last input. Both values are 32-bit `GetTickCount` ticks that wrap every
/// 49.7 days, so the difference is taken modulo 2^32. A "negative" difference (the last-input tick
/// read just after the current tick) means input happened right now: 0, never ~49 days.
pub fn idle_ms(now_tick: u32, last_input_tick: u32) -> u64 {
    let d = now_tick.wrapping_sub(last_input_tick);
    if d > i32::MAX as u32 { 0 } else { d as u64 }
}

/// `VerQueryValueW` sub-block for one language/code-page pair of the version resource.
pub fn description_subblock(lang: u16, codepage: u16) -> String {
    format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription")
}

/// Access denied while opening the input desktop (Win32 error 5).
pub const ACCESS_DENIED: u32 = 5;

/// Locked or on the secure desktop (lock screen, UAC prompt, Ctrl+Alt+Del): the input desktop is not
/// this session's "Default" desktop, or we may not even open it. Any other failure is unknown and
/// counts as unlocked, as on macOS, so a broken query never stops monitoring by itself (the session
/// events still cover the lock).
pub fn locked_from_input_desktop(name: Result<&str, u32>) -> bool {
    match name {
        Ok(n) => !n.eq_ignore_ascii_case("Default"),
        Err(code) => code == ACCESS_DENIED,
    }
}

/// This user's session is in front: it is the physical console session, or it is connected
/// (`WTSActive`, e.g. the user works over Remote Desktop). Fast user switching and an RDP
/// disconnect leave it disconnected → false. Unknown own session = true (never stops monitoring).
pub fn session_in_front(console_session: u32, own_session: Option<u32>, own_connected: Option<bool>) -> bool {
    own_session.is_none_or(|own| own == console_session || own_connected == Some(true))
}

#[cfg(windows)]
pub use imp::{frontmost, idle_ms_now, on_console, screen_locked};

#[cfg(windows)]
mod imp {
    use crate::activity::App;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows_sys::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSActive, WTSConnectState, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQuerySessionInformationW, WTS_CURRENT_SERVER_HANDLE,
        WTS_CURRENT_SESSION,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetForegroundWindow, GetWindowThreadProcessId};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Display names by lowercased executable path: version resources are read once per executable.
    // ponytail: unbounded, but keyed by installed executables (tens to hundreds); add an LRU if not.
    static NAMES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    /// Foreground window's process → executable path → identifier and display name. `None` while no
    /// window is in front (switching, secure desktop). Reads only the process ID and image path.
    pub fn frontmost() -> Option<App> {
        // SAFETY: plain Win32 queries with valid out-pointers.
        let (hwnd, pid) = unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            (hwnd, pid)
        };
        if pid == 0 {
            return None;
        }
        let Some(mut path) = exe_path(pid) else {
            return Some(App { id: None, name: super::PROTECTED_APP.into() });
        };
        if super::identifier(&path) == super::FRAME_HOST
            && let Some(hosted) = super::hosted_app_pid(pid, &child_pids(hwnd)).and_then(exe_path)
        {
            path = hosted;
        }
        let id = super::identifier(&path);
        let mut cache = NAMES.lock().ok()?;
        let name = cache.get_or_insert_with(HashMap::new).entry(path.clone()).or_insert_with(|| super::display_name(file_description(&path).as_deref(), &path)).clone();
        Some(App { id: Some(id), name })
    }

    /// Owning process IDs of a window's child windows (no titles or contents are read).
    fn child_pids(hwnd: HWND) -> Vec<u32> {
        unsafe extern "system" fn push(child: HWND, out: LPARAM) -> i32 {
            let mut pid = 0u32;
            // SAFETY: `out` is the &mut Vec passed below, alive for the whole EnumChildWindows call.
            unsafe {
                GetWindowThreadProcessId(child, &mut pid);
                (*(out as *mut Vec<u32>)).push(pid);
            }
            1
        }
        let mut pids = Vec::new();
        // SAFETY: the callback only writes to `pids`, which outlives this synchronous call.
        unsafe { EnumChildWindows(hwnd, Some(push), &mut pids as *mut Vec<u32> as LPARAM) };
        pids
    }

    fn exe_path(pid: u32) -> Option<String> {
        // SAFETY: the handle is checked and closed; the buffer length is passed in and updated.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 32_768];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(h);
            (ok && len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// FileDescription from the version resource: the languages it lists first, then en-US/Unicode.
    fn file_description(path: &str) -> Option<String> {
        let wpath = wide(path);
        // SAFETY: the block is sized by GetFileVersionInfoSizeW and u32-aligned; every pointer
        // VerQueryValueW returns points inside it and is read only within the returned length.
        unsafe {
            let size = GetFileVersionInfoSizeW(wpath.as_ptr(), std::ptr::null_mut());
            if size == 0 {
                return None;
            }
            let mut block = vec![0u32; (size as usize).div_ceil(4)];
            if GetFileVersionInfoW(wpath.as_ptr(), 0, size, block.as_mut_ptr().cast()) == 0 {
                return None;
            }
            let query = |sub: &str| -> Option<(*const c_void, u32)> {
                let mut ptr = std::ptr::null_mut();
                let mut len = 0u32;
                (VerQueryValueW(block.as_ptr().cast(), wide(sub).as_ptr(), &mut ptr, &mut len) != 0 && !ptr.is_null() && len > 0).then_some((ptr.cast_const(), len))
            };
            let mut pairs: Vec<(u16, u16)> = match query("\\VarFileInfo\\Translation") {
                Some((p, bytes)) => std::slice::from_raw_parts(p.cast::<u16>(), (bytes / 2) as usize).as_chunks::<2>().0.iter().map(|&[lang, cp]| (lang, cp)).collect(),
                None => Vec::new(),
            };
            pairs.push((0x0409, 0x04b0));
            pairs.into_iter().find_map(|(lang, cp)| {
                let (p, chars) = query(&super::description_subblock(lang, cp))?;
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(p.cast::<u16>(), chars as usize));
                let s = s.trim_end_matches('\0').trim().to_string();
                (!s.is_empty()).then_some(s)
            })
        }
    }

    /// Milliseconds since the last keyboard/mouse input in this session (a tick counter only);
    /// -1 when unavailable.
    pub fn idle_ms_now() -> i64 {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set. Read before GetTickCount so the
        // current tick is never older than the last-input tick (except across a wrap).
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return -1;
        }
        super::idle_ms(unsafe { GetTickCount() }, info.dwTime) as i64
    }

    pub fn screen_locked() -> bool {
        // SAFETY: the desktop handle is checked and closed; the name buffer length is passed in bytes.
        unsafe {
            let desk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desk.is_null() {
                return super::locked_from_input_desktop(Err(GetLastError()));
            }
            let mut buf = [0u16; 256];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(desk, UOI_NAME, buf.as_mut_ptr().cast(), size_of_val(&buf) as u32, &mut needed) != 0;
            let err = GetLastError();
            CloseDesktop(desk);
            if !ok {
                return super::locked_from_input_desktop(Err(err));
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            super::locked_from_input_desktop(Ok(&String::from_utf16_lossy(&buf[..end])))
        }
    }

    pub fn on_console() -> bool {
        // SAFETY: out-pointers are valid; the WTS buffer is freed with WTSFreeMemory.
        unsafe {
            let console = WTSGetActiveConsoleSessionId();
            let mut own = 0u32;
            let own = (ProcessIdToSessionId(GetCurrentProcessId(), &mut own) != 0).then_some(own);
            let mut buf = std::ptr::null_mut();
            let mut bytes = 0u32;
            let connected = if WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSConnectState, &mut buf, &mut bytes) != 0 && !buf.is_null() {
                let state = (bytes as usize >= size_of::<i32>()).then(|| buf.cast::<i32>().read_unaligned());
                WTSFreeMemory(buf.cast());
                state.map(|s| s == WTSActive)
            } else {
                None
            };
            super::session_in_front(console, own, connected)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_is_the_lowercased_file_name_without_the_user_path() {
        assert_eq!(identifier(r"C:\Program Files\Google\Chrome\Application\Chrome.EXE"), "chrome.exe");
        assert_eq!(identifier(r"C:\Users\Jane Doe\AppData\Local\Programs\Slack\slack.exe"), "slack.exe", "no user name leaks");
        assert_eq!(identifier("C:/odd/Forward.exe"), "forward.exe");
        assert_eq!(identifier("Runner"), "runner");
    }

    #[test]
    fn name_prefers_file_description_then_the_exe_stem() {
        let p = r"C:\Windows\System32\notepad.exe";
        assert_eq!(display_name(Some("Notepad"), p), "Notepad");
        assert_eq!(display_name(Some("  \u{200e}WhatsApp\0 "), p), "WhatsApp", "bidi marks, NULs and spaces trimmed");
        assert_eq!(display_name(Some("   "), p), "notepad", "blank description falls back to the stem");
        assert_eq!(display_name(None, r"C:\Apps\my.tool.v2.EXE"), "my.tool.v2", "only the last extension is dropped");
        assert_eq!(display_name(None, "C:/odd/forward/Slash.exe"), "Slash");
        assert_eq!(display_name(None, r"C:\noext\Runner"), "Runner");
        assert_eq!(display_name(None, r"C:\dir\.hidden"), ".hidden");
        assert_eq!(display_name(None, ""), "Unknown app");
    }

    #[test]
    fn frame_host_resolves_to_the_first_child_owned_by_another_process() {
        assert_eq!(identifier(r"C:\Windows\System32\ApplicationFrameHost.exe"), FRAME_HOST);
        assert_eq!(hosted_app_pid(100, &[100, 0, 4242, 5151]), Some(4242), "Calculator.exe's CoreWindow");
        assert_eq!(hosted_app_pid(100, &[100, 100]), None, "only host-owned children: keep the host");
        assert_eq!(hosted_app_pid(100, &[]), None);
        assert_eq!(identifier(r"C:\Program Files\WindowsApps\Microsoft.WindowsCalculator_11.2_x64__8wekyb3d8bbwe\CalculatorApp.exe"), "calculatorapp.exe", "file name only");
    }

    #[test]
    fn idle_ticks_wrap_at_49_7_days() {
        assert_eq!(idle_ms(10_000, 4_000), 6_000);
        assert_eq!(idle_ms(5, 5), 0);
        // GetTickCount wrapped (u32::MAX ms ≈ 49.7 days) between the last input and now.
        assert_eq!(idle_ms(1_000, u32::MAX - 999), 2_000);
        assert_eq!(idle_ms(0, u32::MAX), 1);
        // Last-input tick read a moment after "now": input just happened, not 49 days ago.
        assert_eq!(idle_ms(100, 150), 0);
        assert_eq!(idle_ms(u32::MAX, 3), 0);
        // Largest plausible idle (24.8 days) is still reported.
        assert_eq!(idle_ms(i32::MAX as u32, 0), i32::MAX as u64);
    }

    #[test]
    fn version_subblock_uses_lowercase_hex_lang_and_codepage() {
        assert_eq!(description_subblock(0x0409, 0x04b0), r"\StringFileInfo\040904b0\FileDescription");
        assert_eq!(description_subblock(0x0407, 0x04E4), r"\StringFileInfo\040704e4\FileDescription");
    }

    #[test]
    fn input_desktop_other_than_default_or_denied_means_locked() {
        assert!(!locked_from_input_desktop(Ok("Default")));
        assert!(!locked_from_input_desktop(Ok("default")));
        assert!(locked_from_input_desktop(Ok("Winlogon")), "lock screen / UAC secure desktop");
        assert!(locked_from_input_desktop(Ok("Screen-saver")));
        assert!(locked_from_input_desktop(Err(ACCESS_DENIED)), "cannot open the input desktop while locked");
        assert!(!locked_from_input_desktop(Err(6)), "other failures are unknown, not locked");
    }

    #[test]
    fn session_in_front_on_console_or_connected_remotely() {
        assert!(session_in_front(1, Some(1), None), "console session");
        assert!(session_in_front(1, Some(3), Some(true)), "connected over Remote Desktop");
        assert!(!session_in_front(1, Some(2), Some(false)), "fast user switch: our session disconnected");
        assert!(!session_in_front(u32::MAX, Some(2), None), "no console session attached and state unknown");
        assert!(session_in_front(1, None, None), "unknown own session never stops monitoring");
    }

    #[cfg(windows)]
    #[test]
    fn native_samples_are_sane() {
        let idle = idle_ms_now();
        assert!((0..=i32::MAX as i64).contains(&idle), "idle {idle}");
        let _ = frontmost(); // may be None on a service desktop (CI runner)
        let _ = screen_locked();
        let _ = on_console();
        assert_eq!(ACCESS_DENIED, windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED);
    }
}
