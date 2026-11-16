# Windows screenshot privacy verification (2026-11-16)

**Verdict: NOT VERIFIED on Windows.** There is no runtime evidence on Windows that screenshots are impossible
during a break, while idle, locked or clocked out. The break/idle hardening (0.2.0) has never run on Windows.
No isolated QA screenshot environment was available to this session; production screenshot settings were not
read or changed.

## Production observation (needs the owner)

The earlier on-PC session found **one screenshot captured on this Windows PC at 17:09:27 IST today and confirmed
stored by production at 17:10:09 IST** (local queue row `STORED`, 1920×1080), under an account it could not
identify. The app only captures when the server policy allows it, so screenshots appear to be **enabled in
production** for that account. Action: check Settings → Screenshots (organisation) and the per-employee setting,
and confirm which account is signed in on the PC.

## Break-specific proof (required steps)

| Step | Status |
|---|---|
| 1. Start break while ACTIVE | BLOCKED |
| 2. Native worker paused (`screenshot_status` mode `PAUSED_BREAK`, `capturing: false`) | BLOCKED |
| 3. Wait > interval (60 s minimum policy) | BLOCKED |
| 4. Zero new local files (`%LOCALAPPDATA%\<identity>\screenshots`) and zero new queue rows | BLOCKED |
| 5. Zero `POST /screenshots/register` / `PUT /screenshots/:id/content` | BLOCKED |
| 6. Mouse and typing throughout | BLOCKED |
| 7. Status stays ON_BREAK (app and overview) | BLOCKED |
| 8. End break | BLOCKED |
| 9. Capture eligibility recalculated (next capture only after a fresh interval, only while ACTIVE) | BLOCKED |

## Other gates

| Gate | Windows runtime | Code / automated evidence (Mac, not runtime) |
|---|---|---|
| Consent and policy gates | BLOCKED | `decideScreenshots` tests pass |
| Capture only while ACTIVE / none while IDLE | BLOCKED | 0.2.0 native gate + `idle_is_never_captured_and_input_resumes_capture` |
| None while ON_BREAK | BLOCKED | halt-before-timestamp (0.2.0), generation check, upload hold, API register/upload/attendance checks; API race tests pass |
| None after clock-out | BLOCKED | API segment checks; tests pass |
| None while locked / asleep / display off / other session | BLOCKED | `session_capturable()` + Windows display-state notification (static) |
| Interval, masking, blur, WebP | BLOCKED | Rust tests pass on macOS; Windows Rust tests last passed in CI for `4d66269` |
| Upload queue, retry, OneDrive confirmation | BLOCKED | API stores only after provider confirms size + QuickXorHash |
| Deletion and retention | BLOCKED | API e2e tests pass |

## Safe way to unblock

Throwaway local API on the PC (`SCREENSHOT_STORAGE=local`, temporary SQLite), QA debug identity, throwaway
employee, screenshots enabled **only in that database**, a synthetic full-screen test pattern on the display,
`--keep` off so test images are deleted afterwards. OneDrive screenshot upload stays BLOCKED unless the owner
authorises a dedicated QA OneDrive folder.
