"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  can,
  SCREENSHOT_EXPORT_LIMITS,
  SCREENSHOT_MASK_SCALE,
  SCREENSHOT_MIME,
  type Paginated,
  type ScreenshotDeleteResponse,
  type ScreenshotDetail,
  type ScreenshotGalleryItem,
  type ScreenshotOverview,
  type ScreenshotSettingsResponse,
} from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { TimelapsePanel } from "@/components/timelapse-panel";
import { Badge, Card, secondaryButtonClass } from "@/components/ui";
import { api, apiBlob, ApiRequestError, errorMessage } from "@/lib/api";
import { zonedTime } from "@/lib/zoned-time";
import { downloadFile } from "../_components/download";
import { EmployeePicker } from "../_components/employee-picker";
import { IdleBadge, shotFrameClass } from "./idle";

const PAGE_SIZE = 24;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso)) : "—");
/** Capture time in the employee's own time zone (OD-14); the viewer's zone, labelled, if it is not a valid zone. */
const captured = (iso: string, zone: string | undefined) => (zone && zonedTime(iso, zone)) || `${when(iso)} (${TZ})`;
const STATUS = {
  STORED: ["Stored", true],
  REGISTERED: ["Awaiting upload", false],
  DELETED: ["Deleted", false],
} as const;

/**
 * Loads one image through the authenticated API into a short-lived object URL (revoked when the
 * component goes away). The API logs every load; thumbnails are logged as such.
 */
function useImage(id: string | null, variant: "thumbnail" | "full") {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!id) return;
    let url: string | undefined;
    let active = true;
    apiBlob(`/screenshots/${id}/content?variant=${variant}`, SCREENSHOT_MIME).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (active) setState({ url });
        else URL.revokeObjectURL(url);
      },
      (e) => active && setState({ error: errorMessage(e) }),
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setState({});
    };
  }, [id, variant]);
  return state;
}

