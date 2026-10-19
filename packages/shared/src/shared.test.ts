import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmployeeSchema,
  hasPermission,
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
