// Screenshots in the desktop UI: decides when capture may run, drives the native worker (Rust),
// uploads the local queue and always shows the employee what is happening. Local capture and
// confirmed cloud upload are shown separately.
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_POLICY,
  DEFAULT_SCREENSHOT_SETTINGS,
  DEVICE_HEADER,
  type AttendanceCurrent,
  type ScreenshotRegisterResponse,
  type ScreenshotStatusResponse,
  type ScreenshotStoredResponse,
} from "@workfolio/shared";
import { decideScreenshots, screenshotReport, type ScreenshotDecision, type ScreenshotMode, type ScreenshotReport } from "./monitoring.ts";
import { uploadsFailing, type Notify } from "./notify.ts";
import { words } from "./platform.ts";
import { policyBlur, policyFresh, privacyText, storageLabel, uploadScreenshots, type ShotRow } from "./screenshot-sync.ts";
import { HttpError, type ApiClient, type CachedProfile } from "./session.ts";
import { project, type QueuedEvent, type SyncPhase } from "./sync.ts";

interface ShotStatus {
  supported: boolean;
  mode: string;
  capturing: boolean;
  permission: boolean;
  skipped: string | null;
  nextCaptureMs: number | null;
  lastCapture: { atMs: number; width: number; height: number; bytes: number; captureMs: number; encodeMs: number } | null;
  lastGapMs: [number, number] | null;
  error: string | null;
}

interface Summary {
  waiting: number;
  retrying: number;
  storedLocal: number;
  failed: number;
  rejected: number;
  lastStoredMs: number | null;
  lastError: string | null;
  problems: string[];
  localBytes: number;
  capBytes: number;
}

export interface ScreenshotContext {
  client: ApiClient;
  inTauri: boolean;
  kvGet: <T>(key: string) => Promise<T | null>;
  kvSet: (key: string, value: unknown) => Promise<void>;
  formatTime: (iso: string) => string;
  /** Edge-triggered OS notification (notify.ts). */
  notify: Notify;
  state: () => {
    profile: CachedProfile | null;
    installationId: string;
    deviceStatus: "ACTIVE" | "REVOKED" | "NOT_REGISTERED" | null;
    deviceId: string | null;
    current: AttendanceCurrent | null;
    queued: QueuedEvent[];
    attendancePhase: SyncPhase | undefined;
  };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const OFF: ShotStatus = { supported: false, mode: "STOPPED", capturing: false, permission: false, skipped: null, nextCaptureMs: null, lastCapture: null, lastGapMs: null, error: null };
const EMPTY: Summary = { waiting: 0, retrying: 0, storedLocal: 0, failed: 0, rejected: 0, lastStoredMs: null, lastError: null, problems: [], localBytes: 0, capBytes: 1 };
const LABEL: Record<ScreenshotMode, [string, string]> = {
  ACTIVE: ["On", "good"],
  PAUSED_BREAK: ["Paused (break)", "warn"],
  PAUSED_OFFLINE_OR_UNVERIFIED: ["Paused", "warn"],
  NEEDS_PERMISSION: ["Needs permission", "warn"],
  AWAITING_CONSENT: ["Awaiting consent", "warn"],
  STOPPED: ["Off", "off"],
  ERROR: ["Error", "bad"],
};
/** The "screenshot taken" indicator stays visible this long after each capture. */
const TAKEN_NOTICE_MS = 60_000;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const list = (sel: string, items: readonly string[]) =>
  $(sel).replaceChildren(...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));

let report: ScreenshotReport | undefined;
/**
 * How capture is going on this device, for the server (sent with the activity upload). A read of
 * what the last render decided; undefined when screenshots are off, the notice is not acknowledged,
 * capture is not meant to be running, or nothing is known yet.
 */
export const currentScreenshotReport = (): ScreenshotReport | undefined => report;

