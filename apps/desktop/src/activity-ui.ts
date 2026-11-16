import type { DeviceStatusResponse } from "@workfolio/shared";
// Activity monitoring in the desktop UI: decides the monitoring mode from attendance, drives the
// native collector (Rust), uploads its intervals and shows the employee exactly what is happening.
import { invoke } from "@tauri-apps/api/core";
import {
  ACTIVITY_BATCH_MAX,
  COLLECTED_DATA,
  DEFAULT_MONITORING_POLICY,
  DEFAULT_POLICY,
  DEVICE_HEADER,
  formatDurationShort as formatDuration,
  todayIn,
  zonedToUtc,
  type ActivityCurrent,
  type ActivityStatusResponse,
  type ActivitySyncRequest,
  type ActivitySyncResponse,
  type AttendanceCurrent,
} from "@workfolio/shared";
import { liveState, nextReport, reportDue, retryDelayMs, type Reported } from "./live-state.ts";
import { appNapText, collectorStateText, decideMonitoring, type MonitoringDecision, type MonitoringMode } from "./monitoring.ts";
import { currentScreenshotReport } from "./screenshot-ui.ts";
import { HttpError, type ApiClient, type CachedProfile } from "./session.ts";
import { project, SyncEngine, type QueuedEvent, type SyncPhase } from "./sync.ts";

interface CollectorStatus {
  supported: boolean;
  mode: string;
  collecting: boolean;
  currentApp: { id: string | null; name: string } | null;
  idle: boolean;
  locked: boolean;
  /** Going to sleep (until wake). */
  asleep?: boolean;
  /** Another user's session in front, or logging out. */
  sessionInactive?: boolean;
  /** Seconds since the last keyboard/mouse input at the last sample. */
  idleSeconds?: number | null;
  idleThresholdSeconds?: number;
  sampleSeconds?: number;
  /** App Nap opt-out in force (only while recording). */
  appNapPrevented?: boolean;
  error: string | null;
  lastSampleMs: number | null;
  idleSinceMs: number | null;
  lastGapMs: [number, number] | null;
}

interface ActivityRow {
  id: string;
  kind: "ACTIVE" | "IDLE";
  appId: string | null;
  appName: string | null;
  startMs: number;
  endMs: number;
  status: string;
  reason: string | null;
}

interface Unsynced {
  activeMs: number;
  idleMs: number;
  pending: number;
  rejected: number;
}

