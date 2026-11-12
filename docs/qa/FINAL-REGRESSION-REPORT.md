# Final regression report

Statuses used: PASS, FAIL, PARTIAL, BLOCKED, NOT IMPLEMENTED, NOT RUN. A build or compile result is never counted as a runtime PASS. Date of the runs: 2026-11-12, host macOS (Apple Silicon). No Windows machine was available. Nothing was committed, pushed, merged or deployed.

## Automated suites (final run, all QA tests included)

| Suite | Command | Result | Status |
|---|---|---|---|
| Build packages | `pnpm build:packages` | exit 0 | PASS |
| Typecheck (all packages, incl. dashboard) | `pnpm typecheck` | exit 0 | PASS |
| Lint (all packages, incl. `cargo clippy -D warnings`) | `pnpm lint` | exit 0 | PASS |
| packages/shared | `pnpm --filter @workfolio/shared test` | 16 files, 76 tests, 76 pass, 0 fail, 0 skipped | PASS |
| packages/database | `pnpm --filter @workfolio/database test` | 10 files, 49 tests, 49 pass | PASS |
| apps/api | `pnpm --filter @workfolio/api test` | 58 files, 479 tests, 479 pass, 0 fail, 0 skipped, 0 todo | PASS |
| browser-extension | `pnpm --filter @workfolio/browser-extension test` | 7 tests, 7 pass | PASS |
| desktop TypeScript | `node --test` in apps/desktop | 15 files, 81 tests, 81 pass | PASS |
| desktop Rust | `cargo test` | 103 pass, 0 fail, 1 ignored (`native_capture_benchmark`: captures the screen) | PASS |
| desktop Rust lint | `cargo clippy -- -D warnings` | exit 0 | PASS |
| dashboard unit | `node --test src/lib/*.test.mjs` | 2 files, 9 tests, 9 pass | PASS |
| dashboard build + smoke | `pnpm --filter @workfolio/dashboard test` | build ok, smoke 35 routes | PASS |
| Windows cross-compile | `cargo check --target x86_64-pc-windows-gnu`, empty separate target dir | 260 crates compiled, 54 s, exit 0 | PASS (compile only; not a runtime result) |

Round-1 baseline for comparison: shared 69, database 49, api 424, extension 7, desktop TypeScript 67, cargo 94 (1 ignored).

## Browser suites (dashboard production build against a throwaway local API)

| Suite (`apps/dashboard/scripts`) | Checks | Status | Note |
|---|---|---|---|
| verify-web-app | 91/91 | PASS | |
| verify-gallery | 18/18 | PASS | |
| verify-timelapse | 22/22 | PASS | |
| verify-my-panel | 46/46 | PASS | First run 45/46: the `/my/screenshots` list had lost the sentence that viewing is logged. Coordinator restored it in the status card (`src/app/my/screenshots/page.tsx`), rebuilt, and reran: 46/46 |
| verify-masks | 14/14 | PASS | |
| verify-reports | 11/11 | PASS | mock mail provider |
| verify-web-product | 15/15 | PASS | |
| verify-setup-password | 14/14 | PASS | |
| verify-wave2 | first run 43/44, then 55/55 | PASS | The first run stopped at a stale selector (`has("Timeline")`; the card is now "Day timeline"). QA updated `verify-wave2.mjs:412` and reran |
| verify-labels | 18/18 | PASS | |
| verify-schedule | first run 16/17, then 20/20 | PASS | Same stale selector at `verify-schedule.mjs:295`, updated and rerun |
| verify-teamhead | 27/27 | PASS | |
| verify-xlsx | 11/11 | PASS | |

Each suite started its own API on a temporary SQLite file with local storage and a headless Chrome; none contacted an external host. The desktop `verify-*` scripts were NOT RUN (they launch the desktop app).

## Not run / blocked

| Item | Status | Reason |
|---|---|---|
| Every Windows runtime behaviour (idle, lock, sleep, display off, capture, tray, installer, Credential Manager) | BLOCKED | no Windows machine |
| macOS lock, sleep, wake, display sleep, fast user switching | NOT RUN | needs a person at a Mac |
| macOS Screen Recording / Keychain prompts, real capture, desktop app launch | NOT RUN | not permitted on this host; needs a person |
| Desktop `verify-*.mjs` (apps/desktop/scripts) | NOT RUN | they launch the desktop app |
| `native_capture_benchmark` (Rust, ignored) | NOT RUN | captures the screen |
| OneDrive / Microsoft Graph / Google Drive against the real services | NOT RUN | no external service was contacted |
| Real e-mail delivery | NOT RUN | mock provider only |
| Production server, production database, deployment, migration on production | NOT RUN | out of scope by rule |
| New desktop installers (the two files the smoke test finds are earlier builds) | NOT RUN | no packaging, signing or notarisation was done |

## Open defects at the end of the final review

| # | Severity | Where | What | Test |
|---|---|---|---|---|
| 1 | Low | `apps/dashboard/src/app/my/screenshots/page.tsx` (status card near line 53; the sentence remains only at line 144) | The employee's screenshot list no longer says that viewing is logged before a screenshot is opened | FIXED by the coordinator after this review; `verify-my-panel` rerun 46/46 |
| 2 | Low (cannot be verified here) | `apps/desktop/src-tauri/src/win/session.rs:160-162`, `screenshot.rs:1002-1003` | The Windows display-off state comes only from a power notification: it is unknown until the first notification after start, and a failed registration is only logged | none (BLOCKED: Windows) |
| 3 | Note | `apps/desktop/src-tauri/Cargo.toml:42` (`panic = "abort"`), `collector.rs:125-134` | Release builds abort on panic, so the poisoned-lock recovery never runs in a shipped build: a panic there ends the app. In release the protection is the arithmetic fix (`activity.rs:181,204,206`) | Rust tests (debug build) |
| 4 | Note (existed before) | `apps/dashboard/src/app/(admin)/settings/page.tsx` (OneDrive status table) | OneDrive root, team and timelapse folder names are shown to both admin identities. No token or secret is shown | none |

The defects reported in the QA review round were re-tested. Fixed and passing: indirect purge through retention settings, the website purge route, the tracker panic, unaudited sibling reads, live status with monitoring off, timeline tie order, ACTIVE before unlock. The Windows display-off fix is in the code but BLOCKED for runtime.

## Production

Nothing was committed, pushed, merged or deployed. No production data, service or secret was touched. Screenshot capture and website tracking remain off by default. Production activation is pending the owner's review; see IMPLEMENTATION-AND-QA-REPORT.md.
