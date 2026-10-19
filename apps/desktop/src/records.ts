// History (timesheet + shifts) and correction requests tabs. Online only; read-only except requests.
import {
  addDays,
  formatDuration,
  localDate,
  toZonedLocal,
  weekStart,
  zonedToUtc,
  type AttendanceSession,
  type CorrectionRequest,
  type CorrectionType,
  type Paginated,
  type TimesheetResponse,
} from "@workfolio/shared";
import { HttpError, type ApiClient } from "./session.ts";

export interface RecordsContext {
  client: ApiClient;
  timeZone: () => string | null;
  online: () => boolean;
  /** Events still in the local queue (not part of server totals yet). */
  pendingCount: () => number;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

const TYPE_LABEL: Record<CorrectionType, string> = {
  MISSING_CLOCK_IN: "Missing shift",
  MISSING_CLOCK_OUT: "Missing clock-out",
  ATTENDANCE_TIME: "Wrong clock-in/out time",
  BREAK_TIME: "Wrong break time",
};
const FIELDS: Record<CorrectionType, string[]> = {
  MISSING_CLOCK_IN: ["clockInAt", "clockOutAt"],
  MISSING_CLOCK_OUT: ["sessionId", "clockOutAt", "breakEndedAt"],
  ATTENDANCE_TIME: ["sessionId", "clockInAt", "clockOutAt"],
  BREAK_TIME: ["sessionId", "breakId", "startedAt", "endedAt"],
};

export function initRecords(ctx: RecordsContext) {
  let weekOffset = 0;
  let weekStartsOn = 1;
  let recent: AttendanceSession[] = [];
  const tz = () => ctx.timeZone() ?? "UTC";
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: tz() }).format(new Date(iso));
  const dateTime = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz() }).format(new Date(iso));
  const day = (date: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const error = (sel: string, err: unknown) => {
    $(sel).hidden = false;
    $(sel).textContent = !ctx.online() || !(err instanceof HttpError) ? "Connect to the server to see this." : err.message;
  };

  // ---- Tabs ----------------------------------------------------------------------
  /** Resolves once the tab's data has loaded. */
  function showTab(name: string): Promise<void> {
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
      $(`#tab-${b.dataset.tab}`).hidden = b.dataset.tab !== name;
    }
    return name === "history" ? loadHistory() : name === "corrections" ? loadCorrections() : Promise.resolve();
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.addEventListener("click", () => void showTab(b.dataset.tab!));

  // ---- History -------------------------------------------------------------------
  async function loadHistory(): Promise<void> {
    $("#history-error").hidden = true;
    const start = addDays(weekStart(localDate(Date.now(), tz()), weekStartsOn), 7 * weekOffset);
    const end = addDays(start, 6);
    $("#week-label").textContent = `${day(start)} – ${day(end)}`;
    $<HTMLButtonElement>("#week-next").disabled = weekOffset >= 0;
    const pending = ctx.pendingCount();
    $("#history-note").hidden = !pending;
    $("#history-note").textContent = `${pending} change(s) waiting to sync are not included yet.`;
    try {
      const [sheet, shifts] = await Promise.all([
        ctx.client.request<TimesheetResponse>("GET", `/attendance/timesheet?from=${start}&to=${end}`),
        ctx.client.request<Paginated<AttendanceSession>>("GET", `/attendance/history?from=${start}&to=${end}&pageSize=100`),
      ]);
      if (sheet.policy.weekStartsOn !== weekStartsOn) {
        weekStartsOn = sheet.policy.weekStartsOn; // server policy wins; reload with the right week
        return loadHistory();
      }
      renderSheet(sheet);
      renderShifts(shifts.items);
    } catch (err) {
      error("#history-error", err);
    }
  }

  function renderSheet(sheet: TimesheetResponse) {
    const t = sheet.totals;
    $("#week-totals").replaceChildren(
      ...[
        ["Worked (completed shifts)", formatDuration(t.netMs)],
        ["Breaks", formatDuration(t.breakMs)],
        ["Overtime (reported only)", t.overtimeMs ? formatDuration(t.overtimeMs) : "—"],
        ...(t.incompleteDays ? [["Open shifts", `${t.incompleteDays} (not counted until clocked out)`]] : []),
        ...(sheet.pendingCorrections ? [["Pending corrections", String(sheet.pendingCorrections)]] : []),
      ].flatMap(([k, v]) => [el("dt", k), el("dd", v)]),
    );
    $("#days-body").replaceChildren(
      ...(sheet.days.length
        ? sheet.days.map((d) => {
            const tr = el("tr");
            const flags = [
              d.incomplete && "open",
              d.overtimeMs && `+${formatDuration(d.overtimeMs)} OT`,
              d.corrected && "corrected",
              d.offlineShifts && "offline",
            ].filter(Boolean) as string[];
            const first = el("td", day(d.date));
            for (const f of flags) first.append(" ", el("span", f, "tag"));
            tr.append(first, el("td", String(d.shifts)), el("td", formatDuration(d.netMs)), el("td", formatDuration(d.breakMs)));
            return tr;
          })
        : [Object.assign(el("tr"), { innerHTML: '<td colspan="4" class="muted">No shifts this week.</td>' })]),
    );
    $("#policy-note").textContent =
      `Times in ${sheet.timeZone}. Overtime is time beyond ${formatDuration(sheet.policy.scheduledDailyMinutes * 60_000)} a day and is reported only. ` +
      "Shifts count on the day they started.";
  }

  function renderShifts(items: AttendanceSession[]) {
    $("#shift-list").replaceChildren(
      ...(items.length
        ? items.map((s) => {
            const li = el("li");
            li.append(el("strong", `${dateTime(s.clockInAt)} → ${s.clockOutAt ? time(s.clockOutAt) : "still open"}`));
            for (const tag of [s.corrected && "corrected", s.clockInSource === "OFFLINE_SYNC" && "offline sync", s.clockInSource === "CORRECTION" && "added by correction"]) {
              if (tag) li.append(" ", el("span", tag, "tag"));
            }
            const breaks = s.breaks.map((b) => `${time(b.startedAt)}–${b.endedAt ? time(b.endedAt) : "…"}`);
            li.append(el("div", breaks.length ? `Breaks: ${breaks.join(", ")}` : "No breaks", "muted"));
            const fix = el("button", "Request correction", "mini secondary");
            fix.type = "button";
            fix.addEventListener("click", async () => {
              await showTab("corrections"); // the shift list must be loaded before it can be selected
              prefill(s.clockOutAt ? "ATTENDANCE_TIME" : "MISSING_CLOCK_OUT", s);
            });
            li.append(fix);
            return li;
          })
        : [el("li", "No shifts this week.", "muted")]),
    );
  }

  $("#week-prev").addEventListener("click", () => {
    weekOffset--;
    void loadHistory();
  });
  $("#week-next").addEventListener("click", () => {
    weekOffset = Math.min(0, weekOffset + 1);
    void loadHistory();
  });

  // ---- Corrections ---------------------------------------------------------------
  const form = $<HTMLFormElement>("#correction-form");
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const selectedSession = () => recent.find((s) => s.id === field("sessionId").value);

  function syncFields() {
    const type = field("type").value as CorrectionType;
    const s = selectedSession();
    for (const label of form.querySelectorAll<HTMLElement>("[data-field]")) {
      const name = label.dataset.field!;
      let show = FIELDS[type].includes(name);
      if (name === "breakEndedAt") show &&= !!s?.breaks.some((b) => !b.endedAt);
      if (name === "clockOutAt" && type === "ATTENDANCE_TIME") show &&= !!s?.clockOutAt;
      label.hidden = !show;
      const input = field(name);
      input.disabled = !show;
      input.required = show && type !== "ATTENDANCE_TIME";
    }
    // Only shifts the chosen correction can apply to.
    const eligible = recent.filter((x) => (type === "MISSING_CLOCK_OUT" ? !x.clockOutAt : type === "BREAK_TIME" ? x.breaks.some((b) => b.endedAt) : true));
    const current = field("sessionId").value;
    field("sessionId").replaceChildren(
      ...eligible.map((x) => Object.assign(el("option", `${dateTime(x.clockInAt)} → ${x.clockOutAt ? time(x.clockOutAt) : "open"}`), { value: x.id })),
    );
    if (eligible.some((x) => x.id === current)) field("sessionId").value = current;
    const brk = selectedSession()?.breaks.filter((b) => b.endedAt) ?? [];
    field("breakId").replaceChildren(...brk.map((b) => Object.assign(el("option", `${time(b.startedAt)}–${time(b.endedAt!)}`), { value: b.id })));
    $("#correction-tz").textContent = `Enter times in your time zone (${tz()}).`;
  }

  function prefill(type: CorrectionType, s: AttendanceSession) {
    field("type").value = type;
    syncFields();
    field("sessionId").value = s.id;
    syncFields();
    field("clockInAt").value = toZonedLocal(s.clockInAt, tz());
    field("clockOutAt").value = s.clockOutAt ? toZonedLocal(s.clockOutAt, tz()) : "";
  }

  field("type").addEventListener("change", syncFields);
  field("sessionId").addEventListener("change", syncFields);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#correction-error").hidden = true;
    $("#correction-ok").hidden = true;
    const type = field("type").value as CorrectionType;
    const body: Record<string, string> = { type, reason: field("reason").value };
    for (const name of FIELDS[type]) {
      const input = field(name);
      if (input.disabled || !input.value) continue;
      body[name] = input instanceof HTMLSelectElement ? input.value : zonedToUtc(input.value, tz());
    }
    $<HTMLButtonElement>("#correction-submit").disabled = true;
    try {
      await ctx.client.request<CorrectionRequest>("POST", "/attendance/corrections", body);
      form.reset();
      syncFields();
      $("#correction-ok").hidden = false;
      $("#correction-ok").textContent = "Sent. You'll see the decision below.";
      await loadCorrections();
    } catch (err) {
      error("#correction-error", err);
    } finally {
      $<HTMLButtonElement>("#correction-submit").disabled = false;
    }
  });

  async function loadCorrections(): Promise<void> {
    try {
      const today = localDate(Date.now(), tz());
      const [mine, shifts] = await Promise.all([
        ctx.client.request<Paginated<CorrectionRequest>>("GET", "/attendance/corrections?pageSize=20"),
        ctx.client.request<Paginated<AttendanceSession>>("GET", `/attendance/history?from=${addDays(today, -31)}&to=${today}&pageSize=100`),
      ]);
      recent = shifts.items;
      syncFields();
      renderRequests(mine.items);
    } catch (err) {
      error("#correction-error", err);
    }
  }

  function renderRequests(items: CorrectionRequest[]) {
    $("#correction-list").replaceChildren(
      ...(items.length
        ? items.map((r) => {
            const li = el("li");
            li.append(el("strong", TYPE_LABEL[r.type]), " ", el("span", r.status.toLowerCase(), `tag status-${r.status.toLowerCase()}`));
            const times = Object.entries(r.proposed).map(([k, v]) => `${k.replace(/At$/, "").replace(/([A-Z])/g, " $1").toLowerCase()}: ${dateTime(v)}`);
            li.append(el("div", times.join(" · "), "muted"), el("div", `“${r.reason}” — sent ${dateTime(r.requestedAt)}`, "muted"));
            if (r.reviewedAt) li.append(el("div", `${r.status === "APPROVED" ? "Approved" : "Rejected"} ${dateTime(r.reviewedAt)}: ${r.reviewReason}`));
            return li;
          })
        : [el("li", "No requests yet.", "muted")]),
    );
  }

  return {
    showTab,
    /** Re-render the open tab (e.g. after a sync changed the data). */
    refresh() {
      if (!$("#tab-history").hidden) void loadHistory();
      if (!$("#tab-corrections").hidden) void loadCorrections();
    },
  };
}
