import { test } from "node:test";
import assert from "node:assert/strict";
import { pollWhileVisible } from "./poll";

function fakeDoc(state: "visible" | "hidden") {
  let listener: (() => void) | null = null;
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => void (listener = l),
    removeEventListener: () => void (listener = null),
    show() { this.visibilityState = "visible"; listener?.(); },
    hide() { this.visibilityState = "hidden"; listener?.(); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("an older response resolving after a newer one is dropped", async () => {
  const doc = fakeDoc("visible");
  const resolvers: ((v: string) => void)[] = [];
  const got: string[] = [];
  const stop = pollWhileVisible(() => new Promise<string>((r) => resolvers.push(r)), (d) => got.push(d), () => {}, 60_000, doc as never);
  doc.hide();
  doc.show(); // second request
  resolvers[1]!("new");
  await tick();
  resolvers[0]!("old");
  await tick();
  assert.deepEqual(got, ["new"]);
  stop();
});

test("hidden: no request until shown; nothing delivered after stop", async () => {
  const doc = fakeDoc("hidden");
  let calls = 0;
  const got: number[] = [];
  const stop = pollWhileVisible(async () => ++calls, (d) => got.push(d), () => {}, 60_000, doc as never);
  assert.equal(calls, 0);
  doc.show();
  assert.equal(calls, 1);
  stop();
  await tick();
  assert.deepEqual(got, []);
});
