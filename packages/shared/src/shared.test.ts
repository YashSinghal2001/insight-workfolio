import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditQuerySchema,
  createCorrectionSchema,
  createEmployeeSchema,
  hasPermission,
  loginSchema,
  reviewCorrectionSchema,
  screenshotGallerySchema,
  timeZoneSchema,
  updateAccountStatusSchema,
  listEmployeesQuerySchema,
  passwordSchema,
  updateEmployeeSchema,
} from "../dist/index.js";

test("roles: employees cannot read screenshots or manage employees, admins can", () => {
  assert.equal(hasPermission("EMPLOYEE", "screenshots:read"), false);
  assert.equal(hasPermission("EMPLOYEE", "employees:manage"), false);
  assert.equal(hasPermission("ADMIN", "screenshots:read"), true);
  assert.equal(hasPermission("EMPLOYEE", "profile:read-own"), true);
});

test("createEmployeeSchema normalizes input and defaults the timezone", () => {
  const ok = createEmployeeSchema.parse({ email: " A@Example.com ", fullName: " Asha ", employeeCode: "emp-01" });
  assert.deepEqual(ok, { email: "a@example.com", fullName: "Asha", employeeCode: "EMP-01", timezone: "Asia/Kolkata" });
  const bad = (v: object) => createEmployeeSchema.safeParse({ email: "a@b.co", fullName: "A", employeeCode: "E1", ...v });
  assert.equal(bad({ timezone: "Mars/Olympus" }).success, false);
  assert.equal(bad({ timezone: "IST" }).success, false);
  assert.equal(bad({ employeeCode: "x" }).success, false);
  assert.equal(bad({ email: "not-an-email" }).success, false);
});

test("updateEmployeeSchema rejects empty and unknown fields", () => {
  assert.equal(updateEmployeeSchema.safeParse({}).success, false);
  assert.equal(updateEmployeeSchema.safeParse({ role: "ADMIN" }).success, false);
  assert.equal(updateEmployeeSchema.safeParse({ employmentStatus: "ON_LEAVE" }).success, true);
});

test("password policy: 12–128 chars, not whitespace padding", () => {
  assert.equal(passwordSchema.safeParse("short").success, false);
  assert.equal(passwordSchema.safeParse("a".repeat(129)).success, false);
  assert.equal(passwordSchema.safeParse("ab          ").success, false);
  assert.equal(passwordSchema.safeParse("correct horse battery").success, true);
});

test("list query coerces and bounds pagination", () => {
  assert.deepEqual(listEmployeesQuerySchema.parse({ page: "2", pageSize: "5" }), { page: 2, pageSize: 5 });
  assert.equal(listEmployeesQuerySchema.safeParse({ pageSize: "500" }).success, false);
});

test("timeZoneSchema: one rule for every time-zone field", () => {
  for (const tz of ["UTC", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) assert.equal(timeZoneSchema.safeParse(tz).success, true, tz);
  for (const tz of ["EST", "GMT", "PST8PDT", "Mars/Olympus", "", "a".repeat(65)]) assert.equal(timeZoneSchema.safeParse(tz).success, false, tz);
  const range = { from: "2026-10-01", to: "2026-10-02" };
  assert.equal(auditQuerySchema.safeParse({ ...range, timeZone: "EST" }).success, false);
  assert.equal(auditQuerySchema.parse(range).timeZone, "UTC");
  assert.equal(screenshotGallerySchema.safeParse({ ...range, tz: "EST" }).success, false);
  assert.equal(screenshotGallerySchema.parse({ ...range, tz: "Asia/Kolkata" }).tz, "Asia/Kolkata");
});

test("admin and web bodies are strict; desktop login stays lenient", () => {
  const employee = { email: "a@example.com", fullName: "Asha", employeeCode: "EMP-01" };
  assert.equal(createEmployeeSchema.safeParse({ ...employee, role: "ADMIN" }).success, false);
  assert.equal(updateAccountStatusSchema.safeParse({ status: "ACTIVE", extra: 1 }).success, false);
  assert.equal(reviewCorrectionSchema.safeParse({ reason: "Looks right", approve: true }).success, false);
  const correction = { type: "MISSING_CLOCK_OUT", sessionId: "6f1c1f8e-2f37-4d55-9a66-6a2b9d3d1a10", clockOutAt: "2026-10-01T18:00:00Z", reason: "Forgot" };
  assert.equal(createCorrectionSchema.safeParse(correction).success, true);
  assert.equal(createCorrectionSchema.safeParse({ ...correction, employeeId: "x" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "a@example.com", password: "x", client: "desktop", appVersion: "0.1.0" }).success, true);
});