export interface ActivityContext {
  client: ApiClient;
  inTauri: boolean;
  kvGet: <T>(key: string) => Promise<T | null>;
  kvSet: (key: string, value: unknown) => Promise<void>;
  formatTime: (iso: string) => string;
  state: () => {
    profile: CachedProfile | null;
    online: boolean;
    platform: "macos" | "windows";
    installationId: string;
    deviceStatus: DeviceStatusResponse["status"] | null;
    deviceId: string | null;
    current: AttendanceCurrent | null;
    queued: QueuedEvent[];
    attendancePhase: SyncPhase | undefined;
  };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const OFF: CollectorStatus = {
  supported: false, mode: "STOPPED", collecting: false, currentApp: null, idle: false, locked: false, error: null, lastSampleMs: null, idleSinceMs: null, lastGapMs: null,
};
/** Gaps shorter than this are sampling noise, not worth a notice. */
const GAP_NOTICE_MS = 60_000;
const list = (sel: string, items: readonly string[]) =>
  $(sel).replaceChildren(...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
const LABEL: Record<MonitoringMode, [string, string]> = {
  ACTIVE: ["On", "good"],
  PAUSED_BREAK: ["Paused (break)", "warn"],
  PAUSED_OFFLINE_OR_UNVERIFIED: ["Paused", "warn"],
  STOPPED: ["Off", "off"],
  ERROR: ["Error", "bad"],
};

export function initActivity(ctx: ActivityContext) {
  let status: ActivityStatusResponse | null = null;
  let collector: CollectorStatus = OFF;
  let unsynced: Unsynced = { activeMs: 0, idleMs: 0, pending: 0, rejected: 0 };
  let rejectedReasons: string[] = [];
  let recovered: { count: number; atMs: number } | null = null;
  let engine: SyncEngine<ActivityRow, ActivitySyncResponse> | null = null;
  let engineScope = "";
  let applied = "";
  let decision: MonitoringDecision = { mode: "STOPPED", reason: "Signed out. Nothing is recorded.", pendingConfirmation: false };

  const call = <T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> =>
    ctx.inTauri ? invoke<T>(cmd, args) : Promise.resolve(fallback);
  const scope = () => {
    const s = ctx.state();
    return s.profile && s.deviceId ? { userId: s.profile.userId, deviceId: s.deviceId } : null;
  };
  const policy = () => ({ ...DEFAULT_MONITORING_POLICY, ...status?.policy });

  // ---- Live state (ACTIVE / IDLE / UNOBSERVED) for the dashboards ------------------------
  let reported: Reported | null = null;
  let reportFailures = 0;
  let reportRetryAt = 0;
  const upload = (body: ActivitySyncRequest) =>
    ctx.client.request<ActivitySyncResponse>("POST", "/activity/sync", body, { [DEVICE_HEADER]: ctx.state().installationId });
  /** Null when nothing may be reported: not monitoring, offline, or attendance still waiting to sync (the server needs the clock-in first). */
  const live = () => {
    const s = ctx.state();
    return liveState(collector, decision.mode === "ACTIVE", s.online && !s.queued.some((e) => (e.status ?? "PENDING") === "PENDING"));
  };
  /** The live state to attach to an upload going out now; it then counts as reported. */
  function currentNow(): ActivityCurrent | undefined {
    const state = live();
    reported = state && nextReport(reported, state, collector.idleSinceMs, Date.now());
    return reported ? { state: reported.state, since: new Date(reported.sinceMs).toISOString(), screenshot: currentScreenshotReport() } : undefined;
  }
  /** An upload with no intervals when the state changed or the keepalive is due; otherwise no request. */
  async function reportLive() {
    const state = live();
    if (!state) return void (reported = null); // the next report after resuming goes out at once
    if (!reportDue(reported, state, Date.now()) || Date.now() < reportRetryAt) return;
    const before = reported;
    const current = currentNow();
    const mine = reported;
    if (!current) return;
    try {
      await upload({ sentAt: new Date().toISOString(), platform: ctx.state().platform, intervals: [], current });
      reportFailures = 0;
    } catch {
      // Not sent: due again at the next poll, after the same backoff as the upload queue. Unless an
      // interval upload carried the state meanwhile (then `reported` is no longer this attempt's).
      if (reported === mine) reported = before;
      reportRetryAt = Date.now() + retryDelayMs(++reportFailures);
    }
  }

  /** Loads policy/consent/totals from the server, or the cached copy when offline. */
  async function loadStatus() {
    const s = ctx.state();
    if (!s.profile) return;
    try {
      status = await ctx.client.request<ActivityStatusResponse>("GET", "/activity/me");
      await ctx.kvSet(`activity:${s.profile.userId}`, status);
    } catch {
      // A copy cached by an older app version has no notice: treat it as unknown (monitoring stays off).
      const cached = await ctx.kvGet<ActivityStatusResponse>(`activity:${s.profile.userId}`);
      status ??= cached?.notice ? cached : null;
    }
  }

  function decide(): MonitoringDecision {
    const s = ctx.state();
    const pendingEvents = s.queued.filter((e) => (e.status ?? "PENDING") === "PENDING");
    const projection = project(s.current, s.queued);
    const oldest = pendingEvents[0] ? Date.parse(pendingEvents[0].occurredAt) : null;
    return decideMonitoring({
      signedIn: !!s.profile,
      supported: collector.supported,
      deviceStatus: s.deviceStatus,
      enabled: policy().enabled,
      // The server returns the acknowledgement of the notice it currently requires.
      consented: !!status?.consent.acknowledgedAt && status.consent.noticeVersion === status.notice.version,
      projection,
      pendingClockIn: !!projection?.session && pendingEvents.some((e) => e.type === "CLOCK_IN" && e.id === projection.session!.id),
      unverified:
        s.attendancePhase === "blocked" ||
        (oldest !== null && Date.now() - oldest > DEFAULT_POLICY.maxOfflineAgeDays * 86_400_000),
      collectorError: collector.error,
    });
  }

  /** Tells the native collector what to do; only when the decision actually changes. */
  async function apply() {
    decision = decide();
    const sc = scope();
    const active = decision.mode === "ACTIVE" && sc;
    // Older servers send no exclusion list (W22): nothing is excluded.
    const idleExcludedApps = policy().idleExcludedApps ?? [];
    const key = `${decision.mode}|${active ? `${sc.userId}|${sc.deviceId}` : ""}|${policy().sampleSeconds}|${policy().idleThresholdSeconds}|${idleExcludedApps.join("\n")}`;
    if (key === applied) return;
    applied = key;
    collector = await call<CollectorStatus>(
      "activity_configure",
      {
        mode: decision.mode,
        userId: active ? sc.userId : null,
        deviceId: active ? sc.deviceId : null,
        sampleSeconds: policy().sampleSeconds,
        idleThresholdSeconds: policy().idleThresholdSeconds,
        idleExcludedApps,
      },
      OFF,
    );
  }

  function ensureEngine() {
    const sc = scope();
    const key = sc ? `${sc.userId}|${sc.deviceId}` : "";
    if (key === engineScope) return;
    engine?.stop();
    engine = null;
    engineScope = key;
    if (!sc) return;
    engine = new SyncEngine<ActivityRow, ActivitySyncResponse>(
      {
        // Attendance first: intervals are validated against clocked-in time on the server.
        list: async () => {
          if (ctx.state().queued.some((e) => (e.status ?? "PENDING") === "PENDING")) return [];
          return call<ActivityRow[]>("activity_list", { ...sc, limit: ACTIVITY_BATCH_MAX * 2 }, []);
        },
        ack: (ids) => call("activity_ack", { ids }, undefined),
        reject: (id, reason) => call("activity_reject", { id, reason }, undefined),
      },
      ({ sentAt, items }) =>
        upload({
          sentAt,
          platform: ctx.state().platform,
          intervals: items.map((r) => ({
            id: r.id,
            kind: r.kind,
            applicationIdentifier: r.kind === "ACTIVE" ? r.appId : null,
            applicationName: r.kind === "ACTIVE" ? r.appName : null,
            startedAt: new Date(r.startMs).toISOString(),
            endedAt: new Date(r.endMs).toISOString(),
          })),
          current: currentNow(),
        }),
      {
        batchSize: ACTIVITY_BATCH_MAX,
        onStatus: () => render(),
        onSynced: () => void loadStatus().then(poll),
      },
    );
  }

  /** Refreshes collector status and local (unsynced) totals, re-applies the decision, renders. */
  async function poll() {
    const s = ctx.state();
    const sc = scope();
    collector = await call<CollectorStatus>("activity_status", {}, OFF);
    if (sc && s.profile) {
      const tz = s.profile.timezone;
      const since = Date.parse(zonedToUtc(`${todayIn(tz)}T00:00`, tz));
      unsynced = await call<Unsynced>("activity_unsynced", { ...sc, sinceMs: since }, unsynced);
      const rows = unsynced.rejected ? await call<ActivityRow[]>("activity_list", { ...sc, limit: 50 }, []) : [];
      rejectedReasons = [...new Set(rows.filter((r) => r.status === "REJECTED").map((r) => r.reason ?? "rejected"))];
    }
    await apply();
    render();
    await reportLive();
  }

  function render() {
    const s = ctx.state();
    const show = !!s.profile && s.deviceStatus === "ACTIVE";
    const needsConsent = show && collector.supported && !!status && status.policy.enabled && !status.consent.acknowledgedAt;
    $("#monitoring").hidden = !show;
    $("#monitoring-consent").hidden = !needsConsent;
    if (status) renderNotice(status);
    const [label, tone] = LABEL[decision.mode];
    $("#tracking-state").textContent =
      decision.mode === "ACTIVE" ? "On now: active application and idle time" : decision.mode === "PAUSED_BREAK" ? "Paused (break)" : "Off";
    if (!show) return;

    $("#mon-state").textContent = decision.pendingConfirmation ? "On (pending)" : label;
    $("#mon-state").dataset.tone = tone;
    const nap = decision.mode === "ACTIVE" ? appNapText(collector) : null;
    $("#mon-reason").textContent = nap ? `${decision.reason} ${nap}` : decision.reason;
    $("#mon-app").textContent = collectorStateText(collector, decision.mode === "ACTIVE", clock);
    // The threshold in force in the collector while recording, otherwise the organization's policy.
    const idleAfter = (collector.collecting && collector.idleThresholdSeconds) || policy().idleThresholdSeconds;
    $("#mon-idle-after").textContent = `${idleAfter % 60 ? `${idleAfter} s` : `${idleAfter / 60} min`} without keyboard or mouse input, or as soon as the screen is locked`;

    const today = status && status.today.date === todayIn(s.profile!.timezone) ? status.today : { activeMs: 0, idleMs: 0 };
    $("#mon-today-active").textContent = formatDuration(today.activeMs + unsynced.activeMs);
    $("#mon-today-idle").textContent = formatDuration(today.idleMs + unsynced.idleMs);
    const p = project(s.current, s.queued);
    const session = p?.state !== "CLOCKED_OUT" && p?.session ? p.session : null;
    const synced = session && status?.currentSession?.sessionId === session.id ? status.currentSession : null;
    $("#mon-session").textContent = session
      ? `${formatDuration((synced?.activeMs ?? 0) + unsynced.activeMs)} active, ${formatDuration((synced?.idleMs ?? 0) + unsynced.idleMs)} idle`
      : "—";
    $("#mon-pending").textContent = String(unsynced.pending);
    // Last successful upload: this session's engine, or what the server last received.
    const lastUpload = [engine?.status.lastSyncAt, status?.lastReceivedAt].filter((v): v is string => !!v).sort().at(-1);
    $("#mon-last").textContent = lastUpload ? ctx.formatTime(lastUpload) : "Never";

    const phase = engine?.status.phase;
    const waitingForAttendance = s.queued.some((e) => (e.status ?? "PENDING") === "PENDING") && unsynced.pending > 0;
    const detail = waitingForAttendance
      ? "Waiting for attendance changes to sync first."
      : phase === "offline"
        ? "Server unreachable; activity is kept on this computer and uploads automatically."
        : phase === "error" || phase === "blocked"
          ? `Upload failed: ${engine?.status.error}. It will be retried; nothing is deleted.`
          : null;
    $("#mon-sync-detail").hidden = !detail;
    $("#mon-sync-detail").textContent = detail ?? "";
    const gap = collector.lastGapMs;
    const showGap = !!gap && gap[1] - gap[0] >= GAP_NOTICE_MS && Date.now() - gap[1] < 12 * 3_600_000;
    $("#mon-gap").hidden = !showGap;
    $("#mon-gap").textContent = showGap
      ? `Not recorded from ${clock(gap[0])} to ${clock(gap[1])}: the computer was asleep or locked, another user was signed in, or the app was suspended. That time is not counted as active or idle.`
      : "";
    $("#mon-recovered").hidden = !recovered;
    $("#mon-recovered-text").textContent = recovered
      ? `The app closed unexpectedly. ${recovered.count} activity record(s) were kept up to the last save; time while the app was not running is not recorded.`
      : "";
    $("#mon-error").hidden = !collector.error;
    $("#mon-error").textContent = collector.error ?? "";
    $("#mon-rejected").hidden = !unsynced.rejected;
    $("#mon-rejected-text").textContent = `${unsynced.rejected} activity record(s) were not accepted: ${rejectedReasons.join("; ")}.`;
  }

  const clock = (ms: number | null) =>
    ms === null ? "—" : new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: ctx.state().profile?.timezone }).format(new Date(ms));

