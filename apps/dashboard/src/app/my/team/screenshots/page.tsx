"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SCREENSHOT_MIME, type Paginated, type ScreenshotGalleryItem } from "@workfolio/shared";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { TimelapsePanel } from "@/components/timelapse-panel";
import { secondaryButtonClass } from "@/components/ui";
import { api, apiBlob, errorMessage } from "@/lib/api";
import { zonedTime } from "@/lib/zoned-time";
import { EmployeePicker } from "../../../(admin)/_components/employee-picker";

const PAGE_SIZE = 24;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One image through the authenticated API into a short-lived object URL (the API logs every load). */
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
  const stored = item.uploadStatus === "STORED";
  const { url, error } = useImage(stored ? item.id : null, "thumbnail");
  const at = zonedTime(item.capturedAt, item.employee.timezone) || item.capturedAt;
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-surface">
      <button type="button" onClick={onOpen} disabled={!stored} className="block aspect-video w-full bg-background text-xs text-muted disabled:cursor-default" aria-label={`Open screenshot of ${item.employee.fullName} at ${at}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs only, never proxied or cached */}
        {!stored ? (item.uploadStatus === "DELETED" ? "Deleted" : "Awaiting upload") : url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : error ?? "Loading…"}
      </button>
      <div className="flex flex-col px-3 py-2 text-xs">
        <span className="font-medium">{item.employee.fullName} <span className="text-muted">({item.employee.employeeCode})</span></span>
        <span className="tabular-nums text-muted">{at}</span>
      </div>
    </li>
  );
}

function Viewer({ item, onClose }: { item: ScreenshotGalleryItem; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { url, error } = useImage(item.id, "full");
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={`Screenshot of ${item.employee.fullName}`} className="m-auto max-h-[95vh] w-[min(1200px,95vw)] rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/70">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm">
        <span><strong>{item.employee.fullName}</strong> · {zonedTime(item.capturedAt, item.employee.timezone) || item.capturedAt}</span>
        <button type="button" onClick={() => ref.current?.close()} className={secondaryButtonClass} autoFocus>Close</button>
      </div>
      <div className="max-h-[75vh] overflow-auto bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs only */}
        {url ? <img src={url} alt={`Screenshot of ${item.employee.fullName}`} className="mx-auto" /> : <p className="p-6 text-sm text-white">{error ?? "Loading…"}</p>}
      </div>
      <p className="px-4 py-2 text-xs text-muted">Confidential: may contain personal information. This view is logged.</p>
    </dialog>
  );
}

export default function TeamScreenshotsPage() {
  return (
    <Suspense fallback={<SkeletonRows label="screenshots" />}>
      <TeamScreenshots />
    </Suspense>
  );
}

function TeamScreenshots() {
  const preset = useSearchParams().get("employeeId");
  const [employeeId, setEmployeeId] = useState(() => (preset && /^[0-9a-f-]{36}$/i.test(preset) ? preset : ""));
  const [range, setRange] = useState<Range>(() => weekRange());
  const [page, setPage] = useState(1);
  const [gallery, setGallery] = useState<Paginated<ScreenshotGalleryItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<ScreenshotGalleryItem | null>(null);

  useEffect(() => {
    let active = true;
    const q = `from=${range.from}&to=${range.to}&tz=${encodeURIComponent(TZ)}&page=${page}&pageSize=${PAGE_SIZE}${employeeId ? `&employeeId=${employeeId}` : ""}`;
    api<Paginated<ScreenshotGalleryItem>>(`/screenshots/gallery?${q}`).then(
      (g) => active && (setGallery(g), setError(null)),
      (e) => active && setError(errorMessage(e)),
    );
    return () => {
      active = false;
    };
  }, [employeeId, range, page, retry]);

  const pages = gallery ? Math.max(1, Math.ceil(gallery.total / gallery.pageSize)) : 1;
  return (
    <>
      <PageHeader
        title="Team screenshots"
        about={`Screenshots of your team members' main screens, taken only while clocked in. They may contain personal information; every thumbnail and view is logged with your account. The range is in your time zone (${TZ}).`}
      />
      <div className="flex flex-wrap items-end gap-3">
        <EmployeePicker value={employeeId} onChange={(id) => (setGallery(null), setPage(1), setEmployeeId(id))} label="Member" allLabel="All members" />
        <RangePicker value={range} maxDays={31} timeZone={TZ} onChange={(x) => (setGallery(null), setPage(1), setRange(x))} />
      </div>
      {employeeId ? (
        <TimelapsePanel key={`${employeeId}|${range.from}|${range.to}`} employeeId={employeeId} range={range} tz={TZ} />
      ) : (
        <p className="text-sm text-muted">Choose a member to create a timelapse video of one of their work sessions.</p>
      )}
      {error && <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {!gallery && !error && <SkeletonRows label="screenshots" />}
      {gallery && (
        <section aria-label="Screenshot gallery" className="flex flex-col gap-3">
          {gallery.items.length === 0 ? (
            <EmptyState title="No screenshots in this range." />
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
    </>
  );
}
