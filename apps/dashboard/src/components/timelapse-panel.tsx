"use client";

import { useCallback, useEffect, useState } from "react";
import {
  can,
  TIMELAPSE_LIMITS,
  TIMELAPSE_MIME,
  timelapseDurationSeconds,
  type TimelapseJob,
  type TimelapseSession,
  type TimelapseSessionsResponse,
} from "@workfolio/shared";
import type { Range } from "@/components/range-picker";
import { Badge, buttonClass, Card, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { api, apiBlob, ApiRequestError, errorMessage } from "@/lib/api";

const FPS = [2, 4, 8, 12, 24];
const POLL_MS = 1500;
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");
const seconds = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const ACTIVE = new Set(["QUEUED", "RUNNING"]);
const LABEL: Record<TimelapseJob["status"], string> = {
  QUEUED: "Queued",
  RUNNING: "Creating",
  READY: "Ready",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  EXPIRED: "Removed",
  DELETED: "Deleted",
};

/**
 * Timelapse of one session's stored screenshots (admins). The video is fetched through the API
 * into a short-lived object URL, like screenshots: never a shareable or cached link. Every
 * preview and download is logged by the API.
 */
export function TimelapsePanel({ employeeId, range, tz }: { employeeId: string; range: Range; tz: string }) {
  const [data, setData] = useState<TimelapseSessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState<number>(TIMELAPSE_LIMITS.fps.default);

  const load = useCallback(
    () =>
      api<TimelapseSessionsResponse>(`/timelapses?employeeId=${employeeId}&from=${range.from}&to=${range.to}&tz=${encodeURIComponent(tz)}`).then(
        (d) => (setData(d), setError(null)),
        (e) => setError(errorMessage(e)),
      ),
    [employeeId, range, tz],
  );
  useEffect(() => void load(), [load]);

  return (
    <Card
      title="Timelapse"
      actions={
        <label className="flex items-center gap-2 text-sm">
          <span className="whitespace-nowrap text-xs text-muted">Frames per second</span>
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className={`${inputClass} w-20`}>
            {FPS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      }
    >
      <p className="text-sm text-muted">
        A video of one work session made only from screenshots already captured and stored under the screenshot notice, in capture order,
        one frame each (nothing extra is captured; gaps such as breaks are skipped). It shows exactly the stored screenshots: privacy masks applied at capture stay black, nothing else is blurred or masked. Only administrators can
        create or watch it; every creation, preview and download is logged. Videos are deleted automatically after{" "}
        {data ? `${data.ttlHours} h` : "a short time"}, or as soon as a screenshot in them is deleted under the retention policy.
      </p>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      {!data && !error && <p role="status" className="mt-3 text-sm text-muted">Loading sessions…</p>}
      {data && !data.encoder.available && (
        <div className="mt-3"><Notice tone="warning">Timelapse videos cannot be created on this server: {data.encoder.reason}</Notice></div>
      )}
      {data && data.sessions.length === 0 && <p className="mt-3 text-sm text-muted">No work sessions started in this range.</p>}
      {data && data.sessions.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {/* Keyed by the latest job too: a refreshed list re-initialises the row. */}
          {data.sessions.map((s) => <SessionRow key={`${s.id}:${s.latestJob?.id}:${s.latestJob?.status}`} session={s} fps={fps} canCreate={data.encoder.available} onChange={load} />)}
        </ul>
      )}
    </Card>
  );
}

function SessionRow({ session, fps, canCreate, onChange }: { session: TimelapseSession; fps: number; canCreate: boolean; onChange: () => void }) {
  const { auth } = useAuth();
  // Server-enforced (Super Admin only); the button is simply not offered to anyone else.
  const canDelete = auth.status === "authenticated" && can(auth.me.user, "screenshots:delete");
  const [job, setJob] = useState<TimelapseJob | null>(session.latestJob);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // Poll while queued or encoding; refresh the counts once it ends. A network or server error
  // keeps polling (a new object re-runs this effect); a 4xx stops it.
  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const t = setTimeout(
      () =>
        api<TimelapseJob>(`/timelapses/${job.id}`).then(
          (j) => (setJob(j), setError(null), !ACTIVE.has(j.status) && onChange()),
          (e) => (setError(errorMessage(e)), !(e instanceof ApiRequestError && e.status < 500) && setJob({ ...job })),
        ),
      POLL_MS,
    );
    return () => clearTimeout(t);
  }, [job, onChange]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const create = (confirm: boolean) =>
    act(async () => {
      setConfirming(false);
      setPreview(null);
      setJob(await api<TimelapseJob>("/timelapses", { method: "POST", body: { sessionId: session.id, fps, confirm } }));
    });
  const large = session.stored > TIMELAPSE_LIMITS.confirmAboveFrames;
  const tooFew = session.stored < TIMELAPSE_LIMITS.minFrames;
  const tooMany = session.stored > TIMELAPSE_LIMITS.maxFrames;
  const video = (download: boolean) => apiBlob(`/timelapses/${job!.id}/content${download ? "?download=true" : ""}`, TIMELAPSE_MIME);
  const ready = job?.status === "READY";
  const active = !!job && ACTIVE.has(job.status);

  return (
    <li className="rounded-lg border border-border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{when(session.clockInAt)} – {session.clockOutAt ? when(session.clockOutAt) : <Badge ok>Still clocked in</Badge>}</p>
          <p className="text-xs text-muted">
            {session.stored} stored screenshot(s) → about {seconds(timelapseDurationSeconds(session.stored, fps))} at {fps} fps
            {session.awaitingUpload ? ` · ${session.awaitingUpload} awaiting upload (not included)` : ""}
            {session.deleted ? ` · ${session.deleted} deleted by retention (not included)` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!active && (
            <button
              type="button"
              className={ready ? secondaryButtonClass : buttonClass}
              disabled={busy || !canCreate || tooFew || tooMany}
              onClick={() => (large ? setConfirming(true) : create(false))}
              title={tooFew ? `At least ${TIMELAPSE_LIMITS.minFrames} stored screenshots are needed` : tooMany ? `More than ${TIMELAPSE_LIMITS.maxFrames} screenshots` : undefined}
            >
              {job && ["FAILED", "CANCELLED", "EXPIRED", "DELETED"].includes(job.status) ? "Retry" : ready ? "Create again" : "Create timelapse"}
            </button>
          )}
          {active && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => act(async () => setJob(await api<TimelapseJob>(`/timelapses/${job.id}/cancel`, { method: "POST" })))}>Cancel</button>}
          {ready && !preview && <button type="button" className={buttonClass} disabled={busy} onClick={() => act(async () => setPreview(URL.createObjectURL(await video(false))))}>Preview</button>}
          {ready && (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const url = URL.createObjectURL(await video(true));
                  const a = Object.assign(document.createElement("a"), { href: url, download: `timelapse-${session.clockInAt.slice(0, 10)}.mp4` });
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 10_000);
                })
              }
            >
              Download
            </button>
          )}
          {ready && canDelete && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => act(async () => (await api(`/timelapses/${job.id}`, { method: "DELETE" }), setPreview(null), onChange()))}>Delete video</button>}
        </div>
      </div>

      {(tooFew || tooMany) && !job && (
        <p className="mt-2 text-xs text-muted">{tooFew ? `Not enough stored screenshots for a video (at least ${TIMELAPSE_LIMITS.minFrames}).` : `Too many screenshots for one video (limit ${TIMELAPSE_LIMITS.maxFrames}).`}</p>
      )}
      {confirming && (
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm large timelapse">
          <span>This uses {session.stored} screenshots and takes a while to create. Continue?</span>
          <button type="button" className={buttonClass} onClick={() => create(true)} autoFocus>Create {seconds(timelapseDurationSeconds(session.stored, fps))} video</button>
          <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(false)}>Not now</button>
        </div>
      )}
      {job && (
        <div role="status" aria-live="polite" className="mt-2 text-xs">
          <Badge ok={ready}>{LABEL[job.status]}</Badge>{" "}
          {active && (
            <>
              <progress className="ml-1 h-2 w-40 align-middle" max={job.framesTotal} value={job.status === "RUNNING" ? job.framesDone : undefined} aria-label="Timelapse progress" />{" "}
              <span className="text-muted">{job.status === "RUNNING" ? `${job.framesDone} of ${job.framesTotal} frames` : "Waiting for another video to finish"}</span>
            </>
          )}
          {ready && (
            <span className="text-muted">
              {job.framesDone} frames · {seconds(job.durationSeconds)} · {Math.round((job.sizeBytes ?? 0) / 1024)} KB · deleted {when(job.expiresAt)}
              {job.framesSkipped ? ` · ${job.framesSkipped} screenshot(s) could not be read and were left out` : ""}
            </span>
          )}
          {job.error && <span className="text-muted">{job.error}</span>}
        </div>
      )}
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {preview && (
        <div className="mt-3">
          <video src={preview} controls playsInline className="w-full max-w-3xl rounded border border-border bg-black" aria-label={`Timelapse of the session started ${when(session.clockInAt)}`} />
          <p className="mt-1 text-xs text-muted">Confidential: may contain personal information. This view was logged.</p>
        </div>
      )}
    </li>
  );
}
