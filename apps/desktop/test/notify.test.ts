// Runs with node's built-in TypeScript stripping: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeNotifier, uploadsFailing } from "../src/notify.ts";

test("notify: fires once on the transition, not again until recovered", async () => {
  const sent: string[] = [];
  const notify = edgeNotifier(async (title) => void sent.push(title));
  const blocked = (on: boolean | null) => notify("sync-blocked", on, "Sync blocked", "Open the app");
  assert.equal(blocked(false), false);
  assert.equal(blocked(true), true);
  assert.equal(blocked(true), false);
  assert.equal(blocked(null), false); // unknown keeps the state
  assert.equal(blocked(true), false);
  assert.equal(blocked(false), false);
  assert.equal(blocked(true), true); // recovered, then blocked again
  assert.equal(notify("uploads", true, "Uploads failing", ""), true); // keys are independent
  assert.deepEqual(sent, ["Sync blocked", "Sync blocked", "Uploads failing"]);
});

test("notify: a failing sender is logged, not thrown", async () => {
  const warn = console.warn;
  let warned = 0;
  console.warn = () => void warned++;
  try {
    assert.equal(edgeNotifier(() => Promise.reject(new Error("no plugin")))("k", true, "t", "b"), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(warned, 1);
  } finally {
    console.warn = warn;
  }
});

test("notify: uploads failing ignores offline and attendance waits", () => {
  assert.equal(uploadsFailing("Storage not configured", false), true);
  assert.equal(uploadsFailing("Server unreachable", false), null);
  assert.equal(uploadsFailing(null, true), null);
  assert.equal(uploadsFailing(null, false), false);
});
