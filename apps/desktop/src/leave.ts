// "Leave" tab: the signed-in employee's own leave requests (F10). The server decides whose requests
// these are and validates everything again; this module only checks the form early and shows results.
// Policy-neutral: no leave types, balances or payroll, and attendance is not changed.
import { createLeaveSchema, leaveWhen, type LeaveRequest, type Paginated } from "@workfolio/shared";
import { HttpError, type ApiClient } from "./session.ts";

export interface LeaveContext {
  client: ApiClient;
  timeZone: () => string | null;
  online: () => boolean;
}

/** Same rules the server applies to the form (dates, halves, times, reason length); null when fine. */
export const leaveFormError = (v: Record<string, string>) =>
  !v.startDate || (v.portion === "FULL_DAY" && !v.endDate)
    ? "Choose the date(s)."
    : (createLeaveSchema.safeParse(v).error?.issues[0]?.message ?? null);

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};
const DONE = { APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled by you" } as const;

export function initLeave(ctx: LeaveContext) {
  let generation = 0;
  const form = $<HTMLFormElement>("#leave-form");
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone() ?? "UTC" }).format(new Date(iso));
  const message = (err: unknown) => (!ctx.online() || !(err instanceof HttpError) ? "Connect to the server to see or send leave requests." : err.message);
  const show = (sel: string, text: string) => {
    $(sel).hidden = !text;
    $(sel).textContent = text;
  };

  function syncFields() {
    const portion = field("portion").value;
    for (const label of form.querySelectorAll<HTMLElement>("[data-leave]")) {
      const on = label.dataset.leave === (portion === "FULL_DAY" ? "range" : portion === "SHORT" ? "times" : "");
      label.hidden = !on;
      for (const input of label.querySelectorAll("input")) input.disabled = !on;
    }
    $("#leave-start-label").textContent = portion === "FULL_DAY" ? "From" : "Date";
    $("#leave-tz").textContent = `Dates and times are in your time zone (${ctx.timeZone() ?? "UTC"}).`;
  }
  field("portion").addEventListener("change", syncFields);
  form.addEventListener("input", () => show("#leave-ok", ""));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    show("#leave-ok", "");
    const values: Record<string, string> = { portion: field("portion").value, startDate: field("startDate").value };
    values.endDate = values.portion === "FULL_DAY" ? field("endDate").value : values.startDate;
    if (values.portion === "SHORT") Object.assign(values, { startTime: field("startTime").value, endTime: field("endTime").value });
    if (field("reason").value.trim()) values.reason = field("reason").value;
    const invalid = leaveFormError(values);
    show("#leave-error", invalid ?? "");
    if (invalid) return;
    $<HTMLButtonElement>("#leave-submit").disabled = true;
    try {
      const r = await ctx.client.request<LeaveRequest>("POST", "/leave", values);
      form.reset();
      syncFields();
      show("#leave-ok", `Sent: ${leaveWhen(r)}. An administrator will approve or reject it; the decision appears below.`);
      await load();
    } catch (err) {
      show("#leave-error", message(err));
    } finally {
      $<HTMLButtonElement>("#leave-submit").disabled = false;
    }
  });

  async function load(): Promise<void> {
    const mine = ++generation;
    show("#leave-list-error", "");
    $("#leave-status").textContent = "Loading…";
    try {
      const page = await ctx.client.request<Paginated<LeaveRequest>>("GET", "/leave?pageSize=50");
      if (mine !== generation) return;
      $("#leave-status").textContent = page.items.length ? (page.total > page.items.length ? `Showing the latest ${page.items.length} of ${page.total}.` : "") : "No leave requests yet.";
      render(page.items);
    } catch (err) {
      if (mine !== generation) return;
      $("#leave-status").textContent = "";
      show("#leave-list-error", message(err));
    }
  }

  function render(items: LeaveRequest[]) {
    $("#leave-list").replaceChildren(
      ...items.map((r) => {
        const li = el("li");
        const head = el("div");
        head.append(el("strong", leaveWhen(r)), " ", el("span", r.status.toLowerCase(), `tag status-${r.status.toLowerCase()}`));
        li.append(head);
        if (r.reason) li.append(el("div", `“${r.reason}”`, "muted"));
        li.append(el("div", `Sent ${when(r.requestedAt)}`, "muted"));
        if (r.status !== "PENDING" && r.decidedAt) li.append(el("div", `${DONE[r.status]} ${when(r.decidedAt)}${r.decisionNote ? `: ${r.decisionNote}` : ""}`));
        if (r.status === "PENDING") {
          const btn = el("button", "Cancel request", "mini secondary");
          btn.type = "button";
          const err = el("p", "", "error");
          err.setAttribute("role", "alert");
          err.hidden = true;
          btn.addEventListener("click", async () => {
            if (!btn.dataset.confirm) {
              btn.dataset.confirm = "1"; // two steps instead of a blocking dialog
              btn.textContent = "Yes, cancel this request";
              return;
            }
            btn.disabled = true;
            try {
              await ctx.client.request<LeaveRequest>("POST", `/leave/${r.id}/cancel`);
              await load();
            } catch (e) {
              err.hidden = false;
              err.textContent = message(e);
              btn.disabled = false;
            }
          });
          li.append(btn, err);
        }
        return li;
      }),
    );
  }

  syncFields();
  return {
    show: () => (syncFields(), load()),
    hide: () => void generation++,
  };
}
