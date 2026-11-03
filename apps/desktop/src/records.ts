// History (timesheet + shifts) and correction requests tabs. Online only; read-only except requests.
import {
  addDays,
  dateRangeSchema,
  formatDuration,
  localDate,
  timesheetFilename,
  toZonedLocal,
  weekStart,
  zonedToUtc,
  type ActivitySummaryResponse,
  type ActivityWarning,
  type AttendanceSession,
  type CorrectionRequest,
  type CorrectionType,
  type ExportFormat,
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
  employeeCode: () => string | null;
  /** Other tabs: loaded when shown, told when hidden (e.g. to free images). */
  tabs?: Record<string, { show(): Promise<void>; hide(): void }>;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

/** Employee wording for the summary's warnings (the API words them for admins). Per-day gaps show in the table. */
const NOTE: Partial<Record<ActivityWarning["code"], string>> = {
  MONITORING_DISABLED: "Activity monitoring is turned off by your organization, so nothing is recorded.",
  NO_CONSENT: "Nothing is recorded until you acknowledge the current monitoring notice on the Today tab.",
  NO_ACTIVE_DEVICE: "No device is registered, so activity cannot be recorded.",
  UNSUPPORTED_PLATFORM: "On Windows, activity is recorded only by the latest Insight Workfolio desktop app; if nothing appears, update the app.",
  STALE_SYNC: "You are clocked in but no recent activity has reached the server yet. Activity still on this computer is not included.",
};
export const activityNotes = (warnings: readonly Pick<ActivityWarning, "code">[]) => [...new Set(warnings.map((w) => NOTE[w.code]).filter((n): n is string => !!n))];

/** Same rule the server applies (dates, order, at most 92 days); null when the range is fine. */
export const exportRangeError = (from: string, to: string) =>
  !from || !to ? "Choose a start and an end date." : (dateRangeSchema.safeParse({ from, to }).error?.issues[0]?.message ?? null);

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
  let activitySeq = 0; // only the latest week's activity response is shown
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
      if (b.dataset.tab !== name) ctx.tabs?.[b.dataset.tab!]?.hide();
    }
    if (ctx.tabs?.[name]) return ctx.tabs[name].show();
    return name === "history" ? loadHistory() : name === "corrections" ? loadCorrections() : Promise.resolve();
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.addEventListener("click", () => void showTab(b.dataset.tab!));
  // Tab-list keyboard pattern: arrows / Home / End move between tabs and open them.
  $("[role=tablist]").addEventListener("keydown", (e) => {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    void showTab(tab.dataset.tab!);
  });

  // ---- History -------------------------------------------------------------------
  async function loadHistory(): Promise<void> {
    $("#history-error").hidden = true;
    const start = addDays(weekStart(localDate(Date.now(), tz()), weekStartsOn), 7 * weekOffset);
    const end = addDays(start, 6);
    $("#week-label").textContent = `${day(start)} – ${day(end)}`;
    if (!exportForm.dataset.touched) {
      exportField("from").value = start;
      exportField("to").value = end;
    }
    $<HTMLButtonElement>("#week-next").disabled = weekOffset >= 0;
    const pending = ctx.pendingCount();
    $("#history-note").hidden = !pending;
    $("#history-note").textContent = `${pending} change(s) waiting to sync are not included yet.`;
    void loadActivity(start, end);
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

  async function loadActivity(from: string, to: string): Promise<void> {
    const mine = ++activitySeq;
    $("#activity-error").hidden = true;
    $("#activity-status").textContent = "Loading…";
    for (const id of ["#activity-totals", "#activity-days", "#activity-apps", "#activity-notes"]) $(id).replaceChildren();
    $("#activity-notes").hidden = true;
    let a: ActivitySummaryResponse;
    try {
      a = await ctx.client.request<ActivitySummaryResponse>("GET", `/activity/summary?from=${from}&to=${to}`);
    } catch (err) {
      if (mine !== activitySeq) return;
      $("#activity-status").textContent = "";
      return error("#activity-error", err);
    }
    if (mine !== activitySeq) return;
    const recorded = a.activeMs + a.idleMs > 0;
    $("#activity-status").textContent = recorded ? "" : "No activity recorded this week.";
    const notes = activityNotes(a.warnings);
    $("#activity-notes").hidden = !notes.length;
    $("#activity-notes").replaceChildren(...notes.map((n) => el("li", n)));
    $("#activity-totals").replaceChildren(
      ...[
        ["Clocked in", formatDuration(a.clockedInMs)],
        ["Active (an application in front)", formatDuration(a.activeMs)],
        ["Idle", formatDuration(a.idleMs)],
        ["No record", formatDuration(a.unobservedMs)],
      ].flatMap(([k, v]) => [el("dt", k), el("dd", v)]),
    );
    $("#activity-days").replaceChildren(
      ...a.days.map((d) => {
        const tr = el("tr");
        tr.append(el("td", day(d.date)), ...[d.clockedInMs, d.activeMs, d.idleMs, d.unobservedMs].map((ms) => el("td", formatDuration(ms))));
        return tr;
      }),
    );
    $("#activity-apps").replaceChildren(
      ...(a.applications.length
        ? a.applications.map((app) => {
            const li = el("li");
            li.append(el("strong", app.applicationName), el("div", formatDuration(app.activeMs), "muted"));
            return li;
          })
        : [el("li", "No applications recorded this week.", "muted")]),
    );
  }
  $("#activity-screenshots").addEventListener("click", () => void showTab("screenshots"));

  // ---- Export (draft CSV, built by the server for the signed-in employee) --------------
  const exportForm = $<HTMLFormElement>("#export-form");
  const exportField = (name: string) => exportForm.elements.namedItem(name) as HTMLInputElement;
  let exporting: AbortController | null = null;
  const exportFormat = () => exportField("format").value as ExportFormat;
  exportForm.addEventListener("input", () => {
    exportForm.dataset.touched = "1";
    $("#export-status").textContent = ""; // the last result described other dates
    $("#export-error").hidden = true;
    $("#export-submit").textContent = exportFormat() === "xlsx" ? "Download Excel file" : "Download CSV";
  });
  $("#export-cancel").addEventListener("click", () => exporting?.abort());
  exportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const [from, to, format] = [exportField("from").value, exportField("to").value, exportFormat()];
    const invalid = exportRangeError(from, to);
    $("#export-error").hidden = !invalid;
    $("#export-error").textContent = invalid ?? "";
    $("#export-status").textContent = "";
    if (invalid || exporting) return;
    const controller = (exporting = new AbortController());
    $<HTMLButtonElement>("#export-submit").disabled = true;
    $("#export-cancel").hidden = false;
    $("#export-status").textContent = "Preparing…";
    try {
      const { blob, rows } = await ctx.client.download(`/attendance/export?from=${from}&to=${to}&format=${format}`, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const name = timesheetFilename(ctx.employeeCode() ?? "", from, to, format);
      // In memory only: a blob: link the app saves to Downloads (the Tauri download handler accepts
      // only export file names, straight into Downloads, and adds " (1)" instead of overwriting).
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      const where = "to your Downloads folder (a number is added to the name if a file with that name is already there)";
      $("#export-status").textContent = rows
        ? `Downloaded ${name} (${rows} shift(s)) ${where}.`
        : `No shifts between ${day(from)} and ${day(to)}. Downloaded ${name} with the column headers only, ${where}.`;
    } catch (err) {
      $("#export-status").textContent = "";
      if (controller.signal.aborted) $("#export-status").textContent = "Cancelled. Nothing was downloaded.";
      else error("#export-error", err);
    } finally {
      exporting = null;
      $<HTMLButtonElement>("#export-submit").disabled = false;
      $("#export-cancel").hidden = true;
    }
  });

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
