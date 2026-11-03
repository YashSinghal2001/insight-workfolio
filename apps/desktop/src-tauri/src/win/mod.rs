//! Windows native adapters. Thin #[cfg(windows)] wrappers over Win32; the logic lives in
//! platform-independent functions so it is unit-tested on every host.

pub mod capture;
pub mod activity;
pub mod session;
pub mod webview2;
