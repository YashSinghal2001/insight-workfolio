import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatBytes, offerOf, OPTIONAL_POSTPONE_HOURS, postponeFor, shouldPrompt, updateErrorReason } from "../src/update-policy.ts";

const H = 3_600_000;

test("offer: policy fields come from the API manifest; anything missing or odd means optional", () => {
  assert.deepEqual(offerOf("0.3.0", "Notes", { policy: "RECOMMENDED", mandatory: false, postponeHours: 8, sizeBytes: 1234 }), {
    version: "0.3.0", notes: "Notes", policy: "RECOMMENDED", mandatory: false, postponeHours: 8, sizeBytes: 1234,
  });
  const bare = offerOf("0.3.0", undefined, {});
  assert.deepEqual([bare.policy, bare.mandatory, bare.postponeHours, bare.sizeBytes, bare.notes], ["OPTIONAL", false, OPTIONAL_POSTPONE_HOURS, null, ""]);
  // Only an explicit `mandatory: true` blocks anything; the configurable postponement is for Recommended only.
  assert.equal(offerOf("1.0.0", "", { policy: "MANDATORY", mandatory: "yes" }).mandatory, false);
  assert.equal(offerOf("1.0.0", "", { policy: "OPTIONAL", postponeHours: 2 }).postponeHours, OPTIONAL_POSTPONE_HOURS);
  assert.equal(offerOf("1.0.0", "", { policy: "BOGUS" }).policy, "OPTIONAL");
});

test("postponing: per version, for the policy's period; a mandatory update cannot be postponed", () => {
  const now = Date.UTC(2026, 10, 17);
  const rec = offerOf("0.3.0", "", { policy: "RECOMMENDED", postponeHours: 8 });
  const p = postponeFor(rec, now)!;
  assert.deepEqual(p, { version: "0.3.0", untilMs: now + 8 * H });
  assert.equal(shouldPrompt(rec, p, now + 7 * H, false), false, "hidden while postponed");
  assert.equal(shouldPrompt(rec, p, now + 8 * H, false), true, "back after the period");
  assert.equal(shouldPrompt(rec, p, now + H, true), true, "a manual check always shows it");
  assert.equal(shouldPrompt(offerOf("0.3.1", "", {}), p, now + H, false), true, "a newer version is not covered");
  const mandatory = offerOf("0.4.0", "", { policy: "MANDATORY", mandatory: true });
  assert.equal(postponeFor(mandatory, now), null);
  assert.equal(shouldPrompt(mandatory, { version: "0.4.0", untilMs: now + H }, now, false), true);
});

test("error reasons are short and never carry paths or URLs", () => {
  assert.match(updateErrorReason(new Error("signature verification failed: minisign")), /security check/);
  assert.match(updateErrorReason("SignedVersionMismatch { signed: 0.2.0, announced: 0.3.0 }"), /security check/);
  // The plugin's own text for a manifest announcing another version than the package is signed for (seen in QA).
  assert.match(updateErrorReason("The update was signed for version 0.3.0 but the update endpoint announced version 0.3.1. The endpoint response may have been tampered with to force installing a different release."), /security check/);
  assert.match(updateErrorReason("No space left on device (os error 28)"), /disk space/);
  assert.match(updateErrorReason("There is not enough space on the disk. (os error 112)"), /disk space/);
  assert.match(updateErrorReason("error sending request for url (https://api.example.com/x)"), /connection/);
  assert.match(updateErrorReason("Download request failed with status: 404 Not Found"), /connection/);
  assert.match(updateErrorReason("error decoding response body"), /connection/, "download cut off mid-way (seen in QA)");
  assert.match(updateErrorReason("Permission denied (os error 13)"), /not writable/);
  const other = updateErrorReason("weird failure at /Users/someone/Library/x and https://secret.example/y?token=1");
  assert.ok(!other.includes("/Users/someone") && !other.includes("secret.example"), other);
  assert.ok(other.length <= 300);
});

test("formatBytes", () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(512), "1 KB");
  assert.equal(formatBytes(9_500_000), "9.1 MB");
});

test("the update UI is wired: elements exist, the updater permission is granted, nothing else is", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["update-card", "update-title", "update-versions", "update-notes", "update-mandatory-note", "update-progress", "update-status", "update-error", "update-confirm", "update-now", "update-restart", "update-later", "update-check", "update-check-status", "update-installed"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const caps = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.deepEqual(caps.permissions, ["core:default", "notification:allow-notify", "updater:default"]);
});
