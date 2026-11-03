// "Tasks" tab (F11): timers on the signed-in employee's assigned project tasks. The server keeps the
// timer (start and end use its clock), so it survives an app restart or a lost connection; this
// module only shows it. Timers are separate from attendance and are not a productivity measure.
import {
  addDays,
  formatDuration,
  formatDurationShort,
  localDate,
  totalMs,
  type Project,
  type TimeEndReason,
  type TimeEntry,
  type TimerState,
} from "@workfolio/shared";
import { HttpError, type ApiClient } from "./session.ts";

export interface TasksContext {
  client: ApiClient;
  timeZone: () => string | null;
  online: () => boolean;
}

const ENDED: Record<TimeEndReason, string> = {
  PAUSED: "paused",
  STOPPED: "stopped",
  BREAK: "ended by your break",
  CLOCK_OUT: "ended by clock-out",
};

/** What the timer card says about attendance (timers need an open shift with no break). */
export function attendanceNote(a: TimerState["attendance"]): string | null {
  if (!a.clockedIn) return "Clock in on the Today tab to start a task timer.";
  if (a.onBreak) return "You are on a break. Task timers are off until the break ends.";
  return null;
}

/** One history line: "APOLLO · Design — 09:00–10:30 (1h 30m, stopped)". */
export function entryLine(e: TimeEntry, time: (iso: string) => string): string {
  const span = `${time(e.startedAt)}–${e.endedAt ? time(e.endedAt) : "now"}`;
  return `${e.project.code} · ${e.task.title} — ${span} (${e.endedAt ? `${formatDuration(e.durationMs!)}, ${ENDED[e.endReason!]}` : "running"})`;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

export function initTasks(ctx: TasksContext) {
  let generation = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let refresher: ReturnType<typeof setInterval> | undefined;
  let state: TimerState | null = null;
  // The last load failed: what is shown is the last known state, so nothing ticks or can be pressed.
  let stale = false;
  let skewMs = 0; // server clock − this computer's clock, from the last response
  const tz = () => ctx.timeZone() ?? "UTC";
  const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: tz() }).format(new Date(iso));
  const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz() }).format(new Date(iso));
  const message = (err: unknown) => (!ctx.online() || !(err instanceof HttpError) ? "Connect to the server to use task timers. A running timer keeps running on the server." : err.message);
  const show = (sel: string, text: string) => {
    $(sel).hidden = !text;
    $(sel).textContent = text;
  };
  const busy = (on: boolean) => {
    for (const b of document.querySelectorAll<HTMLButtonElement>("#tasks-timer button")) b.disabled = on;
  };

  function tick() {
    const r = state?.running;
    $("#tasks-elapsed").textContent = r && !stale ? formatDurationShort(Date.now() + skewMs - Date.parse(r.startedAt)) : "";
  }

  function renderTimer(projects: Project[]) {
    const s = state!;
    const r = s.running;
    const note = attendanceNote(s.attendance);
    $("#tasks-attendance").hidden = !note;
    $("#tasks-attendance").textContent = note ?? "";
    $("#tasks-running").hidden = !r;
    $("#tasks-current").textContent = r ? `${r.project.code} · ${r.task.title}` : "";
    $("#tasks-since").textContent = r ? `Started ${time(r.startedAt)}` : "";
    $("#tasks-paused").hidden = !s.paused || !!r;
    $("#tasks-paused-text").textContent = s.paused ? `Paused: ${s.paused.project.code} · ${s.paused.task.title}` : "";
    $("#tasks-start-form").hidden = !!r;
    const select = $<HTMLSelectElement>("#tasks-task");
    const chosen = select.value;
    select.replaceChildren(
      ...projects.map((p) => {
        const group = Object.assign(document.createElement("optgroup"), { label: `${p.code} · ${p.name}` });
        group.append(...p.tasks.map((t) => Object.assign(el("option", t.title), { value: t.id })));
        return group;
      }),
    );
    if (chosen && projects.some((p) => p.tasks.some((t) => t.id === chosen))) select.value = chosen;
    const tasks = projects.reduce((n, p) => n + p.tasks.length, 0);
    $("#tasks-empty").hidden = tasks > 0;
    $("#tasks-empty").textContent = projects.length ? "Your projects have no open tasks." : "You are not assigned to any active project yet. An administrator assigns projects.";
    $<HTMLButtonElement>("#tasks-start").disabled = !tasks || !!note;
    $<HTMLButtonElement>("#tasks-resume").disabled = !!note;
    tick();
  }

  function renderHistory(entries: TimeEntry[]) {
    const done = entries.filter((e) => e.endedAt);
    $("#tasks-total").textContent = done.length ? `Timer time, last 7 days: ${formatDuration(totalMs(done))} over ${done.length} entr${done.length === 1 ? "y" : "ies"}.` : "";
    $("#tasks-history").replaceChildren(
      ...(entries.length
        ? entries.map((e) => {
            const li = el("li");
            li.append(el("strong", day(e.startedAt)), el("div", entryLine(e, time), "muted"));
            return li;
          })
        : [el("li", "No task time in the last 7 days.", "muted")]),
    );
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    show("#tasks-error", "");
    $("#tasks-status").textContent = "Loading…";
    try {
      const today = localDate(Date.now(), tz());
      const [s, projects, entries] = await Promise.all([
        ctx.client.request<TimerState>("GET", "/task-time/current"),
        ctx.client.request<Project[]>("GET", "/task-time/assignments"),
        ctx.client.request<TimeEntry[]>("GET", `/task-time/entries?from=${addDays(today, -6)}&to=${today}`),
      ]);
      if (mine !== generation) return;
      state = s;
      stale = false;
      busy(false);
      skewMs = Date.parse(s.serverTime) - Date.now();
      $("#tasks-status").textContent = "";
      $("#tasks-timer").hidden = false;
      renderTimer(projects);
      renderHistory(entries);
    } catch (err) {
      if (mine !== generation) return;
      $("#tasks-status").textContent = "";
      show("#tasks-error", message(err));
      if (state?.running) {
        // Never extrapolate: a break or clock-out may already have ended it on the server.
        stale = true;
        busy(true);
        tick();
        $("#tasks-since").textContent = `Last known: running since ${time(state.running.startedAt)}. The current state is unknown until the server can be reached.`;
      }
    }
  }

  async function act(fn: () => Promise<unknown>) {
    show("#tasks-error", "");
    busy(true);
    try {
      await fn();
    } catch (err) {
      show("#tasks-error", message(err));
    } finally {
      busy(false);
      await load(); // always show the server's view (e.g. after a duplicate or a 409)
    }
  }

  $("#tasks-start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const taskId = $<HTMLSelectElement>("#tasks-task").value;
    if (taskId) void act(() => ctx.client.request("POST", "/task-time/start", { taskId }));
  });
  $("#tasks-resume").addEventListener("click", () => state?.paused && void act(() => ctx.client.request("POST", "/task-time/start", { taskId: state!.paused!.task.id })));
  $("#tasks-pause").addEventListener("click", () => state?.running && void act(() => ctx.client.request("POST", `/task-time/${state!.running!.id}/pause`)));
  $("#tasks-stop").addEventListener("click", () => state?.running && void act(() => ctx.client.request("POST", `/task-time/${state!.running!.id}/stop`)));

  // Back online: show the server's state again (a break or clock-out elsewhere may have ended the timer).
  const reload = () => !$("#tab-tasks").hidden && void load();
  window.addEventListener("online", reload);

  return {
    show: () => {
      clearInterval(ticker);
      clearInterval(refresher);
      ticker = setInterval(tick, 1000);
      refresher = setInterval(reload, 30_000);
      return load();
    },
    hide: () => {
      generation++;
      clearInterval(ticker);
      clearInterval(refresher);
    },
  };
}
