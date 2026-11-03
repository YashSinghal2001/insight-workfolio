//! Employee preferences for the app shell: menu-bar seconds, Dock icon, launch at login.
//! `showSeconds` and `hideDockIcon` are stored as JSON in the app config dir (file `0600` on unix;
//! on Windows `%APPDATA%\com.insightworkfolio.desktop\prefs.json`, protected by the per-user
//! profile ACL, which only the user, SYSTEM and Administrators can read).
//! `launchAtLogin` is not stored: the OS registration is the source of truth (macOS SMAppService;
//! Windows the per-user Run key plus Task Manager's Startup apps switch), so a change made in
//! System Settings / Task Manager is reported as-is.
//! Windows meanings: `hideDockIcon` hides the taskbar button; `showSeconds` the tray tooltip seconds.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub show_seconds: bool,
    pub hide_dock_icon: bool,
    /// Filled from the OS on read; ignored in the file.
    #[serde(skip_deserializing)]
    pub launch_at_login: bool,
}

/// The stored preferences and their file, managed as app state.
pub struct Store {
    pub path: PathBuf,
    pub prefs: std::sync::Mutex<Prefs>,
}

/// A missing or unreadable file means the defaults (all off).
pub fn load(path: &Path) -> Prefs {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(path: &Path, prefs: &Prefs) -> std::io::Result<()> {
    let json = serde_json::json!({ "showSeconds": prefs.show_seconds, "hideDockIcon": prefs.hide_dock_icon });
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        opts.mode(0o600);
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    std::io::Write::write_all(&mut opts.open(path)?, json.to_string().as_bytes())
}

/// Login item via SMAppService.mainApp (macOS 13+). It registers the installed, signed `.app`
/// itself, so it only works from a bundle (not `tauri dev` or a bare binary), and macOS may require
/// the employee to approve it in System Settings > General > Login Items.
#[cfg(target_os = "macos")]
pub mod login_item {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    pub fn enabled() -> bool {
        unsafe { SMAppService::mainAppService().status() == SMAppServiceStatus::Enabled }
    }

    pub fn set(on: bool) -> Result<(), String> {
        let service = unsafe { SMAppService::mainAppService() };
        let status = unsafe { service.status() };
        let result = if on {
            if status == SMAppServiceStatus::Enabled { return Ok(()) }
            unsafe { service.registerAndReturnError() }
        } else {
            if status == SMAppServiceStatus::NotRegistered || status == SMAppServiceStatus::NotFound { return Ok(()) }
            unsafe { service.unregisterAndReturnError() }
        };
        result.map_err(|e| format!("Could not change launch at login: {}", e.localizedDescription()))?;
        if on && unsafe { service.status() } == SMAppServiceStatus::RequiresApproval {
            unsafe { SMAppService::openSystemSettingsLoginItems() };
            return Err("Allow Insight Workfolio in System Settings > General > Login Items to finish turning on launch at login.".into());
        }
        Ok(())
    }
}

/// The registry value for the Run key: the executable path, quoted so a path with spaces
/// (`C:\Users\Ann Lee\AppData\Local\Insight Workfolio\…`) is not split by the shell. Windows paths
/// cannot contain `"`, so no escaping is needed.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_value(exe: &str) -> String {
    format!("\"{exe}\"")
}

/// Whether the Run value starts this installation (an older install location or a hand-edited
/// value does not count; turning the preference on rewrites it). Paths compare case-insensitively.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_value_is_ours(stored: &str, exe: &str) -> bool {
    stored.trim().eq_ignore_ascii_case(&run_value(exe))
}

/// Task Manager › Startup apps keeps its own switch in `…\Explorer\StartupApproved\Run`: a binary
/// value whose first byte is even (02, 06) when enabled and odd (03, 07) when disabled. No value
/// means enabled.
#[cfg_attr(not(windows), allow(dead_code))]
fn startup_approved(value: Option<&[u8]>) -> bool {
    value.and_then(|v| v.first()).is_none_or(|b| b & 1 == 0)
}

