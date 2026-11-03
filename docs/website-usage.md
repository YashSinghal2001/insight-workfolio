# Website usage tracking (F04): domain names only, gated

**Status: implemented; verified locally with the real extension in Google Chrome and Brave, and with
the packaged macOS app (see Verification). NOT approved for use; Windows NOT verified.** The current
employee notices, the desktop banner and the dashboard all say websites are never recorded.
Collection stays off unless every gate below is open, and in production it is blocked until the
server operator confirms HR/Legal approval.

## Architecture findings (audit, 2026-10-30)

| Question | Finding |
| --- | --- |
| Existing browser or website code | None. The activity collector reads the frontmost application's name and bundle id (`NSWorkspace`) and idle time only; ScreenCaptureKit is used for screenshots. Neither can tell which website a browser shows |
| macOS options considered | (1) Apple Events / AppleScript to ask Safari or Chrome for the active tab URL: needs an Automation permission per browser, returns the full URL to the app, and Safari exposes no private-window flag, so private browsing could be read. (2) Accessibility API on the address bar: a broad, invasive permission that reads the full URL. (3) Browser history databases: forbidden. (4) **A browser extension** the employee installs and connects: visible, minimal permissions, can be kept out of incognito, and can reduce the address to a domain inside the browser |
| Chosen | **(4) A Chromium Manifest V3 extension** (`apps/browser-extension`). The desktop app reads nothing from browsers |

## What is recorded, and what never is