/** `select`: shown to Super Admins only (bulk export); only stored screenshots can be selected. */
function Thumbnail({ item, onOpen, select }: { item: ScreenshotGalleryItem; onOpen: () => void; select?: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void } }) {
  const zone = item.employee.timezone;
  const { url, error } = useImage(item.uploadStatus === "STORED" ? item.id : null, "thumbnail");
  const [label, ok] = STATUS[item.uploadStatus];
  return (
    <li className={shotFrameClass(item.idle)} data-idle={item.idle || undefined}>
      <button type="button" onClick={onOpen} disabled={item.uploadStatus !== "STORED"} className="block aspect-video w-full bg-background text-xs text-muted disabled:cursor-default" aria-label={`Open screenshot of ${item.employee.fullName} at ${captured(item.capturedAt, zone)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {item.uploadStatus !== "STORED" ? label : url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : error ? <span className="text-red-700 dark:text-red-300">{error}</span> : "Loading…"}
      </button>
      <div className="flex flex-col gap-1 px-3 py-2 text-xs">
        <span className="font-medium">{item.employee.fullName} <span className="text-muted">({item.employee.employeeCode})</span></span>
        <span className="tabular-nums text-muted">{captured(item.capturedAt, zone)}</span>
        {(item.idle || (select && item.uploadStatus === "STORED")) && (
          <span className="flex items-center justify-between gap-2">
            <IdleBadge idle={item.idle} />
            {select && item.uploadStatus === "STORED" && (
              <label className="ml-auto flex items-center gap-1.5">
                <input type="checkbox" checked={select.checked} disabled={select.disabled && !select.checked} onChange={(e) => select.onChange(e.target.checked)} aria-label={`Select screenshot of ${item.employee.fullName} at ${captured(item.capturedAt, zone)}`} />
                Select
              </label>
            )}
          </span>
        )}
        <span><Badge ok={ok}>{label}</Badge> <span className="text-muted">{item.width}×{item.height} · {Math.round(item.fileSizeBytes / 1024)} KB{item.maskCount ? ` · ${item.maskCount} masked area(s)` : ""}</span>{item.blurred && <> <BlurredBadge /></>}</span>
      </div>
    </li>
  );
}

/** The whole image was blurred on the employee's computer before upload (policy or per-person setting). */
function BlurredBadge() {
  return <span title="The whole image was blurred on the employee's computer before it was uploaded" className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-800 dark:text-sky-300">Blurred on device</span>;
}

const pct = (units: number) => `${+(units / (SCREENSHOT_MASK_SCALE / 100)).toFixed(2)}%`;

function deleteError(err: unknown) {
  if (err instanceof ApiRequestError && err.status === 409) return `The screenshot could not be deleted: ${err.message}`;
  if (err instanceof ApiRequestError && err.status === 502) return `Storage did not confirm the deletion, so nothing was changed. Try again later. (${err.message})`;
  return errorMessage(err);
}

function Viewer({ item, canDelete, onClose, onDeleted }: { item: ScreenshotGalleryItem; canDelete: boolean; onClose: () => void; onDeleted: (r: ScreenshotDeleteResponse) => void }) {
  const zone = item.employee.timezone;
  const ref = useRef<HTMLDialogElement>(null);
  const { url, error } = useImage(item.id, "full");
  const [detail, setDetail] = useState<ScreenshotDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    // After the image request, so the access log includes this view.
    if (url || error) api<ScreenshotDetail>(`/screenshots/${item.id}`).then((d) => (setDetail(d), setDetailError(null)), (e) => (setDetail(null), setDetailError(errorMessage(e))));
  }, [item.id, url, error]);
  return (
    <dialog ref={ref} onClose={(e) => e.target === ref.current && onClose()} aria-label={`Screenshot of ${item.employee.fullName}`} className="m-auto max-h-[95vh] w-[min(1200px,95vw)] rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/70">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm">
        <span><strong>{item.employee.fullName}</strong> · {captured(item.capturedAt, zone)} · {item.width}×{item.height}{item.blurred && <> <BlurredBadge /></>} <IdleBadge idle={item.idle} /></span>
        <span className="flex flex-wrap gap-2">
          {canDelete && <Button variant="danger" onClick={() => setConfirming(true)}>Delete screenshot</Button>}
          <button type="button" onClick={() => ref.current?.close()} className={secondaryButtonClass} autoFocus>Close</button>
        </span>
      </div>
      <div className="max-h-[60vh] overflow-auto bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {url ? <img src={url} alt={`Screenshot of ${item.employee.fullName}'s main screen at ${captured(item.capturedAt, zone)}`} className="mx-auto" /> : <p className="p-6 text-sm text-white">{error ?? "Loading…"}</p>}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 text-xs text-muted">
        <p>Confidential: may contain personal information. This view is logged.</p>
        {detailError && <p role="alert" className="text-danger">Details could not be loaded: {detailError}</p>}
        {detail && (
          <p>
            Privacy masks:{" "}
            {detail.masks === null
              ? "unknown (the settings in force at capture could not be matched)"
              : detail.masks.length === 0
                ? "none: the whole main screen was captured"
                : detail.masks.map((m) => `${m.label} (left ${pct(m.x)}, top ${pct(m.y)}, ${pct(m.w)} × ${pct(m.h)})`).join("; ")}
          </p>
        )}
        {detail?.accessLog && (
          <details>
            <summary className="cursor-pointer">Access log ({detail.accessLog.length}), times in {TZ}</summary>
            <ul className="mt-1 max-h-32 overflow-auto">
              {detail.accessLog.map((a, i) => <li key={i} className="tabular-nums">{when(a.accessedAt)} · {a.viewer.email} · {a.action === "VIEW" ? "viewed" : "thumbnail"}</li>)}
            </ul>
          </details>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Delete this screenshot?"
        tone="danger"
        confirmLabel="Delete screenshot"
        description={
          <>
            The image is deleted from storage now and cannot be viewed again; its metadata stays, marked deleted, and the deletion is recorded
            in the audit log with your account and the reason you give. Timelapse videos containing it are removed.
          </>
        }
        reason={{ label: "Reason (required; kept in the audit log)", minLength: 3, maxLength: 500 }}
        onConfirm={async (reason) => {
          try {
            const r = await api<ScreenshotDeleteResponse>(`/screenshots/${item.id}`, { method: "DELETE", body: { reason } });
            onDeleted(r);
            ref.current?.close();
          } catch (err) {
            throw new Error(deleteError(err));
          }
        }}
        onClose={() => setConfirming(false)}
      />
    </dialog>
  );
}

export default function ScreenshotsPage() {
  // useSearchParams suspends for request-time params under cacheComponents.
  return (
    <Suspense fallback={<SkeletonRows label="screenshots" />}>
      <Screenshots />
    </Suspense>
  );
}

function Screenshots() {
  const preset = useSearchParams().get("employeeId");
  const [employeeId, setEmployeeId] = useState(() => (preset && /^[0-9a-f-]{36}$/i.test(preset) ? preset : ""));
  const [retry, setRetry] = useState(0);
  const [ok, setOk] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = useState(1);
  const [gallery, setGallery] = useState<Paginated<ScreenshotGalleryItem> | null>(null);
  const [overview, setOverview] = useState<ScreenshotOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ScreenshotGalleryItem | null>(null);
  const [idleOnly, setIdleOnly] = useState(false);
  // Bulk export (Super Admin): kept across pages and filters until exported or cleared.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const { auth } = useAuth();
  const canDelete = auth.status === "authenticated" && can(auth.me.user, "screenshots:delete");
  // The organisation policy in force (on/off, interval). null = not loaded or not readable; then no state is claimed.
  const [policy, setPolicy] = useState<ScreenshotSettingsResponse["effective"] | null>(null);
  useEffect(() => void api<ScreenshotSettingsResponse>("/settings/screenshots").then((s) => setPolicy(s.effective), () => setPolicy(null)), []);

  useEffect(() => {
    let active = true;
    const q = `from=${range.from}&to=${range.to}&tz=${encodeURIComponent(TZ)}${employeeId ? `&employeeId=${employeeId}` : ""}${idleOnly ? "&idle=true" : ""}`;
    Promise.all([
      api<Paginated<ScreenshotGalleryItem>>(`/screenshots/gallery?${q}&page=${page}&pageSize=${PAGE_SIZE}`),
      api<ScreenshotOverview>(`/screenshots/overview?${q}`),
    ]).then(
      ([g, o]) => active && (setGallery(g), setOverview(o), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [employeeId, range, page, retry, idleOnly]);

  const reset = () => (setGallery(null), setOverview(null), setPage(1));
  const pick = useCallback((id: string) => (setGallery(null), setOverview(null), setPage(1), setEmployeeId(id)), []);
  const pages = gallery ? Math.max(1, Math.ceil(gallery.total / gallery.pageSize)) : 1;
  const r = overview?.retention;
  const full = selected.size >= SCREENSHOT_EXPORT_LIMITS.maxItems;
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on && next.size < SCREENSHOT_EXPORT_LIMITS.maxItems) next.add(id);
      else next.delete(id);
      return next;
    });
  const stored = gallery?.items.filter((i) => i.uploadStatus === "STORED") ?? [];
  const exportSelected = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadFile("/screenshots/export", `screenshots-${new Date().toISOString().slice(0, 10)}.zip`, { method: "POST", body: { ids: [...selected] } });
      setOk(`Exported ${selected.size} screenshot(s). Each one is recorded in its access log, and the export in the audit log.`);
      setSelected(new Set());
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Screenshots"
        about={
          <>
            Screenshots of employees&apos; main screens, taken only while clocked in, not on a break, after they acknowledged the screenshot
            notice. They may contain personal or sensitive information. Only the privacy masks set in Settings are blacked out, on the employee&apos;s computer
            before saving (new screenshots only); nothing is detected automatically. When blur is on (for the organisation or one person), the whole
            image is blurred on the employee&apos;s computer before upload and marked &quot;Blurred on device&quot;. Images are loaded through the API on demand,
            never cached, and every thumbnail and view is logged with your account. The date range is in your time zone ({TZ}); each capture time is
            shown in the employee&apos;s own time zone, which is named next to it.
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <EmployeePicker value={employeeId} onChange={pick} allLabel="All employees" />
        <RangePicker value={range} maxDays={31} timeZone={TZ} onChange={(x) => (reset(), setRange(x))} />
        <button type="button" aria-pressed={idleOnly} onClick={() => (reset(), setIdleOnly((v) => !v))} className={`${secondaryButtonClass} ${idleOnly ? "border-danger text-danger" : ""}`}>
          Idle only
        </button>
      </div>
      <p className="text-xs text-muted">Screenshots taken while the employee was idle (no keyboard or mouse input for the idle threshold) have a red border and an &quot;Idle&quot; label.</p>

      {canDelete && (
        <div role="group" aria-label="Export screenshots" className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className={secondaryButtonClass} disabled={!stored.length || full} onClick={() => stored.forEach((i) => toggle(i.id, true))}>Select all on this page</button>
          <button type="button" className={secondaryButtonClass} disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
          <Button onClick={exportSelected} disabled={!selected.size || exporting}>{exporting ? "Exporting…" : `Export ${selected.size} as ZIP`}</Button>
          <span className="text-xs text-muted" aria-live="polite">
            {selected.size} selected{full ? ` (limit ${SCREENSHOT_EXPORT_LIMITS.maxItems})` : ""}. Super Admin only; every exported screenshot is logged.
          </span>
          {exportError && <p role="alert" className="w-full text-xs font-medium text-danger">Export failed: {exportError}</p>}
        </div>
      )}

      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!gallery && !error && <SkeletonRows label="screenshots" />}

      {policy && (
        <p className="text-sm" data-testid="screenshot-policy">
          Screenshot capture: <StatusBadge tone={policy.enabled ? "success" : "neutral"}>{policy.enabled ? "Enabled" : "Disabled"}</StatusBadge>{" "}
          <span className="text-muted">
            {policy.enabled
              ? `One capture every ${policy.intervalSeconds} seconds while clocked in, after the employee acknowledged the notice. Per-employee state (awaiting consent, permission denied, capture failed) is on the live Attendance page.`
              : "Nothing is captured and uploads are refused. Earlier screenshots stay viewable below."}
          </span>
        </p>
      )}

      {overview && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Screenshots">
            <p className="text-2xl font-semibold tabular-nums">{overview.total}</p>
            <p className="mt-1 text-xs text-muted">{overview.stored} stored · {overview.deleted} deleted (by an administrator or by retention)</p>
          </Card>
          <Card title="Awaiting upload">
            <p className="text-2xl font-semibold tabular-nums">{overview.awaitingUpload}</p>
            <p className="mt-1 text-xs text-muted">
              {overview.stalled} for over an hour (device offline or retrying). Failures that never reached the server are shown in the employee&apos;s desktop app, not here.
            </p>
          </Card>
          <Card title="Latest">
            <p className="text-sm">Captured: <span className="tabular-nums">{when(overview.latestCapturedAt)}</span></p>
            <p className="mt-1 text-sm">Stored: <span className="tabular-nums">{when(overview.latestStoredAt)}</span></p>
          </Card>
          {r && <Card title="Retention">
            <p className="text-sm">{r.retentionDays} days · {r.approved ? <Badge ok>Approved</Badge> : <Badge ok={false}>Not approved: nothing deleted</Badge>}</p>
            <p className="mt-1 text-xs text-muted">{r.eligible} past the period now · last run {r.runs[0] ? `${when(r.runs[0].ranAt)} (${r.runs[0].deleted} deleted, ${r.runs[0].failed} failed)` : "never"}</p>
            <p className="mt-1 text-xs text-muted">{r.deletionMode === "RECYCLE_BIN" ? "Deletes go to the SharePoint recycle bin (recoverable for a while)." : r.deletionMode === "PERMANENT" ? "Permanent delete." : "Development storage."}</p>
          </Card>}
        </div>
      )}

      {employeeId ? (
        <TimelapsePanel key={`${employeeId}|${range.from}|${range.to}`} employeeId={employeeId} range={range} tz={TZ} />
      ) : (
        <p className="text-sm text-muted">Choose an employee to create a timelapse video of one of their work sessions.</p>
      )}

      {gallery && (
        <section aria-label="Screenshot gallery" className="flex flex-col gap-3">
          {gallery.items.length === 0 ? (
            <EmptyState title={idleOnly ? "No idle screenshots in this range." : "No screenshots in this range."} />
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {gallery.items.map((item) => (
                <Thumbnail
                  key={item.id}
                  item={item}
                  onOpen={() => setOpen(item)}
                  select={canDelete ? { checked: selected.has(item.id), disabled: full, onChange: (on) => toggle(item.id, on) } : undefined}
                />
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={secondaryButtonClass}>Previous</button>
            <span className="tabular-nums text-muted">Page {page} of {pages} · {gallery.total} screenshot(s)</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={secondaryButtonClass}>Next</button>
          </div>
        </section>
      )}

      {open && (
        <Viewer
          item={open}
          canDelete={canDelete}
          onClose={() => setOpen(null)}
          onDeleted={(r) => {
            setOk(r.alreadyDeleted ? "This screenshot had already been deleted." : `Screenshot deleted ${when(r.deletedAt)}. Timelapse videos that contained it were removed.`);
            setRetry((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