export function initScreenshots(ctx: ScreenshotContext) {
  let status: ScreenshotStatusResponse | null = null;
  /** When `status` last came from the server (ms); persisted beside the cached copy. */
  let statusAtMs: number | null = null;
  let native: ShotStatus = OFF;
  let summary: Summary = EMPTY;
  let decision: ScreenshotDecision = { mode: "STOPPED", reason: "Signed out. No screenshots are taken." };
  let applied = "";
  let uploading = false;
  let uploadError: string | null = null;
  let held = false;

  const call = <T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> => (ctx.inTauri ? invoke<T>(cmd, args) : Promise.resolve(fallback));
  const scope = () => {
    const s = ctx.state();
    return s.profile && s.deviceId ? { userId: s.profile.userId, deviceId: s.deviceId } : null;
  };
  const policy = () => ({ ...DEFAULT_SCREENSHOT_SETTINGS, ...status?.policy });
  const pendingAttendance = () => ctx.state().queued.some((e) => (e.status ?? "PENDING") === "PENDING");

  async function loadStatus() {
    const s = ctx.state();
    if (!s.profile) return;
    try {
      await fromServer(await ctx.client.request<ScreenshotStatusResponse>("GET", "/screenshots/me"), s.profile.userId);
    } catch {
      if (status) return; // keeps its age: the copy in memory is no fresher than when it was fetched
      status = await ctx.kvGet<ScreenshotStatusResponse>(`screenshots:${s.profile.userId}`);
      // A copy cached by an older app version has no age: treated as too old until the server answers.
      statusAtMs = await ctx.kvGet<number>(`screenshots-at:${s.profile.userId}`);
    }
  }

  async function fromServer(fresh: ScreenshotStatusResponse, userId: string) {
    status = fresh;
    statusAtMs = Date.now();
    await ctx.kvSet(`screenshots:${userId}`, status);
    await ctx.kvSet(`screenshots-at:${userId}`, statusAtMs);
  }

  function decide(): ScreenshotDecision {
    const s = ctx.state();
    const pending = s.queued.filter((e) => (e.status ?? "PENDING") === "PENDING");
    const projection = project(s.current, s.queued);
    const oldest = pending[0] ? Date.parse(pending[0].occurredAt) : null;
    return decideScreenshots({
      signedIn: !!s.profile,
      supported: native.supported,
      deviceStatus: s.deviceStatus,
      enabled: !!status?.policy.enabled,
      consented: !!status?.consent.acknowledgedAt && status.consent.noticeVersion === status.notice.version,
      permission: native.permission,
      policyStale: !!status && !policyFresh(statusAtMs, Date.now()),
      projection,
      pendingClockIn: !!projection?.session && pending.some((e) => e.type === "CLOCK_IN" && e.id === projection.session!.id),
      unverified: s.attendancePhase === "blocked" || (oldest !== null && Date.now() - oldest > DEFAULT_POLICY.maxOfflineAgeDays * 86_400_000),
      error: native.error,
    });
  }

  /** Tells the native worker what to do, only when something changed (a change restarts its schedule). */
  async function apply() {
    if (held) return; // halt(): stays paused until the break / clock-out is queued (release())
    decision = decide();
    const sc = scope();
    const session = project(ctx.state().current, ctx.state().queued)?.session ?? null;
    const active = decision.mode === "ACTIVE" && sc && session;
    const p = policy();
    // Rectangles only (labels are for people); a server without masks means none.
    const masks = (p.maskRegions ?? []).map(({ x, y, w, h }) => ({ x, y, w, h }));
    const blur = policyBlur(p);
    const key = `${decision.mode}|${active ? `${sc.userId}|${sc.deviceId}|${session.id}` : ""}|${p.intervalSeconds}|${p.webpQuality}|${p.maxDimension}|${JSON.stringify(masks)}|${blur}`;
    if (key === applied) return;
    applied = key;
    native = await call<ShotStatus>(
      "screenshot_configure",
      {
        mode: active ? "ACTIVE" : decision.mode,
        userId: active ? sc.userId : null,
        deviceId: active ? sc.deviceId : null,
        sessionId: active ? session.id : null,
        intervalSeconds: p.intervalSeconds,
        quality: p.webpQuality,
        maxDimension: p.maxDimension,
        masks,
        blur,
      },
      OFF,
    );
  }

  async function upload() {
    const sc = scope();
    if (uploading || !sc || !ctx.inTauri) return;
    uploading = true;
    try {
      const headers = { [DEVICE_HEADER]: ctx.state().installationId };
      const r = await uploadScreenshots({
        next: (nowMs) => call<ShotRow | null>("screenshot_next", { ...sc, nowMs }, null),
        read: (id) => invoke<ArrayBuffer>("screenshot_read", { id }),
        mark: (id, outcome, reason, nowMs) => call("screenshot_mark", { id, outcome, reason, nowMs }, undefined),
        register: (body) => ctx.client.request<ScreenshotRegisterResponse>("POST", "/screenshots/register", body, headers),
        upload: (id, bytes) => ctx.client.request<ScreenshotStoredResponse>("PUT", `/screenshots/${id}/content`, bytes, { ...headers, "content-type": "image/webp" }),
        attendancePending: pendingAttendance,
        projection: () => project(ctx.state().current, ctx.state().queued),
        now: () => Date.now(),
      });
      uploadError = r.failed;
      ctx.notify("screenshot-uploads", uploadsFailing(r.failed, pendingAttendance()), "Screenshot uploads are failing", "Screenshots stay on this computer and are retried automatically. Open Insight Workfolio for details.");
      if (r.stored) void loadStatus();
    } finally {
      uploading = false;
    }
  }

  async function poll() {
    native = await call<ShotStatus>("screenshot_status", {}, OFF);
    const sc = scope();
    if (sc) summary = await call<Summary>("screenshot_summary", sc, summary);
    await apply();
    render();
  }

  function render() {
    const s = ctx.state();
    const show = !!s.profile && s.deviceStatus === "ACTIVE";
    const p = policy();
    report = screenshotReport(decision.mode, native.skipped);
    const needsConsent = show && native.supported && !!status?.policy.enabled && status.consent.noticeVersion === status.notice.version && !status.consent.acknowledgedAt;
    $("#screenshots").hidden = !show;
    $("#screenshot-consent").hidden = !needsConsent;
    if (status) renderNotice(status);
    $("#tracking-screenshots").textContent = decision.mode === "ACTIVE" ? `On now: main screen every ${minutes(p.intervalSeconds)}${policyBlur(p) ? ", blurred" : ""}` : LABEL[decision.mode][0];
    if (!show) return;

    const [label, tone] = report === "CAPTURE_FAILED" ? ["Capture failed", "bad"] : LABEL[decision.mode];
    $("#shot-state").textContent = label;
    $("#shot-state").dataset.tone = tone;
    $("#shot-reason").textContent = decision.reason;
    const taken = native.lastCapture && Date.now() - native.lastCapture.atMs < TAKEN_NOTICE_MS ? native.lastCapture : null;
    $("#shot-taken").hidden = !taken;
    $("#shot-taken").textContent = taken ? `Screenshot taken at ${clock(taken.atMs)} (saved on this computer; upload pending).` : "";

    $("#shot-permission").textContent = !native.supported ? "Not available" : !native.permission ? "Not allowed" : words().permissionRequestable ? "Allowed" : "Not required";
    const askable = native.supported && !native.permission && !!status?.policy.enabled;
    $("#shot-permission-request").hidden = !askable || !words().permissionRequestable;
    $("#shot-permission-help").hidden = !askable;
    $("#shot-next").textContent = decision.mode === "ACTIVE" && native.nextCaptureMs ? clock(native.nextCaptureMs) : "—";
    $("#shot-last-local").textContent = native.lastCapture ? `${clock(native.lastCapture.atMs)} (${Math.round(native.lastCapture.bytes / 1024)} KB)` : "—";
    const cloud = [summary.lastStoredMs ? new Date(summary.lastStoredMs).toISOString() : null, status?.lastStoredAt].filter((v): v is string => !!v).sort().at(-1);
    $("#shot-last-cloud").textContent = cloud ? ctx.formatTime(cloud) : "Never";
    $("#shot-pending").textContent = summary.retrying ? `${summary.waiting} (${summary.retrying} retrying)` : String(summary.waiting);
    const used = summary.localBytes / summary.capBytes;
    $("#shot-storage").textContent = `${mb(summary.localBytes)} of ${mb(summary.capBytes)}`;

    const detail = pendingAttendance() && summary.waiting
      ? "Waiting for attendance changes to sync first."
      : uploadError
        ? `Upload failed: ${uploadError}. Screenshots stay on this computer and are retried automatically; nothing is deleted.`
        : summary.waiting
          ? "Screenshots are saved on this computer until cloud storage confirms them."
          : null;
    $("#shot-sync-detail").hidden = !detail;
    $("#shot-sync-detail").textContent = detail ?? "";
    const warning = native.skipped ?? (used >= 0.8 ? `Local screenshot storage is ${Math.round(used * 100)}% full; capture pauses at 100% until space is freed (waiting screenshots upload, or you dismiss ones that were not accepted).` : null);
    $("#shot-warning").hidden = !warning || decision.mode !== "ACTIVE";
    $("#shot-warning").textContent = warning ?? "";
    $("#shot-error").hidden = !native.error;
    $("#shot-error").textContent = native.error ?? "";
    const problems = summary.failed + summary.rejected;
    $("#shot-problems").hidden = !problems;
    $("#shot-problems-text").textContent = `${problems} screenshot(s) were not uploaded: ${summary.problems.join("; ")}.`;
    $("#shot-policy").textContent = status
      ? `Screenshots are ${p.enabled ? "on" : "off"} for your organization: main screen only, every ${minutes(p.intervalSeconds)}, WebP at quality ${p.webpQuality}, at most ${p.maxDimension} px wide or high, kept ${status.retentionDays} days in your organization's storage (${storageLabel(status.storageProvider)}). ${privacyText(p.maskRegions ?? [], policyBlur(p))}`
      : "Screenshot policy not loaded yet.";
  }

  const minutes = (s: number) => (s % 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? "" : "s"}`);
  const clock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: ctx.state().profile?.timezone }).format(new Date(ms));

  let renderedNotice = "";
  function renderNotice(s: ScreenshotStatusResponse) {
    $("#shot-ack").textContent = s.consent.acknowledgedAt
      ? `You acknowledged screenshot notice version ${s.notice.version} on ${ctx.formatTime(s.consent.acknowledgedAt)}.`
      : `You have not acknowledged the screenshot notice (version ${s.notice.version}); no screenshots are taken until you do.`;
    if (renderedNotice === `${s.notice.version}|${s.notice.createdAt}`) return;
    renderedNotice = `${s.notice.version}|${s.notice.createdAt}`;
    $("#shot-consent-heading").textContent = s.notice.title;
    $("#shot-consent-draft").hidden = !s.notice.draft;
    list("#shot-consent-points", s.notice.points);
    $("#shot-notice-title").textContent = `The notice (version ${s.notice.version}${s.notice.draft ? ", draft" : ""}): ${s.notice.title}`;
    list("#shot-notice-points", s.notice.points);
  }

  $("#shot-consent-accept").addEventListener("click", async () => {
    $("#shot-consent-error").hidden = true;
    if (!status) return;
    try {
      await fromServer(await ctx.client.request<ScreenshotStatusResponse>("POST", "/screenshots/consent", { noticeVersion: status.notice.version }), ctx.state().profile!.userId);
      await poll();
    } catch (err) {
      $("#shot-consent-error").hidden = false;
      $("#shot-consent-error").textContent = err instanceof HttpError ? err.message : "Connect to the server to acknowledge the notice.";
    }
  });
  $("#shot-permission-request").addEventListener("click", async () => {
    await call<boolean>("screenshot_request_permission", {}, false);
    await poll();
  });
  $("#shot-dismiss").addEventListener("click", async () => {
    const sc = scope();
    if (sc) await call("screenshot_dismiss", sc, 0);
    await poll();
  });

  setInterval(() => void poll(), 5_000);
  setInterval(() => {
    void upload().then(poll);
    void loadStatus().then(poll); // policy or notice changes within a minute
  }, 60_000);

  return {
    async enter() {
      await loadStatus();
      await poll();
      void upload().then(poll);
    },
    /**
     * A break or clock-out is about to be recorded: stop the native worker before its time is taken, so no
     * capture can be kept from that moment on (a capture already running is discarded by the worker).
     */
    async halt() {
      held = true;
      const p = policy();
      native = await call<ShotStatus>("screenshot_configure", { mode: "PAUSED_BREAK", userId: null, deviceId: null, sessionId: null, intervalSeconds: p.intervalSeconds, quality: p.webpQuality, maxDimension: p.maxDimension, masks: [], blur: false }, OFF);
      applied = ""; // the next apply() re-decides from the recorded attendance
    },
    release() {
      held = false;
      void apply().then(render);
    },
    /** Attendance changed: re-decide at once (a break or clock-out stops capture immediately). */
    update() {
      void apply().then(render);
    },
    kick() {
      void upload().then(poll);
    },
    async signOut() {
      status = null;
      statusAtMs = null;
      decision = { mode: "STOPPED", reason: "Signed out. No screenshots are taken." };
      const p = DEFAULT_SCREENSHOT_SETTINGS;
      native = await call<ShotStatus>("screenshot_configure", { mode: "STOPPED", userId: null, deviceId: null, sessionId: null, intervalSeconds: p.intervalSeconds, quality: p.webpQuality, maxDimension: p.maxDimension, masks: [], blur: false }, OFF);
      applied = "";
      renderedNotice = "";
      render();
    },
  };
}
