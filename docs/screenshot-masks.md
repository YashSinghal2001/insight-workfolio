# Screenshot privacy masks (F02)

An admin can define up to 20 rectangles of the employee's main screen that are **filled solid
black on the employee's computer before the screenshot is encoded**. The covered pixels exist
only in memory for the duration of one capture. They are never written to the local queue,
uploaded, stored, shown in the gallery, or used in timelapse videos.

## Audit before this feature (2026-10-29)

| Question | Finding |
| --- | --- |
| Existing masking or redaction | None. `SCContentFilter` with an empty exclusion list; whole primary display captured (audit SS-19, security.md) |
| Where it would have to act | Capture (desktop, Rust), stored image, gallery rendering, timelapse. Every read path serves the same stored bytes: full view, thumbnail, owner self-view and timelapse frames (`screenshots.service.ts` `content`, `timelapse.service.ts` `run`) |
| Visual-only overlays | None existed. None were added: an overlay would leave the original retrievable |
| Can originals expose hidden content | Before: nothing was hidden. Now: the masked pixels are never collected, so no original exists to expose |
| Consistency with timelapses | Automatic: timelapses read the stored (masked) bytes and verify their SHA-256 |

## Design

- **Where:** `apply_masks` in `apps/desktop/src-tauri/src/screenshot.rs`, between capture and WebP
  encoding. Masks are opaque black, not blur: blurred text can sometimes be recovered.
- **Coordinates:** integers 0–10 000, as fractions of the captured frame (`x`, `y`, `w`, `h`).
  One rule fits every resolution and Retina scaling. Edges are rounded outwards, so a mask covers
  at least its share of the frame. On a display with a different aspect ratio, the same fractions
  cover a differently shaped area.
- **Configuration:** part of the screenshot policy (`mask_regions`, migration 0009). It uses the
  same append-only history: every change records the admin, the time and a mandatory reason. Each
  mask has a label (1–60 characters) that the employee sees in the desktop app.
