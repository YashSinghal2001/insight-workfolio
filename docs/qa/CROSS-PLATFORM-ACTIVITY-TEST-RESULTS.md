# Cross-platform activity, idle, break and screenshot: test results

Date: 2026-11-16. Commit `4d66269` + local uncommitted changes. Machine: macOS, Apple Silicon (development Mac).
No Windows PC was available to this session. No QA accounts were used; no production system was touched.

Legend: PASS / FAIL / PARTIAL / BLOCKED / NOT RUN. Automated PASS is **not** a runtime PASS.

## Automated suites (macOS, all run on this Mac)

| Suite | Command | Result |
|---|---|---|
| Workspace typecheck | `pnpm typecheck` | PASS |
| Workspace lint (ESLint + `cargo clippy -D warnings`) | `pnpm lint` | PASS |
| Clippy incl. tests | `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS |
| API e2e | `pnpm test` (apps/api) | PASS 495/495 |
| Database | `pnpm test` (packages/database) | PASS 49/49 |
| Shared | `pnpm test` (packages/shared) | PASS 76/76 |
| Desktop TypeScript | `node --test` (apps/desktop) | PASS 83/83 |
| Desktop Rust, macOS | `cargo test` (apps/desktop/src-tauri) | PASS 104 (1 ignored benchmark) |
| Desktop Rust, Windows | CI `windows-latest` | NOT RUN (needs a push to dispatch CI) |
| Desktop TS on Windows (`privacy-apis` portability fix) | CI `windows-latest` | NOT RUN (fix verified on macOS only) |
| Browser extension | `pnpm test` | PASS 7/7 |
| Dashboard build + smoke | `pnpm test` (apps/dashboard) | PASS (35 routes; still verifies the 0.1.0 installers) |
| Production builds | `NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm build` | PASS (all 5 packages) |

## New regression tests

| Requirement | Test | Result |
|---|---|---|
| Break state precedence over device reports | `packages/shared/src/live-status.test.ts` "attendance wins…" (existing) | PASS |
| Idle → active and stale → UNKNOWN | same file, "clocked in, the device's report only while fresh…" (existing) | PASS |
| Screenshot not captured while idle; resumes on input | `screenshot.rs` `idle_is_never_captured_and_input_resumes_capture` | PASS |
| Capture racing a break is discarded | `screenshot.rs` `a_capture_racing_a_break_or_lock_is_discarded` (existing) | PASS |
| Upload queue blocked during a break | `screenshots.test.ts` "upload: nothing is sent during a break…" | PASS |
| Queue blocked after a break starts (captured inside it) | same test, second case | PASS |
| Clock-out and pending screenshots (after = discarded, before = uploaded) | same test, third/fourth cases | PASS |
| Eligibility edges (break start/end, clock-in/out, open break, other session) | `screenshots.test.ts` "eligibility: …" | PASS |
| API rejects upload after a break was recorded | `screenshots.e2e.test.ts` "registered before the break synced…" | PASS |
| API removes a stored screenshot when an earlier break is recorded | "stored, then a break recorded with an earlier time…" | PASS |
| Clock-out recorded earlier removes; ended break does not | "a clock-out recorded before a stored capture…" | PASS |
| Concurrent break start and upload, both orders | "break start and upload racing…" | PASS |
| Privacy guard portable to Windows paths/CRLF | `privacy-apis.test.ts` (macOS run) | PASS on macOS; Windows NOT RUN |

## Physical runtime matrix (Phase 6)

Every row needs a person at the machine and a non-production API with dedicated QA accounts. None were available.

| # | Scenario | macOS (Apple Silicon) | Windows x64 |
|---|---|---|---|
| 1 | Active ≥ 2 min | BLOCKED | BLOCKED |
| 2 | Idle beyond threshold | BLOCKED | BLOCKED |
| 3 | Return to activity | BLOCKED | BLOCKED |
| 4 | Start break while active | BLOCKED | BLOCKED |
| 5 | Mouse / keyboard during break stays ON_BREAK | BLOCKED | BLOCKED |
| 6 | Wait past the screenshot interval during break: 0 captures, 0 uploads | BLOCKED | BLOCKED |
| 7 | End break, state recalculated from fresh input | BLOCKED | BLOCKED |
| 8 | Clock out | BLOCKED | BLOCKED |
| 9 | Network disconnect / reconnect | BLOCKED | BLOCKED |
| 10 | App restart | BLOCKED | BLOCKED |
| 11 | Lock / unlock, sleep / wake | BLOCKED | BLOCKED |
| W | Mouse move, click, scroll, keyboard, repeated transitions, session switch, RDP disconnect | n/a | BLOCKED |

Layers to check per row: native collector, desktop state, API request/response, database, dashboard (Super Admin,
IT Admin, Employee), attendance timeline, screenshot queue and storage.

### How to unblock (owner)

- **macOS:** at the Mac, with anything sensitive closed:
  `pnpm build && pnpm --filter @workfolio/desktop verify:screenshots` (throwaway local API and storage; deletes its
  test screenshots at the end; replaces the app's dev sign-in in the Keychain). With the new idle gate, **move the
  mouse at least every 4 minutes** while it waits for captures, or it will (correctly) report no capture.
  `verify:native` still expects "unobserved" on lock (stale since `4d66269`; remediation item 2) — update it first.
- **Windows:** dispatch the Windows CI job on a pushed branch to get a 0.2.0 installer, install on a Windows 10/11
  x64 PC pointed at a non-production API, and run `docs/qa/WINDOWS-RUNTIME-TEST-CHECKLIST.md`.

## Remaining limitations

- No physical evidence on either OS for live state, break behaviour or zero-capture-during-break.
- Windows hidden-window timer behaviour (remediation item 6) unmeasured.
- Server-side ordering relies on the single-process `EmployeeLocks`.