/// Launch at sign-in via the per-user Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
/// value "Insight Workfolio"). Visible and switchable in Task Manager › Startup apps and
/// Settings › Apps › Startup; no admin rights, no scheduled task or service.
#[cfg(windows)]
pub mod login_item {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    // productName (staging: "Insight Workfolio Staging", set by scripts/desktop-config.mjs) so both can launch at sign-in.
    const NAME: &str = match option_env!("WORKFOLIO_PRODUCT_NAME") {
        Some(s) => s,
        None => "Insight Workfolio",
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn exe() -> Result<String, String> {
        let path = std::env::current_exe().map_err(|e| format!("Could not change open at sign-in: {e}"))?;
        path.to_str().map(str::to_owned).ok_or_else(|| "Could not change open at sign-in: unusual program path".into())
    }

    /// Raw bytes of an HKCU value of the given type, `None` if missing or unreadable.
    fn read(key: &str, flags: u32) -> Option<Vec<u8>> {
        let (key, name) = (wide(key), wide(NAME));
        let mut len = 0u32;
        let get = |buf: *mut core::ffi::c_void, len: &mut u32| unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), buf, len) };
        if get(std::ptr::null_mut(), &mut len) != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        (get(buf.as_mut_ptr().cast(), &mut len) == ERROR_SUCCESS).then(|| { buf.truncate(len as usize); buf })
    }

    fn delete(key: &str) -> u32 {
        let (key, name) = (wide(key), wide(NAME));
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) }
    }

    pub fn enabled() -> bool {
        let Some(bytes) = read(RUN, RRF_RT_REG_SZ) else { return false };
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c)).take_while(|&u| u != 0).collect();
        let ours = exe().is_ok_and(|exe| super::run_value_is_ours(&String::from_utf16_lossy(&units), &exe));
        ours && super::startup_approved(read(APPROVED, RRF_RT_REG_BINARY).as_deref())
    }

    pub fn set(on: bool) -> Result<(), String> {
        if !on {
            return match delete(RUN) {
                ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
                e => Err(format!("Could not turn off open at sign-in (error {e}).")),
            };
        }
        let data = wide(&super::run_value(&exe()?));
        let (key, name) = (wide(RUN), wide(NAME));
        let bytes = (data.len() * 2) as u32;
        let rc = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, data.as_ptr().cast(), bytes) };
        if rc != ERROR_SUCCESS {
            return Err(format!("Could not turn on open at sign-in (error {rc})."));
        }
        // The employee's explicit choice in the app wins over an earlier "Disabled" in Task Manager.
        delete(APPROVED);
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub mod login_item {
    pub fn enabled() -> bool {
        false
    }

    pub fn set(on: bool) -> Result<(), String> {
        if on { Err("Launch at login is only available on macOS in this version.".into()) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing_or_damaged_and_round_trip_owner_only() {
        let dir = std::env::temp_dir().join(format!("wf-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        assert_eq!(load(&path), Prefs::default());
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Prefs::default());
        let p = Prefs { show_seconds: true, hide_dock_icon: true, launch_at_login: true };
        save(&path, &p).unwrap();
        assert_eq!(load(&path), Prefs { launch_at_login: false, ..p }, "launchAtLogin is read from the OS, never the file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn run_key_value_is_the_quoted_exe_path() {
        let exe = r"C:\Users\Ann Lee\AppData\Local\Insight Workfolio\insight-workfolio-desktop.exe";
        assert_eq!(run_value(exe), format!("\"{exe}\""));
        assert!(run_value_is_ours(&run_value(exe), exe));
        assert!(run_value_is_ours(&run_value(&exe.to_uppercase()), exe), "paths are case-insensitive");
        assert!(!run_value_is_ours(exe, exe), "an unquoted path is rewritten");
        assert!(!run_value_is_ours(&run_value(r"C:\Old\insight-workfolio-desktop.exe"), exe), "another install location");
    }

    #[test]
    fn task_manager_startup_switch() {
        assert!(startup_approved(None), "no entry: enabled");
        assert!(startup_approved(Some(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(startup_approved(Some(&[6])));
        assert!(!startup_approved(Some(&[3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])), "disabled in Task Manager");
        assert!(!startup_approved(Some(&[7])));
        assert!(startup_approved(Some(&[])));
    }
}
