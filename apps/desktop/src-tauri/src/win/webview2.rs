//! Missing WebView2 runtime: without it Tauri cannot create the window and the release build
//! (panic = "abort", no console) would just vanish. `ensure` checks first and explains instead.
#![cfg_attr(not(windows), allow(dead_code))]

pub const DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// `None` when the runtime is installed; otherwise the message box text.
pub fn missing_message(version: Result<String, String>) -> Option<String> {
    match version {
        Ok(v) if !v.trim().is_empty() => None,
        _ => Some(format!(
            "Insight Workfolio needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer.\n\n\
             Install the Evergreen WebView2 Runtime from:\n{DOWNLOAD_URL}\n\n\
             or ask your IT administrator, then open Insight Workfolio again."
        )),
    }
}

/// Shows the explanation and returns false when WebView2 is missing; the caller then exits.
#[cfg(windows)]
pub fn ensure() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let Some(text) = missing_message(tauri::webview_version().map_err(|e| e.to_string())) else {
        return true;
    };
    eprintln!("[lifecycle] WebView2 runtime missing: not starting");
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(&text), wide("Insight Workfolio"));
    // SAFETY: both strings are NUL-terminated and outlive the call; no owner window.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR) };
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_only_when_the_runtime_is_missing() {
        assert_eq!(missing_message(Ok("131.0.2903.70".into())), None);
        let msg = missing_message(Err("0x80070002".into())).expect("missing runtime explained");
        assert!(msg.contains("WebView2") && msg.contains(DOWNLOAD_URL));
        assert!(missing_message(Ok("  ".into())).is_some(), "empty version string counts as missing");
    }
}
