// "My screenshots" tab: the signed-in employee's own stored screenshots, through the same API routes
// the admin gallery uses. The server decides everything (whose screenshots, whether self-view is
// allowed, logging); this module only shows the result. Images live in memory as blob: URLs and are
// released when the tab is left or the page changes; nothing is written to disk or the cache.
import type { Paginated, ScreenshotDetail, ScreenshotItem, ScreenshotMaskRegion } from "@workfolio/shared";
import { HttpError, type ApiClient } from "./session.ts";

export interface MyScreenshotsContext {
  client: ApiClient;
  timeZone: () => string | null;
  online: () => boolean;
}

const PAGE_SIZE = 12;

/** What the employee is told about the masks in one screenshot (labels when the server knows them). */
/** Masks plus whole-image blur, as recorded by the server for this capture. */
export function privacyLine(item: Pick<ScreenshotItem, "maskCount"> & { blurred?: boolean }): string {
  const masks = maskLine(item.maskCount);
  return item.blurred ? `Blurred on this computer before upload. ${masks}` : masks;
}

export function maskLine(count: number, masks: readonly Pick<ScreenshotMaskRegion, "label">[] | null = null): string {
  if (!count) return "No privacy masks were applied.";
  const what = count === 1 ? "1 area was" : `${count} areas were`;
  return `${what} blacked out before saving${masks?.length === count ? `: ${masks.map((m) => m.label).join(", ")}` : ""}.`;
}

/** The card text for a screenshot that cannot be opened, or null when it can. */
export function unavailable(item: Pick<ScreenshotItem, "uploadStatus">): string | null {
  return item.uploadStatus === "DELETED" ? "Deleted under the retention policy" : item.uploadStatus === "REGISTERED" ? "Waiting for upload" : null;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

export function initMyScreenshots(ctx: MyScreenshotsContext) {
  let page = 1;
  let generation = 0; // a newer load or leaving the tab makes older responses irrelevant
  let urls: string[] = [];
  let opener: HTMLElement | null = null;
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: ctx.timeZone() ?? "UTC" }).format(new Date(iso));
  const message = (err: unknown) =>
    !ctx.online() || !(err instanceof HttpError) ? "Connect to the server to see your screenshots." : err.status === 410 ? "This screenshot was deleted under the retention policy." : err.message;
  const image = async (id: string, variant: "thumbnail" | "full") => {
    const url = URL.createObjectURL(await ctx.client.blob(`/screenshots/${id}/content${variant === "thumbnail" ? "?variant=thumbnail" : ""}`));
    urls.push(url);
    return url;
  };
  function release() {
    generation++;
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
  }

  async function load(): Promise<void> {
    release();
    const mine = generation;
    const list = $("#myshots-list");
    list.replaceChildren();
    $("#myshots-error").hidden = true;
    $("#myshots-status").textContent = "Loading…";
    let data: Paginated<ScreenshotItem>;
    try {
      data = await ctx.client.request<Paginated<ScreenshotItem>>("GET", `/screenshots?page=${page}&pageSize=${PAGE_SIZE}`);
    } catch (err) {
      if (mine !== generation) return;
      $("#myshots-status").textContent = "";
      $("#myshots-error").hidden = false;
      $("#myshots-error").textContent = message(err);
      $("#myshots-page").textContent = "";
      $<HTMLButtonElement>("#myshots-prev").disabled = $<HTMLButtonElement>("#myshots-next").disabled = true;
      return;
    }
    if (mine !== generation) return;
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    $("#myshots-status").textContent = data.total ? `${data.total} screenshot(s) in the last 30 days` : "No screenshots in the last 30 days.";
    $("#myshots-page").textContent = `Page ${page} of ${pages}`;
    $<HTMLButtonElement>("#myshots-prev").disabled = page <= 1;
    $<HTMLButtonElement>("#myshots-next").disabled = page >= pages;
    for (const item of data.items) {
      const li = el("li");
      const off = unavailable(item);
      if (off) {
        li.append(el("div", off, "shot-thumb muted"));
      } else {
        const open = el("button", "Loading…", "shot-thumb");
        open.type = "button";
        open.setAttribute("aria-label", `Open the screenshot taken ${when(item.capturedAt)}`);
        open.addEventListener("click", () => void view(item, open));
        li.append(open);
        void image(item.id, "thumbnail").then(
          (url) => {
            if (mine !== generation) return;
            const img = el("img");
            img.src = url;
            img.alt = "";
            open.replaceChildren(img);
          },
          (err) => mine === generation && (open.textContent = message(err)),
        );
      }
      li.append(el("div", when(item.capturedAt)), el("div", privacyLine(item), "muted"));
      list.append(li);
    }
  }

  async function view(item: ScreenshotItem, from: HTMLElement) {
    opener = from;
    const dialog = $<HTMLDialogElement>("#myshots-viewer");
    $("#myshots-viewer-title").textContent = `Screenshot taken ${when(item.capturedAt)}`;
    $("#myshots-masks").textContent = privacyLine(item);
    $("#myshots-viewer-error").hidden = true;
    const img = $<HTMLImageElement>("#myshots-image");
    img.removeAttribute("src");
    img.alt = `Your main screen at ${when(item.capturedAt)}`;
    dialog.showModal();
    const mine = generation;
    try {
      const [detail, url] = await Promise.all([ctx.client.request<ScreenshotDetail>("GET", `/screenshots/${item.id}`), image(item.id, "full")]);
      if (mine !== generation || !dialog.open) return;
      img.src = url;
      $("#myshots-masks").textContent = maskLine(detail.maskCount, detail.masks);
    } catch (err) {
      if (mine !== generation) return;
      $("#myshots-viewer-error").hidden = false;
      $("#myshots-viewer-error").textContent = message(err);
    }
  }

  $("#myshots-prev").addEventListener("click", () => ((page = Math.max(1, page - 1)), void load()));
  $("#myshots-next").addEventListener("click", () => ((page += 1), void load()));
  $("#myshots-close").addEventListener("click", () => $<HTMLDialogElement>("#myshots-viewer").close());
  $("#myshots-viewer").addEventListener("close", () => {
    $<HTMLImageElement>("#myshots-image").removeAttribute("src");
    opener?.focus();
  });

  return {
    show: () => ((page = 1), load()),
    hide() {
      if ($<HTMLDialogElement>("#myshots-viewer").open) $<HTMLDialogElement>("#myshots-viewer").close();
      release();
      $("#myshots-list").replaceChildren();
    },
  };
}
