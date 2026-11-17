// In-app updates (docs/desktop/AUTO-UPDATE-ARCHITECTURE.md). The Tauri updater asks the API's manifest
// endpoint, downloads the package for this OS/architecture and verifies its minisign signature (and the
// version it is bound to) against the public key compiled into this build before anything is installed.
// Nothing restarts without the employee's confirmation; a mandatory update only blocks clocking in.
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { DEVICE_HEADER, type ReportUpdateStatusInput, type UpdateState } from "@workfolio/shared";
import { CHECK_EVERY_MS, formatBytes, offerOf, postponeFor, shouldPrompt, updateErrorReason, type Offer, type Postponed } from "./update-policy.ts";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";

interface Deps {
  enabled: boolean;
  currentVersion: () => string;
  installationId: () => Promise<string>;
  /** Signed in with an active device: send the state to the API (errors are ignored). */
  report: (status: ReportUpdateStatusInput) => Promise<void>;
  /** Clocked in or on a break: restarting interrupts recording, so the confirmation says so. */
  working: () => boolean;
  /** Recording was stopped for the install but the install failed: configure it again. */
  resumeRecording: () => Promise<void>;
  kvGet: <T>(key: string) => Promise<T | null>;
  kvSet: (key: string, value: unknown) => Promise<void>;
  /** Re-render the rest of the app (the mandatory block on clocking in). */
  onChange: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const POSTPONE_KEY = "update_postponed";

export function initUpdates(d: Deps) {
  let phase: Phase = "idle";
  let update: Update | null = null;
  let offer: Offer | null = null;
  let error: string | null = null;
  let got = 0;
  let total: number | null = null;
  let confirming = false;
  let visible = false;
  let lastCheck: Date | null = null;

  const send = (state: UpdateState, failureReason: string | null = null) =>
    void d.report({ installedVersion: d.currentVersion(), availableVersion: offer?.version ?? null, state, failureReason }).catch(() => undefined);

  function render() {
    const card = $("#update-card");
    card.hidden = !visible || !offer || phase === "current" || phase === "idle" || phase === "checking";
    card.classList.toggle("mandatory", !!offer?.mandatory);
    if (offer) {
      $("#update-title").textContent = offer.mandatory
        ? "Update required"
        : offer.policy === "RECOMMENDED"
          ? "Recommended update available"
          : "Update available";
      $("#update-versions").textContent = `Installed: ${d.currentVersion()} · Available: ${offer.version}${formatBytes(offer.sizeBytes) ? ` · ${formatBytes(offer.sizeBytes)}` : ""}`;
      $("#update-notes").textContent = offer.notes || "No release notes.";
      $("#update-mandatory-note").hidden = !offer.mandatory;
    }
    const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null;
    $("#update-progress").hidden = phase !== "downloading";
    $<HTMLProgressElement>("#update-progress").value = pct ?? 0;
    $<HTMLProgressElement>("#update-progress").max = 100;
    if (pct === null) $<HTMLProgressElement>("#update-progress").removeAttribute("value"); // indeterminate
    $("#update-status").textContent =
      phase === "downloading"
        ? `Downloading… ${pct !== null ? `${pct}%` : formatBytes(got) ?? ""}`
        : phase === "ready"
          ? "Downloaded and verified. Restart to finish installing."
          : phase === "installing"
            ? "Installing… the app will restart."
            : "";
    $("#update-error").hidden = phase !== "error";
    $("#update-error").textContent = error ?? "";
    $("#update-now").hidden = !(phase === "available" || phase === "error");
    $("#update-now").textContent = phase === "error" ? "Try again" : "Update now";
    $("#update-later").hidden = !!offer?.mandatory || !(phase === "available" || phase === "error");
    $("#update-restart").hidden = phase !== "ready";
    $("#update-restart").textContent = confirming ? "Restart now" : "Restart to update";
    $("#update-confirm").hidden = !(phase === "ready" && confirming);
    $("#update-confirm").textContent = d.working()
      ? "You are clocked in. Restarting does not clock you out, but activity and screenshots pause for about a minute. Save your work first."
      : "Save your work first. The app closes and opens again on the new version.";
    // Settings: version and manual check.
    $("#update-check").toggleAttribute("disabled", !d.enabled || phase === "checking" || phase === "downloading" || phase === "installing");
    $("#update-check-status").textContent = !d.enabled
      ? "Automatic updates are not available in this build. Your IT administrator installs new versions."
      : phase === "checking"
        ? "Checking for updates…"
        : phase === "current"
          ? `You have the latest version.${lastCheck ? ` Checked ${lastCheck.toLocaleTimeString()}.` : ""}`
          : offer && phase !== "error"
            ? `Version ${offer.version} is available.`
            : phase === "error"
              ? (error ?? "")
              : "";
    d.onChange();
  }

  async function checkNow(manual: boolean) {
    if (!d.enabled || phase === "checking" || phase === "downloading" || phase === "installing" || phase === "ready") return;
    phase = "checking";
    error = null;
    render();
    try {
      await update?.close().catch(() => undefined);
      update = await check({ headers: { [DEVICE_HEADER]: await d.installationId() }, timeout: 30_000 });
      lastCheck = new Date();
      if (!update) {
        offer = null;
        phase = "current";
        send("UP_TO_DATE");
        return;
      }
      offer = offerOf(update.version, update.body, update.rawJson);
      phase = "available";
      const postponed = await d.kvGet<Postponed>(POSTPONE_KEY);
      visible = shouldPrompt(offer, postponed, Date.now(), manual);
      send(visible ? "AVAILABLE" : "POSTPONED");
    } catch (err) {
      update = null;
      offer = null;
      // A failed background check (offline, server down) stays quiet; a manual one says why in Settings.
      if (manual) fail(err);
      else phase = "idle";
    } finally {
      render();
    }
  }

  function fail(err: unknown) {
    console.error("update failed", err);
    error = updateErrorReason(err);
    phase = "error";
    send("FAILED", error);
  }

  async function download() {
    if (!update || phase === "downloading" || phase === "installing") return;
    phase = "downloading";
    got = 0;
    total = offer?.sizeBytes ?? null;
    error = null;
    confirming = false;
    render();
    send("DOWNLOADING");
    try {
      // The plugin verifies the signature and the signed version before this resolves.
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? total;
        else if (e.event === "Progress") got += e.data.chunkLength;
        render();
      });
      phase = "ready";
      if (offer?.mandatory) confirming = true;
    } catch (err) {
      fail(err);
    } finally {
      render();
    }
  }

  async function install() {
    if (!update || phase !== "ready") return; // one install at a time
    if (!confirming) {
      confirming = true;
      return render();
    }
    phase = "installing";
    render();
    send("INSTALLING");
    try {
      await invoke("update_stop_recording");
      await update.install(); // Windows: the installer takes over and restarts the app; this process exits.
      await invoke("update_restart"); // macOS: the new bundle is in place.
    } catch (err) {
      await d.resumeRecording().catch(() => undefined);
      fail(err);
      render();
    }
  }

  async function later() {
    if (!offer || offer.mandatory) return;
    await d.kvSet(POSTPONE_KEY, postponeFor(offer, Date.now()));
    visible = false;
    send("POSTPONED");
    render();
  }

  $("#update-now").addEventListener("click", () => void download());
  $("#update-restart").addEventListener("click", () => void install());
  $("#update-later").addEventListener("click", () => void later());
  $("#update-check").addEventListener("click", () => {
    visible = true;
    void checkNow(true);
  });
  render();

  return {
    /** After the app has started (signed in or not). Then every few hours. */
    start() {
      if (!d.enabled) return;
      setTimeout(() => void checkNow(false), 5_000);
      setInterval(() => void checkNow(false), CHECK_EVERY_MS);
    },
    /** Signed in on an active device: report the last check's outcome now (a check before sign-in could not). */
    reportNow() {
      if (phase === "current") send("UP_TO_DATE");
      else if (phase === "available") send(visible ? "AVAILABLE" : "POSTPONED");
    },
    /** An installed version below the minimum supported one: clocking in waits for the update. */
    blocksClockIn: () => !!offer?.mandatory && phase !== "current",
  };
}
