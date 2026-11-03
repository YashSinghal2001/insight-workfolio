import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_SCREENSHOT_SETTINGS, screenshotBlurOverrideSchema, screenshotRegisterSchema, screenshotSettingsSchema } from "../dist/index.js";

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

test("privacy masks: inside the frame, bounded, labelled; default none; invalid stored config fails closed", async () => {
  const { parseMaskRegions, sameMasks, screenshotMaskRegionSchema, SCREENSHOT_MASK_MAX_REGIONS } = await import("../dist/index.js");
  const base = { ...DEFAULT_SCREENSHOT_SETTINGS, reason: "masks" };
  delete (base as Record<string, unknown>).maskRegions;
  assert.deepEqual(screenshotSettingsSchema.parse(base).maskRegions, [], "older payloads without masks mean none");
  assert.deepEqual(DEFAULT_SCREENSHOT_SETTINGS.maskRegions, []);

  const ok = { x: 0, y: 9000, w: 10_000, h: 1000, label: "Dock" };
  assert.deepEqual(screenshotMaskRegionSchema.parse({ ...ok, label: "  Dock " }), ok, "label trimmed");
  for (const bad of [
    { ...ok, x: -1 }, { ...ok, w: 0 }, { ...ok, h: 0 }, { ...ok, y: 9001 }, { ...ok, x: 1, w: 10_000 }, { ...ok, x: 0.5 },
    { ...ok, label: "" }, { ...ok, label: "x".repeat(61) }, { ...ok, extra: 1 }, { x: 0, y: 0, w: 10, h: 10 },
  ]) {
    assert.ok(!screenshotMaskRegionSchema.safeParse(bad).success, JSON.stringify(bad));
  }
  const many = Array.from({ length: SCREENSHOT_MASK_MAX_REGIONS + 1 }, () => ok);
  assert.ok(!screenshotSettingsSchema.safeParse({ ...base, maskRegions: many }).success, "at most 20 masks");
  assert.ok(screenshotSettingsSchema.safeParse({ ...base, maskRegions: many.slice(1) }).success);

  assert.deepEqual(parseMaskRegions(JSON.stringify([ok])), [ok]);
  assert.deepEqual(parseMaskRegions("[]"), []);
  for (const bad of [null, undefined, "", "not json", "{}", JSON.stringify([{ ...ok, w: 0 }]), JSON.stringify(many)]) assert.equal(parseMaskRegions(bad), null, String(bad));

  const r = { x: 1, y: 2, w: 3, h: 4 };
  assert.ok(sameMasks([r], [{ ...r, label: "ignored" }]));
  assert.ok(sameMasks([], []));
  assert.ok(!sameMasks([r], []));
  assert.ok(!sameMasks([r, { ...r, x: 2 }], [{ ...r, x: 2 }, r]), "order matters");
  assert.ok(!sameMasks([r], [{ ...r, h: 5 }]));
});

test("screenshot registration: masks default to none, are validated and bounded", () => {
  const body = { id: "7d0e2c8e-3f7a-4b8e-9a51-2a1c3f5e6d70", capturedAt: "2026-10-29T10:00:00Z", sentAt: "2026-10-29T10:00:01Z", width: 1920, height: 1080, sizeBytes: 100, checksum: "a".repeat(64), mimeType: "image/webp" };
  assert.deepEqual(screenshotRegisterSchema.parse(body).masks, []);
  assert.ok(screenshotRegisterSchema.safeParse({ ...body, masks: [{ x: 0, y: 0, w: 10, h: 10 }] }).success);
  assert.ok(!screenshotRegisterSchema.safeParse({ ...body, masks: [{ x: 0, y: 0, w: 10, h: 10, label: "no labels here" }] }).success);
  assert.ok(!screenshotRegisterSchema.safeParse({ ...body, masks: [{ x: 9999, y: 0, w: 10, h: 10 }] }).success);
});

test("blur: off by default; older settings and registrations without it mean no blur; overrides need a reason and may clear", () => {
  assert.equal(DEFAULT_SCREENSHOT_SETTINGS.blur, false);
  const base: Record<string, unknown> = { ...DEFAULT_SCREENSHOT_SETTINGS, reason: "blur" };
  delete base.blur;
  assert.equal(screenshotSettingsSchema.parse(base).blur, false);
  assert.equal(screenshotSettingsSchema.parse({ ...base, blur: true }).blur, true);
  assert.ok(!screenshotSettingsSchema.safeParse({ ...base, blur: "yes" }).success);
  const body = { id: randomUUID(), capturedAt: "2026-10-29T10:00:00Z", sentAt: "2026-10-29T10:00:01Z", width: 1920, height: 1080, sizeBytes: 100, checksum: "a".repeat(64), mimeType: "image/webp" };
  assert.equal(screenshotRegisterSchema.parse(body).blurred, false);
  assert.equal(screenshotRegisterSchema.parse({ ...body, blurred: true }).blurred, true);
  assert.ok(!screenshotRegisterSchema.safeParse({ ...body, blurred: 1 }).success);
  for (const ok of [{ blur: true, reason: "client data" }, { blur: false, reason: "pilot" }, { blur: null, reason: "back to org" }]) assert.ok(screenshotBlurOverrideSchema.safeParse(ok).success, JSON.stringify(ok));
  for (const bad of [{ blur: true, reason: " x " }, { blur: true }, { reason: "missing blur" }, { blur: true, reason: "x".repeat(501) }, { blur: true, reason: "ok ok", extra: 1 }]) {
    assert.ok(!screenshotBlurOverrideSchema.safeParse(bad).success, JSON.stringify(bad));
  }
});
