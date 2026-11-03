"use client";

import { useEffect, useRef, useState } from "react";
import { addDays, SCREENSHOT_MIME, todayIn, type Paginated, type ScreenshotDetail, type ScreenshotItem, type ScreenshotStatusResponse } from "@workfolio/shared";
import { EmptyState, PageHeader, Pagination, StatusBadge } from "@/components/kit";
import { UpdatedAt, useApi, useMe } from "@/components/my-ui";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card, Notice, secondaryButtonClass } from "@/components/ui";
import { Loaded } from "../_components/states";
import { apiBlob, errorMessage } from "@/lib/api";

const PAGE_SIZE = 24;

const whenIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone }).format(new Date(iso));

/** Same wording as the desktop app. */
function maskLine(count: number, labels: string[] | null = null) {
  if (!count) return "No privacy masks were applied.";
  const what = count === 1 ? "1 area was" : `${count} areas were`;
  return `${what} blacked out before saving${labels?.length === count ? `: ${labels.join(", ")}` : ""}.`;
}

const unavailable = (item: ScreenshotItem) =>
  item.uploadStatus === "DELETED" ? "Deleted by an administrator or under the retention policy" : item.uploadStatus === "REGISTERED" ? "Waiting for upload" : null;

const DISABLED = "Your administrator has not enabled viewing your own screenshots for you. Screenshots may still be captured under the screenshot policy; ask your administrator if you have questions.";

/** One image through the authenticated API as a short-lived object URL, revoked on cleanup. The API logs each load. */
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

function Thumbnail({ item, tz, onOpen }: { item: ScreenshotItem; tz: string; onOpen: () => void }) {
  const gone = unavailable(item);
  const { url, error } = useImage(gone ? null : item.id, "thumbnail");
  const at = whenIn(item.capturedAt, tz);
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        disabled={!!gone}
        aria-label={gone ? `Screenshot at ${at}: ${gone}` : `Open screenshot taken at ${at}`}
        className="flex aspect-video w-full items-center justify-center bg-background p-2 text-center text-xs text-muted disabled:cursor-default"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {gone ?? (url ? <img src={url} alt="" className="h-full w-full object-cover object-top" /> : error ? <span className="text-red-700 dark:text-red-300">{error}</span> : "Loading…")}
      </button>
      <div className="flex flex-col gap-1 px-3 py-2 text-xs">
        <span className="tabular-nums font-medium">{at}</span>
        <span>
          <StatusBadge tone={gone ? (item.uploadStatus === "DELETED" ? "neutral" : "warning") : "success"}>{gone ? (item.uploadStatus === "DELETED" ? "Deleted" : "Not stored yet") : "Stored"}</StatusBadge>{" "}
          <span className="text-muted">{item.maskCount ? `${item.maskCount} masked area(s)` : "Unmasked"}</span>
        </span>
      </div>
    </li>
  );
}

function Viewer({ item, tz, onClose }: { item: ScreenshotItem; tz: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { url, error } = useImage(item.id, "full");
  const detail = useApi<ScreenshotDetail>(`/screenshots/${item.id}`).load;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (!ref.current?.open) ref.current?.showModal(); // native modal: traps focus, Escape fires "close"
    return () => opener?.focus();
  }, []);
  const at = whenIn(item.capturedAt, tz);
  const masks = detail.state === "ready" ? detail.data.masks?.map((m) => m.label) ?? null : null;
  return (
    <dialog ref={ref} aria-label="Screenshot viewer" onClose={onClose} className="m-auto max-h-[95vh] w-[min(1200px,95vw)] rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/70">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm">
        <span><strong>{at}</strong> <span className="text-muted">({tz}) · {item.width}×{item.height} · {Math.round(item.fileSizeBytes / 1024)} KB</span></span>
        <button type="button" onClick={() => ref.current?.close()} className={`${secondaryButtonClass} px-3 py-1`} autoFocus>Close</button>
      </div>
      <div className="max-h-[70vh] overflow-auto bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image would proxy and cache the screenshot; blob URLs only */}
        {url ? <img src={url} alt={`Your screenshot of your main screen at ${at}`} className="mx-auto" /> : <p role="status" className="p-6 text-sm text-white">{error ?? "Loading…"}</p>}
      </div>
      <div className="flex flex-col gap-1 px-4 py-3 text-xs text-muted">
        <span>{maskLine(item.maskCount, masks)}</span>
        {item.storedAt && <span>Stored {whenIn(item.storedAt, tz)}.</span>}
        <span>Opening a screenshot is logged (who viewed it and when), including when you view your own.</span>
      </div>
    </dialog>
  );
}

function Gallery({ tz }: { tz: string }) {
  const today = todayIn(tz);
  const [range, setRange] = useState<Range>({ from: addDays(today, -6), to: today });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ScreenshotItem | null>(null);
  const { load, reload } = useApi<Paginated<ScreenshotItem>>(`/screenshots?from=${range.from}&to=${range.to}&page=${page}&pageSize=${PAGE_SIZE}`);
  const change = (r: Range) => {
    setRange(r);
    setPage(1);
  };

  if (load.state === "error" && load.status === 403) return <Notice tone="warning">{DISABLED}</Notice>;
  return (
    <Card title="Screenshots" actions={load.state === "ready" ? <UpdatedAt at={load.at} /> : undefined}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <RangePicker value={range} onChange={change} timeZone={tz} />
          <span className="text-xs text-muted">Dates and times in {tz}.</span>
        </div>
        <Loaded load={load} reload={reload} label="your screenshots">
          {(data) => {
            const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
            return (
              <>
                {data.items.length === 0 ? (
                  <EmptyState title="No screenshots in this period." />
                ) : (
                  <ul aria-label="My screenshots list" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {data.items.map((item) => <Thumbnail key={item.id} item={item} tz={tz} onOpen={() => setOpen(item)} />)}
                  </ul>
                )}
                {data.total > data.pageSize && (
                  <div className="flex flex-col gap-1">
                    <Pagination label="Screenshot pages" page={data.page} pageCount={pages} onPage={setPage} />
                    <p className="text-xs text-muted">{data.total} screenshots in this period.</p>
                  </div>
                )}
              </>
            );
          }}
        </Loaded>
      </div>
      {open && <Viewer item={open} tz={tz} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/** The signed-in employee's own screenshots, only while the organization allows self-view (the API decides). */
export default function MyScreenshotsPage() {
  const me = useMe();
  const { load, reload } = useApi<ScreenshotStatusResponse>("/screenshots/me");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My screenshots" description="Only your own screenshots. Images are loaded through the API on demand and never cached or shared." />
      <Loaded load={load} reload={reload} label="your screenshot status">
        {(s) =>
          !s.employeeSelfView ? (
            <Notice tone="warning">{DISABLED}</Notice>
          ) : (
            <>
              <p className="text-xs text-muted">
                Screenshots are {s.policy.enabled ? `on: one every ${Math.round(s.policy.intervalSeconds / 60)} min while clocked in` : "off"} · kept {s.retentionDays} days ·
                notice {s.notice.version}{s.notice.draft ? " (draft)" : ""} · {s.consent.acknowledgedAt ? "acknowledged" : "not acknowledged"}. Thumbnails and full views are logged.
              </p>
              <Gallery tz={me.timezone} />
            </>
          )
        }
      </Loaded>
    </div>
  );
}
