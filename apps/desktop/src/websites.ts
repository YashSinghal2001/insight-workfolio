// "Websites" tab (F04): the employee's own website-tracking status, the website notice, connected
// browsers and their own recorded domains. The server decides everything; collection itself happens
// only in a browser extension the employee connects here (this app reads no browser data).
import { addDays, formatDuration, localDate, WEBSITE_DATA, type WebsiteCategory, type WebsitePairingCode, type WebsiteStatus, type WebsiteUsageResponse, type WebsiteUsageRow } from "@workfolio/shared";
import { HttpError, type ApiClient } from "./session.ts";

export interface WebsitesContext {
  client: ApiClient;
  timeZone: () => string | null;
  online: () => boolean;
}

const CATEGORY: Record<WebsiteCategory, string> = { PRODUCTIVE: "productive", NEUTRAL: "neutral", UNPRODUCTIVE: "unproductive", UNCLASSIFIED: "unclassified" };

/** One line per domain: "docs.example.com — 12m (3 visits) · category: productive". */
export const usageLine = (r: WebsiteUsageRow) =>
  `${r.domain} — ${formatDuration(r.durationMs)} (${r.intervals} visit${r.intervals === 1 ? "" : "s"}) · category: ${CATEGORY[r.category]}`;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

export function initWebsites(ctx: WebsitesContext) {
  let generation = 0;
  let status: WebsiteStatus | null = null;
  const tz = () => ctx.timeZone() ?? "UTC";
  const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz() }).format(new Date(iso));
  const message = (err: unknown) =>
    !ctx.online() || !(err instanceof HttpError)
      ? "Connect to the server to see website tracking."
      : err.status === 403
        ? "Website tracking applies to employee accounts; this account has no employee profile."
        : err.message;
  const show = (sel: string, text: string) => {
    $(sel).hidden = !text;
    $(sel).textContent = text;
  };
  const range = $<HTMLFormElement>("#web-range");
  const field = (name: string) => range.elements.namedItem(name) as HTMLInputElement;

  $("#web-collected").replaceChildren(...WEBSITE_DATA.collected.map((t) => el("li", t)));
  $("#web-never").replaceChildren(...WEBSITE_DATA.never.map((t) => el("li", t)));

  function renderStatus(s: WebsiteStatus) {
    $("#web-state").textContent = s.collecting ? "Recording website domain names" : "Not recording";
    $("#web-state").className = s.collecting ? "state on" : "state";
    $("#web-reasons").replaceChildren(...s.reasons.map((r) => el("li", r)));
    $("#web-policy").textContent = `Organization setting: ${s.policy.enabled ? "on" : "off"} · notice ${s.policy.noticeVersion}${s.notice?.draft ? " (draft)" : ""} · ${s.acknowledgedAt ? `acknowledged ${when(s.acknowledgedAt)}` : "not acknowledged"} · records kept ${s.policy.retentionDays} days`;
    const needsAck = s.policy.enabled && !s.acknowledgedAt && !!s.notice;
    $("#web-notice").hidden = !needsAck;
    if (s.notice) {
      $("#web-notice-title").textContent = s.notice.title + (s.notice.draft ? " (draft)" : "");
      $("#web-notice-points").replaceChildren(...s.notice.points.map((p) => el("li", p)));
    }
    $("#web-links").replaceChildren(
      ...(s.links.length
        ? s.links.map((l) => {
            const li = el("li");
            li.append(el("strong", l.label), el("div", `Connected ${when(l.createdAt)} · last contact ${l.lastUsedAt ? when(l.lastUsedAt) : "never"}`, "muted"));
            const b = el("button", "Disconnect", "mini secondary");
            b.type = "button";
            b.addEventListener("click", () => void act(() => ctx.client.request("DELETE", `/websites/links/${l.id}`)));
            li.append(b);
            return li;
          })
        : [el("li", "No browser connected. Nothing is recorded without one.", "muted")]),
    );
  }

  function renderUsage(u: WebsiteUsageResponse) {
    $("#web-total").textContent = u.byDomain.length ? `Recorded: ${formatDuration(u.totalMs)} on ${u.byDomain.length} domain(s). Categories are set by your organization and inferred from the domain; they are not part of what was recorded and are not a score.` : "";
    $("#web-usage").replaceChildren(...(u.byDomain.length ? u.byDomain.map((r) => el("li", usageLine(r))) : [el("li", "No website activity recorded in this period.", "muted")]));
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    show("#web-error", "");
    $("#web-status").textContent = "Loading…";
    try {
      const [s, u] = await Promise.all([
        ctx.client.request<WebsiteStatus>("GET", "/websites/me"),
        ctx.client.request<WebsiteUsageResponse>("GET", `/websites/me/usage?from=${field("from").value}&to=${field("to").value}`),
      ]);
      if (mine !== generation) return;
      status = s;
      $("#web-status").textContent = "";
      $("#web-body").hidden = false;
      renderStatus(s);
      renderUsage(u);
    } catch (err) {
      if (mine !== generation) return;
      $("#web-status").textContent = "";
      show("#web-error", message(err));
    }
  }

  async function act(fn: () => Promise<unknown>) {
    show("#web-error", "");
    try {
      await fn();
    } catch (err) {
      show("#web-error", message(err));
    }
    await load();
  }

  $("#web-ack").addEventListener("click", () => status?.notice && void act(() => ctx.client.request("POST", "/websites/consent", { noticeVersion: status!.notice!.version })));
  $("#web-connect").addEventListener("click", async () => {
    show("#web-error", "");
    try {
      const { code, expiresAt } = await ctx.client.request<WebsitePairingCode>("POST", "/websites/links");
      $("#web-code").textContent = code;
      $("#web-code-help").textContent = `Open the Insight Workfolio browser extension and enter this code before ${when(expiresAt)}. It works once.`;
      $("#web-pairing").hidden = false;
    } catch (err) {
      show("#web-error", message(err));
    }
  });
  range.addEventListener("submit", (e) => {
    e.preventDefault();
    if (field("from").value && field("to").value && field("from").value <= field("to").value) void load();
    else show("#web-error", "Choose a start date on or before the end date.");
  });

  return {
    show: () => {
      if (!field("to").value) {
        const today = localDate(Date.now(), tz());
        field("to").value = today;
        field("from").value = addDays(today, -6);
      }
      return load();
    },
    hide: () => void generation++,
  };
}
