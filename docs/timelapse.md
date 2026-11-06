# Screenshot timelapse

An admin chooses an employee and one work session in the screenshot gallery and gets an MP4 of
that session's **already-stored** screenshots, in capture order. Nothing extra is captured, the
capture interval is not changed. Privacy masks applied at capture (docs/screenshot-masks.md) stay
black because the video uses the stored bytes; nothing else is masked or blurred.

## What a video contains

- **Frames:** the stored (`STORED`) screenshots of one attendance session and of that session's
  employee only. They are ordered by `captured_at` (the server-corrected capture time) and then
  by id; filename and upload order play no part.
- **What is left out:**
  - screenshots still awaiting upload;
  - screenshots deleted under retention;
  - any file that is missing from storage, or whose size, SHA-256 or WebP dimensions differ from
    the registration.
  
  Left-out frames are counted (`framesSkipped`) and shown in the dashboard. Breaks have no
  screenshots, so they are simply absent from the video.
- **Output:** H.264 (libx264), yuv420p, 1280×720, no audio, `+faststart`. Each screenshot is
  scaled to fit and letterboxed, never stretched.
- **Duration:** `frames / fps`, with fps chosen per video from 1 to 30 (default 8). The dashboard
  shows the estimate before you create a video.

## Who can use it

- **Admins only** (`screenshots:read`, the same permission as the gallery). Employees get 403 on
  every timelapse endpoint, and no permission was broadened.
- **The employee comes from the session, never from the request.** The create body accepts only
  `sessionId`, `fps` and `confirm`; any other field is rejected.
- **Every action is checked and logged.** Create, status, view, download, cancel and delete are
  each authorized; the five actions that touch a video are written to the append-only
  `timelapse_access_log` (user, timelapse, action, time). Views and downloads of a timelapse are
  **not** written to the per-screenshot access log; the session id links them.
- **The video only travels through the API.** The browser fetches it into a short-lived `blob:`
  URL, as the gallery does for images, with these headers:
  - `no-store`
  - `nosniff`
  - `CSP sandbox`
  - `CORP same-site`
  - `Repr-Digest` (the SHA-256 of the file)
  
  No file path, storage key or shareable URL is ever returned.

## API (`/api/v1`, admin session)

| Method and path | Purpose |
| --- | --- |
| `GET /timelapses?employeeId&from&to&tz` | Sessions that started in the range, with stored, awaiting and deleted counts, the latest job, and whether the encoder is available |
| `POST /timelapses` `{sessionId, fps?, confirm?}` | 202 with the job. If one is already queued or encoding for that session, that job is returned instead |
| `GET /timelapses/:id` | Status and progress (`framesDone` of `framesTotal`) |
| `POST /timelapses/:id/cancel` | Stops a queued or encoding job and deletes its partial file |
| `DELETE /timelapses/:id` | Deletes the video now (cancels the job if it is still running). The record and log are kept |
| `GET /timelapses/:id/content[?download=true]` | The MP4, logged as `VIEW` or, with `download=true`, as `DOWNLOAD` |

Errors:

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, or confirmation needed for more than 600 frames |
| 404 | Unknown session or job |
| 409 | Not ready yet, or already finished |
| 410 | Video expired or deleted |
| 422 | Fewer than 2 or more than 2000 stored screenshots |
| 429 | The queue is full |
| 503 | No usable encoder on this server |

## Automatic daily videos (F01)

- **Setting:** "Generate daily timelapse automatically" in the screenshot settings (`autoTimelapse`,
  part of each screenshot policy version, migration 0028). Off by default.
- **When on:** every 15 minutes the API checks sessions that are clocked out and whose employee's
  local day (the local date of clock-in, in their profile time zone) has ended, in the last 3 days,
  and queues one video per session with 2–2000 stored screenshots. One job per session, not one per
  employee-day: a day with several shifts gets several videos.
- **Once only:** a session never gets a second automatic job, nor one while a manual job is queued,
  encoding or ready. Jobs are marked `automatic: true`; `requestedBy` is the admin whose settings
  version turned the setting on, and the CREATE row in the access log is attributed to them.
- **Same rules as manual videos:** the same job table, queue (always leaving one slot free for admins),
  limits, stored-screenshot frames (deleted screenshots never), TTL and retention sweep. Not durable:
  the files are the same short-lived videos in file storage.
- **Single API instance** only, like the rest of the queue.

## Processing and limits (`TIMELAPSE_LIMITS` in `packages/shared/src/timelapse.ts`)

- **Jobs:**
  - Jobs are rows in `timelapses` (migration 0008). A partial unique index allows only one queued
    or running job per session.
  - At most 4 jobs can wait. One encodes at a time, oldest first, inside the API process's
    worker; the encoding itself runs in a separate **FFmpeg process** with one decoding thread and
    two encoding threads.
- **Memory:** frames are streamed to FFmpeg's stdin one at a time, so memory holds about one
  screenshot (≤ 10 MB), never the whole day.
- **Hard limits:**

  | Limit | Value |
  | --- | --- |
  | Frames per video | 2 to 2000 |
  | Confirmation required | above 600 frames |
  | Output size | 150 MB (`-fs`; reaching it fails the job) |
  | Time per job | 15 minutes (FFmpeg is killed) |

- **Files:**
  - The partial file `<id>.mp4.part` is renamed to `<id>.mp4` only on success, then the file
    is set to 0600; the directory is 0700.
  - The SHA-256 and size are recorded. Every read re-checks the size, and a mismatch removes the
    video (410).
