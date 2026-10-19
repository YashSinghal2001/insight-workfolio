import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_SCREENSHOT_SETTINGS, screenshotRegisterSchema, screenshotSettingsSchema } from "../dist/index.js";

test("screenshot settings: off by default, validated, no extra fields", () => {
  assert.equal(DEFAULT_SCREENSHOT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SCREENSHOT_SETTINGS.intervalSeconds, 300);
  assert.equal(DEFAULT_SCREENSHOT_SETTINGS.webpQuality, 70);
  const ok = { ...DEFAULT_SCREENSHOT_SETTINGS, reason: "pilot" };
  assert.ok(screenshotSettingsSchema.safeParse(ok).success);
  for (const bad of [
    { intervalSeconds: 10 }, { webpQuality: 100 }, { maxDimension: 8000 }, { retentionDays: 1 },
    { captureScope: "ALL_DISPLAYS" }, { reason: " " }, { blurText: true },
  ]) {
    assert.equal(screenshotSettingsSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("screenshot registration: metadata only, WebP only, checksum and size bounds", () => {
  const ok = {
    id: randomUUID(), capturedAt: "2026-10-13T09:00:00.000Z", sentAt: "2026-10-13T09:00:01.000Z",
    width: 1920, height: 1080, sizeBytes: 180_000, checksum: "a".repeat(64), mimeType: "image/webp",
  };
  assert.ok(screenshotRegisterSchema.safeParse(ok).success);
  for (const bad of [
    { mimeType: "image/png" }, { checksum: "A".repeat(64) }, { checksum: "abc" }, { sizeBytes: 0 }, { sizeBytes: 11 * 1024 * 1024 },
    { width: 5000 }, { capturedAt: "yesterday" }, { windowTitle: "Inbox" }, { id: "1" },
  ]) {
    assert.equal(screenshotRegisterSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});
