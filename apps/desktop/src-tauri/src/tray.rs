//! App shell: menu-bar item (status, elapsed time, Open/Quit), close-to-menu-bar, reopen, quit
//! confirmation while clocked in, and the Dock icon policy. The webview drives the content through
//! `tray_update`; the elapsed time ticks here, natively, only while a `since` time is set.
//!
//! Windows: the notification-area icon has no title text, so the elapsed time goes in the tooltip
//! ("Working · 2:14"); left click opens the window, right click shows the menu; "Exit" replaces
//! "Quit"; `hideDockIcon` hides the taskbar button. Alt+F4 / the close button hide the window like
//! macOS, so the app is only exited from the tray menu.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

pub const STATES: [&str; 6] = ["SIGNED_OUT", "CLOCKED_OUT", "WORKING", "ON_BREAK", "OFFLINE", "ATTENTION"];
pub const OPEN_ID: &str = "shell-open";
pub const QUIT_ID: &str = "shell-quit";
/// macOS: black template glyph the system tints. Windows does not tint tray icons, so its glyph is
/// white with a dark outline, legible on light and dark taskbars (scripts/tray-icon.py makes both).
#[cfg(not(windows))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(windows)]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-windows.png");
/// Windows convention is "Exit" (the employee notice says "choose Exit Insight Workfolio").
#[cfg(windows)]
const QUIT_LABEL: &str = "Exit Insight Workfolio";
#[cfg(not(windows))]
const QUIT_LABEL: &str = "Quit Insight Workfolio";

#[derive(Clone, Debug, PartialEq)]
struct View {
    state: String,
    label: String,
    since_ms: Option<i64>,
    monitoring: Option<String>,
    show_seconds: bool,
}

pub struct Shell {
    tray: TrayIcon,
    view: Mutex<View>,
    changed: Condvar,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `h:mm`, or `h:mm:ss` with seconds; hours are not capped (a 30 h shift shows `30:00`).
pub fn format_elapsed(ms: i64, show_seconds: bool) -> String {
    let s = ms.max(0) / 1000;
    if show_seconds { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 3600, s / 60 % 60) }
}

/// Time until the shown text next changes (next second or next minute of elapsed time).
fn next_tick(elapsed_ms: i64, show_seconds: bool) -> Duration {
    let unit = if show_seconds { 1000 } else { 60_000 };
    Duration::from_millis((unit - elapsed_ms.max(0) % unit) as u64 + 5)
}

/// Windows tray tooltip: the status label, plus the elapsed time while clocked in. The tooltip
/// buffer holds 127 UTF-16 units and a NUL (tray-icon copies at most 128 units without adding
/// a terminator), so longer text is cut with an ellipsis.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn tooltip(label: &str, elapsed: Option<&str>) -> String {
    const MAX_UNITS: usize = 127;
    let full = match elapsed {
        Some(e) => format!("{label} · {e}"),
        None => label.to_string(),
    };
    if full.encode_utf16().count() <= MAX_UNITS {
        return full;
    }
    let mut out = String::new();
    let mut units = 1; // the ellipsis
    for c in full.chars() {
        units += c.len_utf16();
        if units > MAX_UNITS {
            break;
        }
        out.push(c);
    }
    out + "…"
}

pub fn parse_since(iso: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(iso).map(|t| t.timestamp_millis()).map_err(|e| format!("since: {e}"))
}