- **Failures and retries:**
  - Failure, cancellation, timeout or shutdown deletes the partial file.
  - On startup, a job left `RUNNING` is marked `FAILED` ("interrupted"), and `*.mp4` /
    `*.mp4.part` files that have no `READY` record are deleted. The sweep touches only those
    names, so a misconfigured `TIMELAPSE_DIR` never loses other files.
  - A retry is a new job with a new file, so retries cannot leave orphaned files.

## Storage, expiry and retention (policy)

- **Location (2026-11-03):** videos are encoded in `TIMELAPSE_DIR` (scratch), then **stored with the file
  storage provider** (OneDrive in production: `timelapses/<employee id>/<id>.mp4`) and removed from the
  API host. The size the provider reports must match before the job is READY; reads stream back through
  the API. They are still derived, short-lived data (the expiry rules below delete them from storage) and
  can be made again from the screenshots.
- **When a video is deleted** (on a 5-minute sweep, and before every listing or read):
  - `TIMELAPSE_TTL_HOURS` (default 24) after it was made;
  - as soon as **any screenshot of its session is deleted after the video was made**. Retention
    therefore never leaves a video showing deleted screenshots;
  - when an admin deletes it;
  - when a newer video of the same session is ready ("Create again"), so each session keeps at
    most one video on disk.
- **Records stay:** the `timelapses` row stays (status `EXPIRED` or `DELETED`) as the record of
  who made it.
- **Scope:** this storage choice was approved for this feature. It does not use Microsoft Graph,
  so it is not blocked by the Graph verification gap.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `FFMPEG_PATH` | `ffmpeg` | Must have `libx264` and the `webp_pipe` demuxer. Checked at startup; if they are missing, the feature reports itself unavailable (dashboard warning, 503 on create), and the rest of the API is unaffected |
| `TIMELAPSE_DIR` | `./data/timelapses` | Must be on persistent local disk, readable only by the API user. Gitignored. When unset under `NODE_ENV=test`, a new temporary folder is used, so tests never sweep a real one |
| `TIMELAPSE_TTL_HOURS` | `24` | 1–168 |
| `TIMELAPSE_MIN_FREE_MB` | `1024` (`2048` in the VPS template) | Disk guard: while the `TIMELAPSE_DIR` filesystem has less than this plus one maximum video (150 MB) free, creating a video answers 503 "low on disk space", automatic jobs fail with the same reason and a warning is logged (`monitor.sh` alerts on it). `0` disables. Protects the database, which shares the disk on the VPS |

## Production prerequisites (Hostinger VPS selected 2026-11-05; not installed yet)

On the VPS: `install-vps.sh` installs Ubuntu's `ffmpeg` package (libx264 + `webp_pipe`, both checked),
`FFMPEG_PATH=/usr/bin/ffmpeg`, `TIMELAPSE_DIR=/var/lib/workfolio/tmp/timelapses` (0700 scratch, emptied after
each OneDrive upload, tmpfiles.d age 2 days), encoding under the API unit's memory limit. See `deploy/README.md`
"FFmpeg" and "Logs, temporary files, disk". The general requirements:

- **Install FFmpeg** with libx264 on the API host, for example from the distribution's packages.
  - Licensing: libx264 is GPL and H.264 is patent-encumbered. FFmpeg runs as a separate
    program and is not linked or bundled. The organization must accept that use.
  - Check with `ffmpeg -hide_banner -encoders | grep libx264`.
- **Disk:** enough for the queue plus 24 h of videos: at most one per session, each ≤ 150 MB
  (typically well under 10 MB). There is no total cap across sessions. Include the directory in the host's disk monitoring.
- **CPU:** one encode at a time: one decoding thread and two encoding threads. Check the timing
  on the real host (see "Verification" below for this Mac's figures).
- **Single API instance** (docs/deployment.md). Several instances would each have their own
  queue and files.
- **Privacy:**
  - The screenshot notice says only administrators can view screenshots and that every view is
    logged. That remains true, but it does not mention videos made from them. Whether the notice
    should say so (a new notice version means everyone acknowledges again) is an **HR/Legal
    decision**.
  - Videos show whatever the stored screenshots show: only the admin-defined privacy masks
    (docs/screenshot-masks.md) are black. There is no app exclusion and no automatic redaction.

## Verification

- `pnpm --filter @workfolio/api test` → `test/timelapse.e2e.test.ts`. Most tests use a fake
  encoder: they cover authorization, ordering, bad frames, limits, duplicates, cancellation,
  cleanup and retention. Two tests run the **real FFmpeg** on synthetic WebP frames; they skip
  with a reason when FFmpeg is missing.
- `pnpm build && pnpm --filter @workfolio/dashboard verify:timelapse` runs:
  - a throwaway API with the real FFmpeg;
  - the production dashboard;
  - headless Chrome;
  - frames that Chrome encodes from synthetic canvases.
  
  It checks create, progress, preview, download (ffprobe), delete, retry then cancel while
  encoding, the large-video confirmation step (a 601-frame session: asked first, "Not now"
  creates nothing, confirming queues one job), the insufficient, unavailable and error states,
  mobile width, and the access log. Last run 2026-10-29: 22/22.
- **Measured on this Mac (Apple silicon, 2026-10-28):**

  | Input | Video | Wall time | CPU | Peak memory (FFmpeg) |
  | --- | --- | ---: | ---: | ---: |
  | 600 synthetic 1920×1080 text-like frames (95 MB WebP) | 75.0 s, 600 frames, 5.8 MB | 15.8 s | ~1.5 cores average | ~121 MB |

- **Local verification only.** No production host, real employee screenshots or Microsoft Graph
  were involved.