- **Validation:** the shared schema (`screenshotMaskRegionSchema`) requires integers, `w`/`h` ≥ 1,
  the rectangle inside the frame, a label, no extra fields, and at most 20 masks. The database
  CHECK requires a JSON array of at most 20. The desktop re-checks the same rules: invalid masks
  pause capture ("Screenshots paused: the privacy mask settings received from the server are
  invalid") instead of capturing unmasked.
- **Enforcement:** each screenshot registration carries the rectangles the agent applied. The API
  compares them, exactly and in order, with the policy in force at the capture time. A mismatch is
  REJECTED and nothing is stored. Rejected cases include an older agent that sends none, a capture
  taken just before a mask change reached the device, and a modified client. The applied count is
  stored (`screenshots.mask_count`, immutable) and shown in the gallery.
- **Fail closed:** if a stored policy's masks cannot be parsed, screenshots are treated as off for
  that version. Agents stop capturing, registrations are refused, and admins see "off" until a
  valid version is saved.
- **Old screenshots:** unchanged. Masks apply to screenshots captured after the change only.
  Redacting stored images retroactively would mean decoding and re-encoding originals on the
  server (new image dependency, irreversible). That was not done and would need an explicit decision.

## Whole-image blur (desktop side)

- **Where:** `redact` in `apps/desktop/src-tauri/src/screenshot.rs`: masks, then `apply_blur` on the
  whole RGB buffer, then the masks again (so masked areas stay solid black instead of picking up
  light from their surroundings), then WebP encoding. The sharp image exists only in memory for one
  capture; nothing unblurred is written to disk or uploaded.
- **Strength:** three separable box-blur passes (approximately Gaussian) with radius
  `max(8, longest edge / 120)` px: 16 px at 1920, 32 px at 3840 (sigma about the radius, several times
  the height of on-screen text). Tests require edge energy of a synthetic text screen to drop below
  4 % and every 16×16 block to change. Blur is weaker than a mask: it hides text and detail, not
  layout, colours or large shapes. Use a mask for anything that must not be inferable at all.
- **Cost:** O(pixels) per pass, independent of the radius. Extra memory: one row plus `radius + 1`
  rows (~0.4 MB at 3840×2160), never a second frame copy.
- **Configuration:** `screenshot_configure` takes `blur` from the policy (`GET /screenshots/me`).
  Missing (an API from before blur) = off. Any non-boolean value pauses capture with "Screenshots
  paused: the blur setting received from the server is invalid." A change mid-capture discards that
  capture (generation rule).
- **Queue and registration:** each queued row records `blurred` (local SQLite column, default 0 for
  rows queued before the upgrade). Registration sends `blurred`; the API rejects a mismatch with the
  policy in force at capture time, like masks.
- **Employees** see "Screenshots are blurred…" in the screenshot policy text and ", blurred" in the
  tracking line. Not verified on a real screen: needs a person at the Mac.

## Where employees see it

The desktop "My screenshots" tab (F08) shows each screenshot's mask count. The viewer lists the
mask labels: the labels of the policy version in force at the capture time. Registration only
accepts exactly those masks, so the labels describe that image. If they cannot be matched, the
count alone is shown.

## What it does not do

- **Masks are not app exclusions.** A mask hides a fixed part of the screen. A window moved out of
  it is captured, and one moved into it is hidden. Excluding specific apps (ScreenCaptureKit window
  exclusion by bundle ID, or skipping captures while such an app is in front) is not implemented.
  It needs an HR/Legal list of apps.
- **No automatic detection:** no OCR, face detection or sensitive-data detection.
- **Not encryption:** unmasked parts are as sensitive as before.

## Privacy and notice

- Masking only reduces what is collected. It adds no capture, changes no interval and adds no
  input monitoring.
- The desktop app tells the employee which areas are masked, by label. When there are none, it says nothing is masked.
- The current screenshot notice draft says screenshots may contain anything on the main screen.
  That remains true outside the masks. Whether the notice should describe the masks, and which
  areas or apps the organization wants masked, are **HR/Legal decisions**. Nothing here is approved.

## Verification (2026-10-29, this Mac)

| Layer | Kind | Tests |
| --- | --- | --- |
| Pixel masking | Real image processing (Rust, `webp` crate) | Positioning and scaling at 1920×1080, 1366×768 and 1000×1000, outward rounding, edges, full-frame and 1-pixel masks, multiple and overlapping masks, untouched pixels outside, malformed frame safe. A capture through the worker is encoded to WebP on disk, decoded again, and checked black inside both masks and unchanged outside |
| Desktop config and queue | Unit (fake OS) | Invalid masks pause capture. Valid masks resume. Masks recorded per queued screenshot. Old queue files gain the column and report none |
| Desktop upload | Unit (fakes) | Registration carries the masks. Rows from before masks send `[]`. Employee text |
| Schemas | Unit | Bounds, labels, extra fields, at most 20, default none, unreadable stored JSON gives null, exact comparison |
| Database | Unit (in-memory libSQL) | JSON-array CHECK, at most 20, default `[]`, `mask_count` bounds and immutability |
| API | End to end (in-process API, local storage, header-valid fake WebP files) | Admin-only configuration (401/403), invalid input never stored, history with admin and reason, employees receive masks. Registration rejects missing, partial, reordered and shifted masks, judged at capture time. Mask count in gallery, detail and employee list. Full, thumbnail and owner self-view return exactly the uploaded bytes. `variant=original/raw/unmasked/source` and extra switches give 400. Another employee gets 404. Timelapse frames equal the masked uploads (encoder replaced by concatenation). Unreadable stored masks fail closed |

**Not verified:**
- A real ScreenCaptureKit capture of a real screen with masks. That needs a person at the Mac,
  using `verify:screenshots` with masks configured.
- Microsoft Graph storage. Mask enforcement is storage-independent, but Graph itself is unverified.
- A production host.
