import assert from "node:assert/strict";
import { test } from "node:test";
import { latestOnly } from "./latest";

test("only the most recent request stays current; a slow older response is dropped", async () => {
  const guard = latestOnly();
  const applied: string[] = [];
  const load = async (name: string, ms: number) => {
    const isCurrent = guard.begin();
    await new Promise((r) => setTimeout(r, ms));
    if (isCurrent()) applied.push(name);
  };
  await Promise.all([load("old range", 30), load("new range", 5)]);
  assert.deepEqual(applied, ["new range"]);
  const isCurrent = guard.begin();
  assert.equal(isCurrent(), true);
});
