# Feature parity remediation plan (proposed, not started)

Date 2026-11-13. Based on `MACOS-WINDOWS-FEATURE-PARITY.md`. **Nothing here has been implemented; it waits for
owner approval.** Each item names the parity rows it closes, the smallest change, how it is verified, and whether it
needs a decision first. Effort: S < 2 h, M ≈ half a day, L > 1 day.

## P0: unblock builds and testing (do first)

| # | Item | Rows | Smallest change | Verify | Effort | Decision? |
|---|---|---|---|---|---|---|
| 1 | **Windows CI red: privacy guard not portable** | X7 (FAIL), L1 | In `apps/desktop/test/privacy-apis.test.ts` split lines on `/\r?\n/` and report `relative()` paths with `/` separators. Same assertions, no allow-list change. Optionally add a `.gitattributes` (`* text=auto`, binaries marked) so checkouts are consistent | Re-dispatch CI: Windows TS 81/81, NSIS installer built and its SHA-256 printed | S | No |
| 2 | **macOS native harness out of date** (locked now counts as IDLE) and stale wording | A8, A13 (PARTIAL), macOS checklist row 19 | `verify-native.mjs:158-169`: expect IDLE from lock to unlock instead of "unobserved"; `activity-ui.ts:323`: drop "or locked" from the gap notice; `collector.rs:154-156,199-200`: derive the status `locked`/`session_inactive` flags from `unobservable_now()` (with its 5 s grace), like the tracker | Desktop tests M; then the macOS checklist row 19 by a person | S | No |
| 3 | **No usable diagnostics in release builds** (Windows: no console; both: no log file) | X10 (PARTIAL); every Windows checklist row that reads the log | Mirror the existing `eprintln!` lines into a size-capped (e.g. 1 MB, one rotation) `desktop.log` in the app's local data directory; same content as today (no names, no images). A "Copy diagnostics" button is optional | Unit test for the cap; on a PC: lock and sleep lines appear | M | Yes: confirm a local log file is acceptable under the monitoring notice |

## P1: behavioural and security parity

| # | Item | Rows | Smallest change | Verify | Effort | Decision? |
|---|---|---|---|---|---|---|
| 4 | **Credentials roam on Windows** (`CRED_PERSIST_ENTERPRISE`) | L9, L11, X1, X2 (PARTIAL) | Windows only: write the two entries with `CRED_PERSIST_LOCAL_MACHINE` (direct `CredWriteW` in `win/`, as keyring offers no option), read old entries once and rewrite them; macOS unchanged | `[win]` round-trip test on Windows CI (also closes L10 NOT TESTED); on a PC: entry shows "Local computer" persistence | M | No |
| 5 | **Activity `source` taken from the client** | (server) | `activity.service.ts:194`: derive `DESKTOP_MACOS/WINDOWS` from the registered device's `platform`, not the request body | API e2e: a Windows device posting `platform: macos` is stored as Windows | S | No |
| 6 | **Hidden-window timers on Windows** | A18, A19, N3, N4, S16 (BLOCKED, at risk) | **Measure first** (Windows checklist row 21). Only if live state or uploads stall: drive the keepalive and upload kick from the Rust collector thread (it already runs every 250 ms) via an event, instead of `setInterval` | PC: hidden 15 min, live state never UNKNOWN | S to measure; M if a fix is needed | No |
| 7 | **No owner-only file permissions on Windows** | L5, X4 (PARTIAL) | Either document acceptance (the `%LOCALAPPDATA%` profile ACL already limits access to the user, SYSTEM and Administrators) **or** set an explicit owner-only DACL on the data and screenshot directories at creation | Doc review, or a `[win]` test reading back the DACL | S (document) / M (DACL) | Yes: accept profile ACL or harden |
| 8 | **Windows shutdown/sign-out not handled explicitly** | L15 (PARTIAL), U20 | **Measure first** (Windows checklist: restart while clocked in). If a "recovered" notice appears after every restart, close the open interval on `WM_QUERYENDSESSION`/`WM_ENDSESSION` through the existing `RunEvent::Exit` path | PC: restart while clocked in, no recovery notice, interval ends at shutdown | S to measure; M to fix | No |
| 9 | **Display-off is notification-only on Windows** | S10 (PARTIAL) | Log a failed `RegisterPowerSettingNotification` loudly (item 3) and retry once after logon, like the WTS registration. A level query has no clean public API; leave the notification as the source | `[win]` test that registration succeeds; PC: display off 3 min, no capture | S | No |
| 10 | **Injected input counts as activity on Windows** | A1 (PARTIAL) | Only with owner approval: low-level hooks that read the `LLKHF_INJECTED` / `LLMHF_INJECTED` flag only (never key values), on the existing session message thread; costs and antivirus perception in `docs/windows.md:67-128` | PC: software jiggler does not keep ACTIVE; antivirus check | M | **Yes** (privacy, antivirus, remote-desktop users) |

## P2: test coverage and housekeeping

| # | Item | Rows | Change | Effort |
|---|---|---|---|---|
| 11 | Windows CI tests for code never executed | L10, L12, S15, X3, X9 (NOT TESTED) | `[win]` tests: HKCU `Run` set/read/delete; `GetDiskFreeSpaceExW` on the temp dir; download allow-list with `C:\Users\…\Downloads` path forms and letter-case differences; staging identity names | M |
| 12 | Bundle targets | L1, O03 | Restrict `targets` to what is shipped (`app`, `dmg`, `nsis`) so an untested per-machine MSI is not produced, unless an MSI is wanted for Intune/GPO | S (decision: MSI wanted?) |
| 13 | Uninstall leftovers | Windows L06 | NSIS uninstall hook to delete the two Credential Manager entries and the `StartupApproved\Run` value | S |
| 14 | Windows runtime harness | O2 (MISSING) | A Windows variant of `verify-native` using the debug end-to-end hook (prompts the person for Win+L, sleep, display off) so PC runs produce recorded evidence | L |
| 15 | Misleading dashboard warning | (server) | `activity.service.ts:273`: say "no activity yet from this Windows device" instead of "older versions … update the app" for new devices | S |
| 16 | Doc drift | — | `docs/windows.md:8,251,338,393`, `docs/security.md:241-250` (Windows now implemented), `WINDOWS-IDLE-AND-SCREENSHOT-TESTS.md` CI row | S |

## Physical runtime passes (after P0)

| Pass | Needs | Checklist |
|---|---|---|
| macOS rerun after `4d66269` | items 1-2; a person at a Mac (lock, sleep, Screen Recording prompts); a separate test Keychain service or a test Mac, because the debug build shares the production Keychain service and data folder with the installed app on this Mac | `MACOS-RUNTIME-TEST-CHECKLIST.md` (53 rows, all NOT RUN) |
| First Windows PC pass | items 1 and 3 (installer and logs); a Windows 10/11 x64 PC; a non-production API; two test employees; screenshots enabled only for a test employee on that API | `WINDOWS-RUNTIME-TEST-CHECKLIST.md` (77 rows, all BLOCKED) |

The Windows application should not be called feature-parity-ready until the Windows checklist has been run on a
physical PC and every BLOCKED row in the parity matrix has a result.
