# Screenshot privacy during breaks: verification

Date: 2026-11-16. Baseline `4d66269` + local uncommitted changes (see `ACTIVITY-BREAK-SCREENSHOT-ROOT-CAUSE.md`).
Production screenshot settings were not read or changed. No screenshot was enabled for anyone.

## Gates, layer by layer

| Layer | Gate | Where | Automated evidence | Runtime evidence |
|---|---|---|---|---|
| Desktop decision | No capture unless: signed in, device ACTIVE, org switch on, current screenshot notice acknowledged, policy fresh (< 24 h), attendance known, **clocked in and not on a break**, attendance verifiable, OS permission | `monitoring.ts` `decideScreenshots` | `test/screenshots.test.ts` (existing) | NOT RUN |
| Desktop press | Native worker paused **before** the break / clock-out time is taken; re-apply held until the event is queued | `main.ts` click handler, `screenshot-ui.ts` `halt()`/`release()` | Typecheck only (DOM + Tauri glue; no unit harness) | NOT RUN |
| Native worker, before capture | Mode ACTIVE with scope, permission, not locked / asleep / other session, **not idle**, storage | `screenshot.rs` `tick` | `idle_is_never_captured_and_input_resumes_capture` (new), `break_clock_out_permission_lock_and_errors_prevent_capture` | NOT RUN |
| Native worker, after capture | Frame dropped if the configuration changed (break / clock-out), or lock / sleep happened, while it was taken; checked under the state lock before saving | `screenshot.rs` `tick` | `a_capture_racing_a_break_or_lock_is_discarded` | NOT RUN |
| Upload queue | Nothing sent while attendance is unsynced or **on a break**; each row re-checked against the known session (break, before clock-in, after clock-out) before register and before upload; ineligible = never sent, marked locally REJECTED with a fixed reason | `screenshot-sync.ts` | `eligibility: …`, `upload: nothing is sent during a break, …` (new) | NOT RUN |
| API register | Policy, notice, masks, blur, interval, and capture time strictly inside clocked-in non-break time, at capture time | `screenshots.service.ts` `register` | existing `screenshots.e2e.test.ts` | — |
| API upload | Capture time re-checked under the attendance lock; outside → `DELETED`, 410, no file | `screenshots.service.ts` `upload` | `registered before the break synced, uploaded after: rejected (410)…` (new) | — |
| API attendance | Accepted break start / clock-out removes any screenshot already received whose capture time is now outside work time (file deleted, row `DELETED`) | `attendance.service.ts` `endWorkTime` → `discardOutsideWork` | `stored, then a break recorded with an earlier time…`, `a clock-out recorded before…` (new) | — |
| API race | Concurrent break sync and upload, both orders: the screenshot ends `DELETED`, no file | lock ordering | `break start and upload racing…` (new) | — |

## Privacy defaults (verified in code and tests)

| Default | Status |
|---|---|
| Screenshots off organisation-wide by default | Existing test `off by default…` passes |
| Idle capture | **Off, not configurable** (new native gate) |
| Break capture | Prohibited at decision, native, upload and API layers |
| Clocked-out capture | Prohibited (decision `STOPPED`, API segment check) |
| Locked / asleep / other session / unobserved | Prohibited (native checks before and after capture) |
| Unacknowledged notice | Prohibited (`AWAITING_CONSENT`; API checks the acknowledgement time) |

## Is a screenshot during a break possible?

With an unmodified client: the native worker is paused before the break is timestamped, a capture in flight is
discarded, nothing uploads during the break, and both the client and the API re-check capture times. With a modified
client, the API is the boundary: any screenshot whose capture time is inside a **recorded** break is rejected at
register, rejected at upload, or deleted when the break is recorded — in any order. Residual cases:

1. A storage failure while deleting during `discardOutsideWork` leaves that one row STORED (logged as an error).
2. A break the server never receives cannot be enforced server-side.
3. Admin corrections that add a break later do not purge screenshots (policy decision, see root-cause report).
4. Not yet verified on real hardware: **zero captures / zero uploads during a real break has not been observed on
   a physical Mac or Windows PC** (Phase 6 is BLOCKED). The claim above rests on code review and automated tests.