  // ---- Consent ----------------------------------------------------------------------
  /** The notice text comes from the server (it can change without an app update). */
  let renderedNotice = "";
  function renderNotice(s: ActivityStatusResponse) {
    $("#mon-consent-ack").textContent = s.consent.acknowledgedAt
      ? `You acknowledged notice version ${s.notice.version} on ${ctx.formatTime(s.consent.acknowledgedAt)}.`
      : `You have not acknowledged the current notice (version ${s.notice.version}); nothing is recorded until you do.`;
    if (renderedNotice === `${s.notice.version}|${s.notice.createdAt}`) return;
    renderedNotice = `${s.notice.version}|${s.notice.createdAt}`;
    $("#consent-heading").textContent = s.notice.title;
    $("#consent-draft").hidden = !s.notice.draft;
    list("#consent-points", s.notice.points);
    $("#mon-notice-title").textContent = `The notice (version ${s.notice.version}${s.notice.draft ? ", draft" : ""}): ${s.notice.title}`;
    list("#mon-notice-points", s.notice.points);
  }
  $("#consent-never").textContent = COLLECTED_DATA.never.join(", ").toLowerCase();
  list("#mon-collected", COLLECTED_DATA.collected);
  list("#mon-never", COLLECTED_DATA.never);
  $("#consent-accept").addEventListener("click", async () => {
    $("#consent-error").hidden = true;
    if (!status) return;
    try {
      status = await ctx.client.request<ActivityStatusResponse>("POST", "/activity/consent", { noticeVersion: status.notice.version });
      await ctx.kvSet(`activity:${ctx.state().profile!.userId}`, status);
      await poll();
    } catch (err) {
      $("#consent-error").hidden = false;
      $("#consent-error").textContent = err instanceof HttpError ? err.message : "Connect to the server to acknowledge the notice.";
    }
  });
  $("#mon-recovered-dismiss").addEventListener("click", async () => {
    recovered = null;
    await ctx.kvSet("activity_recovered", null);
    render();
  });
  $("#mon-dismiss").addEventListener("click", async () => {
    const sc = scope();
    if (sc) await call("activity_dismiss_rejected", sc, undefined);
    await poll();
  });

  setInterval(() => void poll(), 5_000);
  setInterval(() => {
    void engine?.kick(); // regular uploads while working
    // Settings changes (monitoring off, new notice, new thresholds) are picked up within a minute.
    void loadStatus().then(poll);
  }, 60_000);

  return {
    /** After sign-in/restore or device change. */
    async enter() {
      recovered = await ctx.kvGet<{ count: number; atMs: number }>("activity_recovered");
      await loadStatus();
      ensureEngine();
      await poll();
      void engine?.kick();
    },
    /** Attendance state changed (button press, sync): re-decide immediately. */
    update() {
      ensureEngine();
      void apply().then(render);
    },
    kick() {
      void engine?.kick();
    },
    async signOut() {
      engine?.stop();
      engine = null;
      engineScope = "";
      reported = null;
      status = null;
      decision = { mode: "STOPPED", reason: "Signed out. Nothing is recorded.", pendingConfirmation: false };
      collector = await call<CollectorStatus>("activity_configure", { mode: "STOPPED", userId: null, deviceId: null, sampleSeconds: 15, idleThresholdSeconds: 300 }, OFF);
      renderedNotice = "";
      applied = "STOPPED||15|300";
      render();
    },
  };
}
