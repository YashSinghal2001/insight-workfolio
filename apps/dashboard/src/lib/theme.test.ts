// Run: node --test apps/dashboard/src/lib/theme.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readTheme, resolveTheme, THEME_KEY, THEME_SCRIPT, writeTheme } from "./theme.ts";

const store = (v: string | null) => ({ getItem: (k: string) => (k === THEME_KEY ? v : null) });
const throwing = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("QuotaExceededError");
  },
};

test("stored choice wins", () => {
  assert.equal(readTheme(store("dark")), "dark");
  assert.equal(readTheme(store("light")), "light");
});

test("default and invalid values resolve to light", () => {
  assert.equal(readTheme(store(null)), "light");
  assert.equal(readTheme(store("DARK")), "light");
  assert.equal(readTheme(store("")), "light");
  assert.equal(readTheme(undefined), "light");
  assert.equal(resolveTheme(42), "light");
});

test("blocked storage never throws", () => {
  assert.equal(readTheme(throwing), "light");
  assert.equal(writeTheme(throwing, "dark"), false);
  assert.equal(writeTheme(undefined, "dark"), false);
});

test("write then read round-trips", () => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(writeTheme(s, "dark"), true);
  assert.equal(readTheme(s), "dark");
  writeTheme(s, "light");
  assert.equal(readTheme(s), "light");
});

test("pre-paint script applies only a stored dark choice and survives blocked storage", () => {
  const run = (localStorage: unknown) => {
    const documentElement = { dataset: {} as Record<string, string> };
    new Function("localStorage", "document", THEME_SCRIPT)(localStorage, { documentElement });
    return documentElement.dataset.theme;
  };
  assert.equal(run(store("dark")), "dark");
  assert.equal(run(store("light")), undefined);
  assert.equal(run(store("bogus")), undefined);
  assert.equal(run(throwing), undefined);
});
