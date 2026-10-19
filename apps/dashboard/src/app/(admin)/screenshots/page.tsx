"use client";

import { useEffect, useRef, useState } from "react";
import {
  SCREENSHOT_MIME,
  type Employee,
  type Paginated,
  type ScreenshotDetail,
  type ScreenshotGalleryItem,
  type ScreenshotOverview,
} from "@workfolio/shared";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Badge, Card, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, apiBlob, errorMessage } from "@/lib/api";

const PAGE_SIZE = 24;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso)) : "—");
const STATUS = {
  STORED: ["Stored", true],
  REGISTERED: ["Awaiting upload", false],
  DELETED: ["Deleted (retention)", false],
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

function Thumbnail({ item, onOpen }: { item: ScreenshotGalleryItem; onOpen: () => void }) {
  const { url, error } = useImage(item.uploadStatus === "STORED" ? item.id : null, "thumbnail");
  const [label, ok] = STATUS[item.uploadStatus];
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-surface">
      <button type="button" onClick={onOpen} disabled={item.uploadStatus !== "STORED"} className="block aspect-video w-full bg-background text-xs text-muted disabled:cursor-default" aria-label={`Open screenshot of ${item.employee.fullName} at ${when(item.capturedAt)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {item.uploadStatus !== "STORED" ? label : url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : error ? <span className="text-red-700 dark:text-red-300">{error}</span> : "Loading…"}
      </button>
      <div className="flex flex-col gap-1 px-3 py-2 text-xs">
        <span className="font-medium">{item.employee.fullName} <span className="text-muted">({item.employee.employeeCode})</span></span>
        <span className="tabular-nums text-muted">{when(item.capturedAt)}</span>
        <span><Badge ok={ok}>{label}</Badge> <span className="text-muted">{item.width}×{item.height} · {Math.round(item.fileSizeBytes / 1024)} KB</span></span>
      </div>
    </li>
  );
}

function Viewer({ item, onClose }: { item: ScreenshotGalleryItem; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { url, error } = useImage(item.id, "full");
  const [detail, setDetail] = useState<ScreenshotDetail | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    // After the image request, so the access log includes this view.
    if (url || error) api<ScreenshotDetail>(`/screenshots/${item.id}`).then(setDetail, () => setDetail(null));
  }, [item.id, url, error]);
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto max-h-[95vh] w-[min(1200px,95vw)] rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/70">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm">
        <span><strong>{item.employee.fullName}</strong> · {when(item.capturedAt)} · {item.width}×{item.height}</span>
        <button type="button" onClick={() => ref.current?.close()} className={secondaryButtonClass} autoFocus>Close</button>
      </div>
      <div className="max-h-[70vh] overflow-auto bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {url ? <img src={url} alt={`Screenshot of ${item.employee.fullName}'s main screen at ${when(item.capturedAt)}`} className="mx-auto" /> : <p className="p-6 text-sm text-white">{error ?? "Loading…"}</p>}
      </div>
      <div className="px-4 py-3 text-xs text-muted">
        Confidential: may contain personal information. This view is logged.
        {detail?.accessLog && (
          <details className="mt-2">
            <summary className="cursor-pointer">Access log ({detail.accessLog.length})</summary>
            <ul className="mt-1 max-h-32 overflow-auto">
              {detail.accessLog.map((a, i) => <li key={i} className="tabular-nums">{when(a.accessedAt)} · {a.viewer.email} · {a.action === "VIEW" ? "viewed" : "thumbnail"}</li>)}
            </ul>
          </details>
        )}
      </div>
    </dialog>
  );
}

export default function ScreenshotsPage() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = useState(1);
  const [gallery, setGallery] = useState<Paginated<ScreenshotGalleryItem> | null>(null);
  const [overview, setOverview] = useState<ScreenshotOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ScreenshotGalleryItem | null>(null);

  useEffect(() => {
    api<Paginated<Employee>>("/employees?pageSize=100").then((r) => setEmployees(r.items), (e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    let active = true;
    const q = `from=${range.from}&to=${range.to}&tz=${encodeURIComponent(TZ)}${employeeId ? `&employeeId=${employeeId}` : ""}`;
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
  }, [employeeId, range, page]);

  const reset = () => (setGallery(null), setOverview(null), setPage(1));
  const pages = gallery ? Math.max(1, Math.ceil(gallery.total / gallery.pageSize)) : 1;
  const r = overview?.retention;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Screenshots</h1>
        <p className="mt-1 text-sm text-muted">
          Screenshots of employees&apos; main screens, taken only while clocked in, not on a break, after they acknowledged the screenshot
          notice. They may contain personal or sensitive information; nothing is masked. Images are loaded through the API on demand,
          never cached, and every thumbnail and view is logged with your account. Times are in your time zone ({TZ}).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted">Employee</span>
          <select value={employeeId} onChange={(e) => (reset(), setEmployeeId(e.target.value))} className={inputClass} disabled={!employees}>
            <option value="">All employees</option>
            {employees?.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
          </select>
        </label>
        <RangePicker value={range} onChange={(x) => (reset(), setRange(x))} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!gallery && !error && <p role="status" className="text-sm text-muted">Loading…</p>}

      {overview && r && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Screenshots">
            <p className="text-2xl font-semibold tabular-nums">{overview.total}</p>
            <p className="mt-1 text-xs text-muted">{overview.stored} stored · {overview.deleted} deleted by retention</p>
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
          <Card title="Retention">
            <p className="text-sm">{r.retentionDays} days · {r.approved ? <Badge ok>Approved</Badge> : <Badge ok={false}>Not approved: nothing deleted</Badge>}</p>
            <p className="mt-1 text-xs text-muted">{r.eligible} past the period now · last run {r.runs[0] ? `${when(r.runs[0].ranAt)} (${r.runs[0].deleted} deleted, ${r.runs[0].failed} failed)` : "never"}</p>
            <p className="mt-1 text-xs text-muted">{r.deletionMode === "RECYCLE_BIN" ? "Deletes go to the SharePoint recycle bin (recoverable for a while)." : r.deletionMode === "PERMANENT" ? "Permanent delete." : "Development storage."}</p>
          </Card>
        </div>
      )}

      {gallery && (
        <section aria-label="Screenshot gallery" className="flex flex-col gap-3">
          {gallery.items.length === 0 ? (
            <p className="text-sm text-muted">No screenshots in this range.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {gallery.items.map((item) => <Thumbnail key={item.id} item={item} onOpen={() => setOpen(item)} />)}
            </ul>
          )}
          <div className="flex items-center gap-3 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={secondaryButtonClass}>Previous</button>
            <span className="tabular-nums text-muted">Page {page} of {pages} · {gallery.total} screenshot(s)</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={secondaryButtonClass}>Next</button>
          </div>
        </section>
      )}

      {open && <Viewer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
