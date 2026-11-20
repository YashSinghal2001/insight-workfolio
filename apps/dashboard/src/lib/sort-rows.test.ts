// Run: node --test apps/dashboard/src/lib/sort-rows.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sortRows, type SortValue } from "./sort-rows.ts";

const by = (v: SortValue) => v;

test("numbers sort numerically both ways", () => {
  assert.deepEqual(sortRows([10, 2, 33, -1, 0], by), [-1, 0, 2, 10, 33]);
  assert.deepEqual(sortRows([10, 2, 33, -1, 0], by, "desc"), [33, 10, 2, 0, -1]);
});

test("strings sort case-insensitively with natural numbers", () => {
  assert.deepEqual(sortRows(["beta", "Alpha", "item 10", "item 2"], by), ["Alpha", "beta", "item 2", "item 10"]);
  assert.deepEqual(sortRows(["b", "a", "C"], by, "desc"), ["C", "b", "a"]);
});

test("nulls, undefined and NaN are last in both directions", () => {
  assert.deepEqual(sortRows([null, 3, undefined, 1, NaN], by), [1, 3, null, undefined, NaN]);
  assert.deepEqual(sortRows([null, 3, undefined, 1], by, "desc"), [3, 1, null, undefined]);
});

test("stable: equal keys keep input order in both directions", () => {
  const rows = [{ k: 1, id: "a" }, { k: 0, id: "b" }, { k: 1, id: "c" }, { k: 0, id: "d" }];
  assert.deepEqual(sortRows(rows, (r) => r.k).map((r) => r.id), ["b", "d", "a", "c"]);
  assert.deepEqual(sortRows(rows, (r) => r.k, "desc").map((r) => r.id), ["a", "c", "b", "d"]);
});

test("empty input and no mutation", () => {
  assert.deepEqual(sortRows([], by), []);
  const input = [3, 1, 2];
  sortRows(input, by);
  assert.deepEqual(input, [3, 1, 2]);
});