impl Shell {
    fn lock(&self) -> std::sync::MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Builds the menu-bar item and starts its timer thread (idle until a `since` is set).
    pub fn init(app: &AppHandle, show_seconds: bool) -> tauri::Result<Arc<Shell>> {
        let view = View { state: "SIGNED_OUT".into(), label: "Insight Workfolio".into(), since_ms: None, monitoring: None, show_seconds };
        let builder = TrayIconBuilder::with_id("main")
            .icon(tauri::image::Image::from_bytes(TRAY_ICON)?)
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip(&view.label)
            .menu(&menu(app, &view)?);
        // Windows convention: left click opens the app, right click shows the menu.
        #[cfg(windows)]
        let builder = builder.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                open_main(tray.app_handle());
            }
        });
        let tray = builder.build(app)?;
        let shell = Arc::new(Shell { tray, view: Mutex::new(view), changed: Condvar::new() });
        let ticker = shell.clone();
        std::thread::Builder::new().name("menu-bar-timer".into()).spawn(move || ticker.tick_forever())?;
        Ok(shell)
    }

    /// Tray calls wait for the main thread, so they are never made while holding the lock (a
    /// command on the main thread may be waiting for it).
    fn tick_forever(&self) {
        let mut shown: Option<String> = None;
        loop {
            let key = { let v = self.lock(); (v.since_ms, v.show_seconds, v.label.clone()) };
            let (since, secs, _) = key;
            let title = since.map(|s| format_elapsed(now_ms() - s, secs));
            // macOS: menu-bar title. Windows: no title, the tooltip carries label and time.
            #[cfg(windows)]
            let title = Some(tooltip(&key.2, title.as_deref()));
            if title != shown {
                #[cfg(windows)]
                let _ = self.tray.set_tooltip(title.as_deref());
                #[cfg(not(windows))]
                let _ = self.tray.set_title(title.as_deref());
                shown = title;
            }
            let view = self.lock();
            if (view.since_ms, view.show_seconds, &view.label) != (key.0, key.1, &key.2) {
                continue; // changed while the title was being set
            }
            match since {
                Some(s) => drop(self.changed.wait_timeout(view, next_tick(now_ms() - s, secs))),
                None => drop(self.changed.wait(view)),
            }
        }
    }

    pub fn update(&self, app: &AppHandle, state: String, label: String, since_ms: Option<i64>, monitoring: Option<String>) -> tauri::Result<()> {
        let (label, monitoring) = (clip(label), monitoring.map(clip));
        let next = {
            let mut view = self.lock();
            let next = View { state, label, since_ms, monitoring, show_seconds: view.show_seconds };
            let menu_changed = (&view.state, &view.label, &view.monitoring) != (&next.state, &next.label, &next.monitoring);
            if *view != next {
                *view = next.clone();
                self.changed.notify_all();
            }
            menu_changed.then_some(next)
        };
        if let Some(next) = next {
            self.tray.set_menu(Some(menu(app, &next)?))?;
            #[cfg(not(windows))] // Windows: the timer thread owns the tooltip (label + time)
            self.tray.set_tooltip(Some(&next.label))?;
        }
        Ok(())
    }

    pub fn set_show_seconds(&self, on: bool) {
        self.lock().show_seconds = on;
        self.changed.notify_all();
    }

    /// Clocked in (working or on a break): quitting stops activity and screenshot recording.
    pub fn recording(&self) -> bool {
        clocked_in(&self.lock())
    }
}

/// OFFLINE and ATTENTION can also be clocked in (monitoring continues offline): the running timer
/// (`since`, set only while working or on a break) says so.
fn clocked_in(view: &View) -> bool {
    view.since_ms.is_some() || matches!(view.state.as_str(), "WORKING" | "ON_BREAK")
}

/// Menu text is a short sentence; anything longer from the page is cut (no huge menu items).
const MAX_TEXT_CHARS: usize = 160;
fn clip(s: String) -> String {
    match s.char_indices().nth(MAX_TEXT_CHARS) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s,
    }
}

fn menu(app: &AppHandle, view: &View) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::new(app, &view.label, false, None::<&str>)?)?;
    if let Some(m) = view.monitoring.as_deref().filter(|m| !m.is_empty()) {
        menu.append(&MenuItem::new(app, m, false, None::<&str>)?)?;
    }
    menu.append(&MenuItem::with_id(app, OPEN_ID, "Open Insight Workfolio", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, QUIT_ID, QUIT_LABEL, true, None::<&str>)?)?;
    Ok(menu)
}

/// macOS app menu: the default menu with its Quit (which terminates immediately and cannot be
/// intercepted) replaced by ours, so Cmd+Q asks first while clocked in, like the menu-bar Quit.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        let last = app_menu.items()?.len().saturating_sub(1);
        app_menu.remove_at(last)?;
        app_menu.append(&MenuItem::with_id(app, QUIT_ID, "Quit Insight Workfolio", true, Some("CmdOrCtrl+Q"))?)?;
    }
    Ok(menu)
}

/// Shows and focuses the main window (also when the Dock icon is hidden) and tells the page.
pub fn open_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show(); // undo Cmd+H
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus(); // activates the app, which an Accessory (no Dock icon) app needs
    }
    let _ = app.emit("tray-open", ());
}

/// Hides the window instead of closing it; the app keeps running in the menu bar.
pub fn hide_main(window: &tauri::Window) {
    let _ = window.hide();
    let _ = window.emit("window-hidden", ());
}

/// Menu-bar (Windows: tray "Exit") and Cmd+Q quit. While clocked in, asks first.
pub fn quit(app: &AppHandle) {
    let recording = app.try_state::<Arc<Shell>>().is_some_and(|s| s.recording());
    if !recording || confirm_quit() {
        eprintln!("[lifecycle] quit (clocked in: {recording})");
        app.exit(0);
    }
}

