# Release readiness: desktop 0.2.0

Date: 2026-11-16. Verdict: **NOT READY.** Code is ready for physical testing; no 0.2.0 installer has been built.

## Done locally (uncommitted)

- Version set to **0.2.0** in `apps/desktop/package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
  (and `Cargo.lock`), so a new build is distinguishable from the served 0.1.0.
- Windows CI blocker fixed in `apps/desktop/test/privacy-apis.test.ts` (verified on macOS only).
- Break / idle / screenshot changes listed in `ACTIVITY-BREAK-SCREENSHOT-ROOT-CAUSE.md`.
- All automated suites and production builds pass on macOS (`CROSS-PLATFORM-ACTIVITY-TEST-RESULTS.md`).

## Not done (deliberately)

| Step | Status | Why |
|---|---|---|
| Build Windows x64 installer | BLOCKED | Built only by CI; dispatching CI needs a push (not allowed in this task) |
| Build macOS installer | NOT RUN | Phase 7 is gated on Phase 6 runtime tests passing; they are BLOCKED |
| Installer hashes / architecture | NOT RUN | No installer |
| `apps/dashboard/src/lib/desktop-releases.json` | Unchanged | Would advertise an untested build; still lists the served 0.1.0 files |
| Replace `apps/dashboard/public/downloads/*` | Unchanged | Same |
| Deploy | Not done | Requires separate approval |

## Steps before production release

1. Review and commit these changes on a branch; push; confirm the Windows CI job is green (TS 83/83, cargo test,
   clippy) and that it builds the NSIS installer with the production API URL. Record its SHA-256.
2. Build the macOS installer from the same commit: `WORKFOLIO_API_URL=<prod https API> WORKFOLIO_DASHBOARD_URL=<prod https dashboard> pnpm --filter @workfolio/desktop package -- --target universal-apple-darwin`;
   check `lipo -archs` / universal status and record SHA-256.
3. Run the Phase 6 matrix on a physical Mac and a physical Windows PC against a **non-production** API with QA
   accounts; for the break rows, record 0 captures (native status / local queue) and 0 uploads (API rows, storage).
4. Deploy the API change (screenshot upload re-check and break-time discard) **before** shipping 0.2.0 clients.
   It is backward compatible with 0.1.0 clients: a 410 is already handled as "rejected, not retried".
5. Update `desktop-releases.json` (version 0.2.0, date, sizes, SHA-256) and replace the download files; run the
   dashboard smoke test (it verifies the files and hashes).
6. Unsigned builds: Windows SmartScreen ("Windows protected your PC" → More info → Run anyway) and macOS Gatekeeper
   (right-click → Open, or System Settings → Privacy & Security → Open Anyway) will warn. Code signing is still open.
7. Decide the two policy questions in the root-cause report (admin corrections over captured time; clock-out while
   on a break).
