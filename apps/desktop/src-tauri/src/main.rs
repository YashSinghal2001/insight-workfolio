// Prevents an extra console window on Windows in release. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    insight_workfolio_desktop_lib::run()
}