#[cfg(target_os = "macos")]
fn confirm_quit() -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication};
    use objc2_foundation::NSString;
    // Menu events are delivered on the main thread; anywhere else, quitting without asking is wrong.
    let Some(mtm) = MainThreadMarker::new() else { return false };
    NSApplication::sharedApplication(mtm).activate();
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str("Quit Insight Workfolio?"));
    alert.setInformativeText(&NSString::from_str("Quitting stops activity and screenshot recording until you open the app again. Quit?"));
    alert.addButtonWithTitle(&NSString::from_str("Quit"));
    alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    alert.runModal() == NSAlertFirstButtonReturn
}

/// Same text as macOS with Windows wording; OK exits. Topmost + foreground: the tray menu has no
/// owner window and the main window may be hidden. Runs on the main thread (menu event), whose
/// message loop keeps running inside the modal box.
#[cfg(windows)]
fn confirm_quit() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDOK, MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide("Exit Insight Workfolio?\n\nExiting stops activity and screenshot recording until you open the app again. Click OK to exit.");
    let caption = wide("Insight Workfolio");
    let flags = MB_OKCANCEL | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND;
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), flags) == IDOK }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn confirm_quit() -> bool {
    true // unsupported platforms (Linux builds only for development)
}

/// Dock icon on/off (Accessory activation policy hides it and the app menu). A visible window
/// is re-focused, since switching policy deactivates the app. Windows: the same preference hides
/// the taskbar button (the tray icon stays, so the app is always visible somewhere).
pub fn apply_dock(app: &AppHandle, hide: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if hide { tauri::ActivationPolicy::Accessory } else { tauri::ActivationPolicy::Regular };
        app.set_activation_policy(policy).map_err(|e| e.to_string())?;
        if let Some(w) = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) {
            let _ = w.set_focus();
        }
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        w.set_skip_taskbar(hide).map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (app, hide);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_formats() {
        assert_eq!(format_elapsed(0, false), "0:00");
        assert_eq!(format_elapsed(59_999, false), "0:00");
        assert_eq!(format_elapsed(65_000, true), "0:01:05");
        assert_eq!(format_elapsed((3600 + 5 * 60 + 9) * 1000, false), "1:05");
        assert_eq!(format_elapsed(30 * 3600 * 1000, true), "30:00:00");
        assert_eq!(format_elapsed(-5_000, true), "0:00:00", "clock skew: never negative");
    }

    #[test]
    fn ticks_when_the_text_changes() {
        assert_eq!(next_tick(1_200, true), Duration::from_millis(805));
        assert_eq!(next_tick(61_000, false), Duration::from_millis(59_005));
    }

    #[test]
    fn quit_asks_whenever_clocked_in_also_offline_or_needing_attention() {
        let v = |state: &str, since_ms| View { state: state.into(), label: String::new(), since_ms, monitoring: None, show_seconds: false };
        for (state, since, want) in [("WORKING", Some(1), true), ("ON_BREAK", Some(1), true), ("OFFLINE", Some(1), true), ("ATTENTION", Some(1), true), ("OFFLINE", None, false), ("ATTENTION", None, false), ("CLOCKED_OUT", None, false), ("SIGNED_OUT", None, false)] {
            assert_eq!(clocked_in(&v(state, since)), want, "{state} {since:?}");
        }
    }

    #[test]
    fn long_menu_text_is_clipped() {
        assert_eq!(clip("Clocked in".into()), "Clocked in");
        let long = clip("é".repeat(1_000_000));
        assert_eq!(long.chars().count(), MAX_TEXT_CHARS + 1);
        assert!(long.ends_with('…'));
        assert_eq!(clip("x".repeat(MAX_TEXT_CHARS)).len(), MAX_TEXT_CHARS, "exactly the limit is kept");
    }

    #[test]
    fn windows_tooltip_carries_the_timer_and_fits_the_buffer() {
        assert_eq!(tooltip("Working", Some("2:14")), "Working · 2:14");
        assert_eq!(tooltip("Working", Some(&format_elapsed(8_040_000, true))), "Working · 2:14:00");
        assert_eq!(tooltip("Signed out", None), "Signed out");
        let long = tooltip(&"😀".repeat(100), Some("1:00")); // 2 UTF-16 units each
        assert!(long.encode_utf16().count() <= 127 && long.ends_with('…'), "{}", long.encode_utf16().count());
        assert!(!long.contains('\u{FFFD}'), "never splits a surrogate pair");
        assert_eq!(tooltip(&"x".repeat(127), None).len(), 127, "exactly the limit is kept");
        assert_eq!(tooltip(&"x".repeat(128), None).encode_utf16().count(), 127);
    }

    #[test]
    fn since_is_iso_with_offset() {
        assert_eq!(parse_since("1970-01-01T00:00:01.500Z"), Ok(1500));
        assert_eq!(parse_since("1970-01-01T01:00:00+01:00"), Ok(0));
        assert!(parse_since("yesterday").is_err());
        assert!(parse_since("1700000000000").is_err());
    }
}
