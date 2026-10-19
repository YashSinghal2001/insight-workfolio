# Master checklist

Created Day 8 (no earlier checklist existed in the repository; reconstructed from the Day 1–8
specifications and reports). **DONE** = implemented *and* verified at runtime as required (automated
tests, and real-device/real-service checks where the item needs them). **PARTIAL** = implemented,
some required runtime verification still pending. **BLOCKED** = needs something outside the repo
(credentials, hardware, decisions). **PENDING** = not started / later day. Code existing is never
enough for DONE.

| # | Area | Item | Status | Evidence / what is missing |
| --- | --- | --- | --- | --- |
| 1 | Foundation | Monorepo, API health/readiness, dashboard shell, desktop shell, shared packages | DONE | Day 1; CI-style `pnpm typecheck/lint/build/test` green |
| 2 | Auth | Email/password, sessions, refresh rotation, RBAC, admin bootstrap CLI | DONE | auth e2e tests; dashboard + desktop sign-in used in native runs |
| 3 | Employees | Employee management API + dashboard | DONE | e2e + smoke |
| 4 | Devices | Device registration (random installation ID), revocation | DONE (macOS) | e2e; native runs. Windows Credential Manager untested |
| 5 | Attendance | State machine, offline SQLite queue, sync, admin overview | DONE (macOS) | e2e, Rust queue tests, native runs (clock-in/break/clock-out) |
| 6 | Timesheets | Policy, daily/weekly, overtime, incomplete shifts, corrections with audit | DONE | e2e + shared tests |
| 7 | Activity | Foreground app + idle on macOS, consent-gated, attendance-driven | DONE (macOS) | Native lock and sleep PASSED with a person on the earlier build (reported by the user). Re-run on the build with the idle-overcount fix, 2026-10-19, `verify:native` (5 s / 30 s dev values): **8/8 PASS, none skipped**: app switching (3 apps), idle (46 of 47 s idle), resume after input, screen lock (30 s, idle, no active time), sleep/wake (77 s, nothing recorded), break, clock-out (everything uploaded, nothing rejected), no overlaps (18 intervals) |
| 8 | Activity | Accuracy (midpoint switches, unobserved gaps, batching, automatic foreground switches), reports, freshness, warnings | DONE | Rust 100k-sample test, e2e incl. 12k intervals. 2026-10-19 fix: an app coming to the front without input no longer extends active time; deterministic regression tests A–H + 50k-sample invariance test pass (they fail on the old code). New build: `pnpm build` succeeds; native harness `verify:native` 8/8 PASS, 0 skipped, no regressions (see 7). **The harness does not trigger the exact automatic foreground switch + idle threshold scenario; that case is verified by the deterministic tests only, not natively** |
| 9 | Activity | Server-controlled settings + history, notice versions, consent history | DONE | e2e |
| 10 | Activity | Retention: approval gate, dry run, run log | DONE (code+tests) / not enabled | e2e; awaiting HR/Legal approval of the period |
| 11 | Screenshots | ScreenCaptureKit capture, primary display only, permission handling, WebP | PARTIAL | Native PASS: permission, capture, break, resume, clock-out, files intact. **Outstanding: screenshot sleep retest with the Mac asleep for at least 60 s** (`verify:screenshots`; longer than the 60 s capture interval, to prove no capture during sleep and none at wake). Lock: see the `verify:screenshots` procedure below |
| 12 | Screenshots | Durable local queue, atomic writes, crash recovery, retries, storage cap, grace cleanup | DONE | Rust tests (incl. crash recovery, cap, backoff); native run drained queue |
| 13 | Screenshots | Policy (enabled, interval, quality, resolution, retention, notice, self-view) | DONE | e2e |
| 14 | Screenshots | Metadata API, brokered upload, idempotency, rate limit, integrity checks | DONE | e2e (incl. restart, interrupted upload, concurrency); native run |
| 15 | Screenshots | Storage interface + dev-only local adapter | DONE | e2e + native run |
| 16 | Screenshots | Microsoft Graph adapter (secret/cert, site scope, QuickXorHash, delete modes) | **BLOCKED** | Fake-Graph tests pass; **no tenant credentials** → `verify:graph` reports BLOCKED. Not production-ready |
| 17 | Screenshots | Admin gallery (filters, pagination, thumbnails, secure viewer, counts) | DONE (local storage) | e2e + `pnpm --filter @workfolio/dashboard verify:gallery` (18/18, 2026-10-19): real API + production dashboard + headless Chrome; real WebP files (Chrome-encoded, synthetic content) through register/upload: thumbnails, filters, pagination, empty/error states, viewer, no-cache headers, access log. Day 8 earlier run used real captured data (not reproducible: test images deleted). With Graph: blocked by 16 |
| 18 | Screenshots | Access control (admin, owner if allowed), access audit, secure headers, bounded delivery | DONE | e2e; `verify:gallery` checks headers and audit in a real browser; Graph downloads capped at 10 MB while streaming (2026-10-19, fake-Graph test) |
| 19 | Screenshots | Retention: gate, dry run, run log, cloud delete, recycle-bin caveat | PARTIAL | e2e with local storage; **cloud deletion and recycle bin unverified** (blocked by 16); not approved |
| 20 | Screenshots | Privacy safeguards documented; app exclusions / masking | PARTIAL | Documented (security.md); **no masking or app exclusions implemented** (needs HR/Legal list) |
| 21 | Desktop | Single instance (no duplicate workers) | DONE (macOS) | Rust test; Windows mutex pending |
| 22 | Consent | Notice wording final (activity + screenshots) | BLOCKED | Drafts only; HR/Legal review |
| 23 | Windows | Collector, screenshots, credential store, packaging | BLOCKED | No Windows machine; plan in windows.md. **No Windows support claimed** |
| 24 | Infra | Turso production database | BLOCKED | Not provisioned |
| 25 | Infra | Code signing (Apple Developer ID, Windows cert), notarization | PENDING (Day 9) | Certificates needed |
| 26 | Infra | Hosting / deployment, TLS reverse proxy | PENDING (Day 9) | Not approved; nothing deployed |
| 27 | Infra | Git remote / CI | BLOCKED | No remote; repository is not a git repo |
| 28 | Reporting | Exports, employee overview with real data | PENDING | Later day |
| 29 | Hardening | End-to-end pilot readiness review | PENDING (Day 10) | |

## Native verification procedures (need a person at the Mac)

Both harnesses start a throwaway API, open the real debug app with instructions at the top of its
window, detect each real OS event and print PASS / FAIL / SKIPPED. Nothing is simulated.

```bash
pnpm build
pnpm --filter @workfolio/desktop verify:native        # activity: apps, idle, LOCK, SLEEP, break, clock-out (~8 min)
pnpm --filter @workfolio/desktop verify:screenshots   # screenshots: capture, break, LOCK, SLEEP, clock-out (~10 min)
```

- **Lock step:** when the banner says so, press Control-Command-Q, stay locked (activity: ~20 s;
  screenshots: ~80 s, longer than the 60 s interval), then unlock with your password/Touch ID.
  Expected: activity counts the locked time as idle with no active time; no screenshot while locked
  (the app shows "Not taken: the screen was locked").
- **Sleep step:** Apple menu › Sleep (or close the lid), wait at least 60 s, wake and unlock.
  Expected: nothing recorded during sleep, no screenshot at wake (the interval restarts), monitoring
  resumes after unlock.
- Hide anything sensitive before `verify:screenshots`; it captures the real main screen. Test images
  are deleted at the end and never displayed.