| Recorded | Never recorded |
| --- | --- |
| Domain name only (lowercase, punycode, no leading `www.`), e.g. `docs.example.com` | Paths, query strings, fragments, ports, user info |
| Start and end time of each interval (corrected to server time), duration | Page titles, page content, form entries, passwords, keystrokes |
| Which connected browser sent it (the label given when connecting) | Browser history, bookmarks, downloads, cookies |
| Policy version in force (`policy_seq`), the attendance shift it fell in | Private/incognito windows (the extension is `"incognito": "not_allowed"`) |
| | IP addresses, `localhost`, single-label hosts (rejected as "not a website domain") |
| | Time while the browser is not in front, while idle (the organization's idle threshold), on a break or clocked out |

The extension extracts the host with the URL parser; the full address never leaves the browser. The
server re-validates every domain (`normalizeDomain`) and rejects anything else, and the upload schema
rejects any extra field (URL, title, employee id).

## Gates (all required, checked by the API for every interval)

1. **Policy on** (`website_policies`, off by default; every change needs a reason and is kept).
2. **Production approval**: with `NODE_ENV=production`, `WEBSITE_TRACKING_APPROVED=true` must be set
   by the server operator after HR/Legal approval. An admin turning the policy on is not that approval.
3. **The employee acknowledged the website notice** in force (separate draft notice
   `2026-10-websites-draft-1`, in `monitoring_consents`); intervals before the acknowledgement are refused.
4. **A browser extension the employee connected** with a one-time, 10-minute code from the desktop app.
5. **Clocked in, not on a break**: an interval must lie inside a shift and outside every break.
6. The policy version in force **when the interval started** had tracking on (no backfill); intervals
   older than 24 hours or in the future are refused.

## Design

- **Extension** (`apps/browser-extension`): permissions `tabs` (needed to read the active tab's
  address; Chrome warns "Read your browsing history"), `storage`, `alarms`, `idle`; host permission for
  the API only; no content scripts, no history or cookies API. It records the active tab of the focused
  normal window, splits intervals at 5 minutes, drops intervals under 1 s, queues at most 500 for up to
  23 h, and uploads every 30 s. Badge "ON" while recording, "OFF" when connected but not recording.
  The popup says what is and is never recorded, shows why it is not recording, and can disconnect.
- **Authentication**: the extension never holds the employee's password or session. Pairing exchanges
  the one-time code for a random token; only SHA-256 hashes of codes and tokens are stored
  (`website_extension_links`). The token works only for the extension routes and is revoked from the
  desktop app or the extension. Pairing is rate-limited per address; uploads per connection.
- **Data** (migration `0013_website_usage`, additive): `website_policies` (append-only),
  `website_extension_links`, `website_intervals` (no overlaps per employee, never updated, deleted only
  by retention), `website_category_rules`, `website_audit` (append-only), and the draft notice row.
- **Categories**: admin rules Productive / Neutral / Unproductive; precedence: an EXACT rule for the
  domain, then the most specific "domain and subdomains" rule, else **Unclassified**. Applied at report
  time and labelled as inferred, never stored on the record, never guessed, never turned into scores
  (F05 is separate and not approved).
- **Retention**: per policy (1–365 days, default 30); a scheduled run every 6 hours and a manual run
  delete older intervals; every run is audited with the count.
- **Logs**: ids and counts only, never domains.

## Session state machine (extension) and timestamp authority

Every 5 s while the service worker is awake, on every tab / window / focus / bounds / idle event, and
on the 30 s alarm, the extension asks **"which domain is eligible now?"**: the active tab's host in the
focused, normal, non-minimized, non-incognito window, if the policy state allows recording and
`chrome.idle` says *active* at the organization's idle threshold (`idleSeconds` from the server);
otherwise *none*. `Tracker.observe(host, now)`:

| State | Observation | Result |
| --- | --- | --- |
| Idle (no interval) | a domain | open `{host, start = now}` |
| Open `{host}` | same host, < 5 min since start | extend (`seen = now`) |
| Open `{host}` | same host, ≥ 5 min | close at start + 5 min, open the next piece |
| Open `{host}` | other host / none | close at `now`; open the new host, if any |
| Open `{host}` | **no observation for > 90 s** (Mac asleep, browser not running, worker frozen) | close at the **last observation**, not `now`: the gap is never counted |
| any | closed interval < 1 s | dropped |

Closed intervals queue in `chrome.storage` (≤ 500, ≤ 23 h) and upload every 30 s; failures stay
queued (API outage), duplicates are recognised by id.

**Timestamp authority is the server.** Each upload carries `sentAt`; the server shifts every interval
by `received − sentAt` (as for activity) and only then applies the gates (shift, breaks, policy at
interval start, notice acknowledgement, ≤ 24 h, not in the future, no overlap). The browser clock never
decides on its own which shift or policy an interval falls in.

| Situation | Behaviour |
| --- | --- |
| Tab switch, address change | interval ends, next domain starts |
| Browser in background / another app in front | window not focused → nothing counted |
| Window minimized | not counted (`state === "minimized"`, checked on bounds change and every 5 s) |
| Idle past the threshold | nothing counted until active again |
| Sleep / wake | gap rule: at most ~90 s of the last site before sleep can count (worst case); the sleep itself is not |
| Browser closed | nothing; the next start does not backfill (gap rule) |
| Desktop app closed or restarted | collection is in the browser; the gates still need an open shift; the app restores its session |
| Network outage | intervals stay queued and upload later (still subject to the 24 h limit) |
| Extension disabled or removed | nothing collected; the connection stays listed until disconnected from the app |
| Policy turned off / break / clock-out | server refuses new intervals; the extension shows "not recording" at its next state check (≤ 30 s) |

## Supported browsers and operating systems

| Browser | Status |
| --- | --- |
| Google Chrome 156 (macOS) | **Verified** (headless, real extension; and with the packaged app) |
| Brave (Chromium, macOS) | **Verified** (headless, same checks) |
| Microsoft Edge | Expected to work (Chromium MV3, same APIs); **not tested** (not installed) |
| Firefox | **Not supported**: needs an adapted manifest (`background.scripts`, `browser_specific_settings`); not tested |
| Safari | **Not supported**: needs a Safari Web Extension inside an Xcode app; not built |

| OS | Status |
| --- | --- |
| macOS (this Mac, Darwin 27) | Verified (see below) |
| Windows | **Pending, not verified**: no Windows machine available; test plan below |

## Interfaces

- **Admin dashboard "Websites" page** (Super Admin and Admin alike): overview (total, unclassified,
  employees with activity), domains with the number of employees, employees, **employee daily detail**
  (date, employee, domain, time, category), filters (date range, employee, domain incl. subdomains,
  category), category rules (new rules default to **Unclassified**; precedence EXACT > most specific
  subdomain rule > Unclassified), policy (on/off, version, retention, notice version, required reason,
  history), **notification status** per employee (acknowledged when, connected browsers), retention
  run, audit log, warnings. No rankings or scores.
- **Employee web dashboard (`/my`)**: website activity status and reasons, what is / is never
  recorded, notice with acknowledgement, connected browsers (connect code, disconnect), own domains by
  date. Admins are sent to the admin dashboard; employees opening an admin page are sent to `/my`.
- **Desktop "Websites" tab**: the same for the employee. The header shows the identity (Super Admin /
  Admin / Employee) from the server; an admin account sees an admin panel linking to the dashboard,
  never a client-side privilege. Accounts without an employee profile are told tracking does not apply.
- **Roles**: see [roles.md](roles.md).

## Installing and distributing the extension

**Server address and permission.** The extension ships with host access to `http://localhost:4000`
only (development). Any other server is an *optional* permission: at Connect the popup checks the
address (https only; plain http only for `localhost` / `127.0.0.1`; no user name, password, `?` or `#`)
and asks Chrome for exactly that origin (e.g. `https://api.example.com/*`), never all sites. If the
employee clicks Deny, the popup says the permission was not granted and nothing is connected or
recorded. Disconnect gives the permission back. (If the popup closes while Chrome shows the
permission prompt, open it and click Connect again; not yet verified against a deployed API.)

**Build a zip:** `pnpm --filter @workfolio/browser-extension package` (or `node scripts/package.mjs`
in `apps/browser-extension`) writes `apps/browser-extension/dist/insight-workfolio-extension-<version>.zip`
with only the files Chrome loads (no tests or scripts). Icons are generated by `scripts/make-icons.py`
(stdlib only). Bump `version` in `manifest.json` for every release.

**Channels** (the organization chooses; none is set up yet):

| Channel | How | Notes |
| --- | --- | --- |
| Load unpacked (development, pilots) | chrome://extensions → Developer mode → *Load unpacked* → `apps/browser-extension` | Chrome may warn about developer-mode extensions; the extension id depends on the folder path |
| Chrome Web Store, **unlisted** | Upload the zip in the Developer Dashboard, visibility *Unlisted*, share the link | Needs a developer account, a privacy policy and the review; updates are automatic. The `tabs` permission is shown as "Read your browsing history" |
| **Managed policy** (company devices) | Publish (unlisted or private), then push the id with `ExtensionInstallForcelist` (`<id>;https://clients2.google.com/service/update2/crx`) via Google Admin, Group Policy (Windows) or a configuration profile (macOS) | Force-installed: employees cannot remove it. This is a policy/HR decision, not a technical default |

## Windows test plan (pending; never claimed as passed)

Run on a Windows 10/11 machine with the packaged app (`pnpm tauri build`) and Chrome or Edge:

1. Load `apps/browser-extension` unpacked (chrome://extensions or edge://extensions, Developer mode).
2. Sign in to the desktop app as an employee, clock in, acknowledge the website notice, connect the
   browser with the code; badge shows ON.
3. Browse two sites, switch tabs; minimize the window; switch to another app; lock the screen /
   sleep for 2+ minutes; check the Websites tab and the admin report: only domains, no minimized,
   background or sleep time beyond the 90 s worst case.
4. Close and reopen the browser; quit and relaunch the app; stop the network for a minute: queued
   intervals arrive afterwards, nothing duplicated.
5. Disable, then remove the extension; disconnect from the app: no further intervals.
6. Policy off, break, clock-out: nothing recorded. An InPrivate window is never recorded.
7. Record the browser and Windows versions and each result here; until then Windows stays *pending*.

## Before any real use (blockers)

1. HR/Legal approve the website notice and the organization's purpose, retention and access.
2. The activity notice ("websites … never"), the desktop banner and status table, and the dashboard
   texts are revised (they still say websites are never recorded; the Websites tab and these texts
   contradict each other while tracking is on). These statements were not changed in this work.
3. The operator sets `WEBSITE_TRACKING_APPROVED=true` in production.
4. The extension is packaged for the organization's browsers (Chrome Web Store or managed policy), with
   the production API origin granted at Connect (optional host permission, requested for that exact origin); Safari needs a Safari Web Extension (an Xcode app),
   Firefox an adapted manifest.

## Known limitations

- **Private-window time:** the extension cannot see private windows (by design). In the verification
  run (headless Chrome) time spent in an off-the-record window stayed attributed to the last normal
  site (about 2.5 s on `blog.other.test`); the private domain itself was never recorded. Whether
  visible Chrome reports the focus change to the extension was not verified.
- Focus and idle come from Chrome; time in another app counts only while Chrome reports its window as
  focused. Background tabs and media do not count.
- Up to ~90 s of the last site before a sleep can be counted (gap rule worst case); the MV3 service
  worker may be suspended between 30 s alarms, which the 90 s limit tolerates.
- An interval cut by a break or clock-out on the server is refused whole (the extension learns about
  the break at its next state check, within 30 s).

## Verification (2026-10-30, this Mac, synthetic data)

| Layer | Kind | Result |
| --- | --- | --- |
| Domain normalization, category precedence (incl. Unclassified rules), schemas | Unit (shared) | 51/51 (package) |
| Tables: domain CHECK, no overlap, append-only; migration 0014 on existing data | Unit (database) | 15/15 (package) |
| API: every gate per interval, skew, duplicates, overlap, extra fields, breaks/clock-out, isolation, revocation, pairing codes, CSRF exemption only on pairing, reports (overview, daily rows, domain filter, employee counts), notification status, idle threshold, retention, production gate, rate limits | `websites.e2e.test.ts` | 10/10 |
| Roles: Super Admin = Admin on 16 admin routes, employee 403, spoofed headers ignored, safeguards, concurrent demotions, account disabling | `roles.e2e.test.ts` | 5/5 |
| Extension: host extraction, splitting, queue bounds, **90 s gap rule** | Unit (`apps/browser-extension`) | 4/4 |
| Desktop wording, role display, no browser files | Unit (desktop) | 4 (in 38/38) |
| **Real extension, Google Chrome 156**: admin dashboard (Super Admin and IT Admin), employee web dashboard, desktop front end, tab switching, background, minimized, browser close/reopen, private window, breaks, policy off, disconnect, extension removal | `verify:websites` | **33/33** (first run aborted at "dashboard after reopen" under load; rerun 33/33) |
| Same in **Brave** | `BROWSER=brave verify:websites` | **33/33** |
| **Packaged macOS app** (debug bundle) + real Chrome extension: notice, pairing from the app, domains shown in the app, recording indicator, no admin panel for an employee, only domains on the server, restart with restored session, API outage and recovery, disconnect | `verify:websites-packaged` | **9/9** |
| Real Mac sleep with a site in front | `verify:websites-packaged --sleep` (attended) | **Not verified**: first attempt `pmset sleepnow` did not sleep the Mac; second slept ~23 s (woken by the keyboard) and the driver did not register it. The gap rule is unit-tested only |

**Not verified:** Edge (not installed), Firefox and Safari (not supported), Windows (no machine; plan
above), a visible (non-headless) browser window, a real sleep, a signed release build, a production
host, HR/Legal approval (not given), employee notification (not done).
