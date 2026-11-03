// F07: the History tab's activity notes, worded for the employee (the API words them for admins).
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityNotes } from "../src/records.ts";

test("activity notes: employee wording, deduplicated; per-day gaps stay in the table", () => {
  assert.deepEqual(activityNotes([]), []);
  assert.deepEqual(activityNotes([{ code: "UNOBSERVED_TIME" }, { code: "UNOBSERVED_TIME" }]), [], "shown as the No record column instead");
  const notes = activityNotes([{ code: "NO_CONSENT" }, { code: "MONITORING_DISABLED" }, { code: "NO_CONSENT" }, { code: "STALE_SYNC" }]);
  assert.equal(notes.length, 3);
  assert.match(notes[0]!, /acknowledge the current monitoring notice on the Today tab/);
  assert.match(notes[1]!, /turned off by your organization/);
  assert.ok(notes.every((n) => !/the employee/i.test(n)), "never the admin wording");
});

test("export range: same rule as the server (order, dates, at most 92 days)", async () => {
  const { exportRangeError } = await import("../src/records.ts");
  assert.equal(exportRangeError("2026-10-01", "2026-10-31"), null);
  assert.equal(exportRangeError("2026-01-01", "2026-04-02"), null, "92 days");
  assert.match(exportRangeError("2026-01-01", "2026-04-03")!, /92 days/);
  assert.match(exportRangeError("2026-10-31", "2026-10-01")!, /after/);
  assert.equal(exportRangeError("", "2026-10-01"), "Choose a start and an end date.");
});

test("Tauri: the main window is built in setup (to register the download handler), which accepts blob: export files only", async () => {
  const { readFileSync } = await import("node:fs");
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(conf.app.windows[0].create, false);
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /WebviewWindowBuilder::from_config\(app\.handle\(\), &config\)\?\s*\.on_download/);
  assert.match(lib, /DownloadEvent::Requested \{ url, destination \} => \{\s*let ok = allowed_download\(/, "blob: export names into Downloads only (behaviour: cargo download_tests)");
});

test("export download: bearer token, refresh once on 401, shift count from the server, cancellable", async () => {
  const { ApiClient, HttpError } = await import("../src/session.ts");
  const tokens = { v: "r1" as string | null, load: async () => tokens.v, save: async (t: string) => void (tokens.v = t), clear: async () => void (tokens.v = null) };
  const urls: string[] = [];
  let expired = true;
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    if (url.endsWith("/auth/refresh")) return Response.json({ accessToken: "a2", refreshToken: "r2" });
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (url.includes("from=bad")) return Response.json({ message: "Range is limited to 92 days" }, { status: 400 });
    if (expired) {
      expired = false;
      return Response.json({ message: "expired" }, { status: 401 });
    }
    return new Response(new Uint8Array([0x50, 0x4b]), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-export-rows": "3" } });
  }) as typeof fetch;
  const client = new ApiClient("http://api", tokens, fetchFn);
  const got = await client.download("/attendance/export?from=2026-10-01&to=2026-10-07&format=xlsx");
  assert.equal(got.rows, 3);
  assert.deepEqual([...new Uint8Array(await got.blob.arrayBuffer())], [0x50, 0x4b]);
  assert.deepEqual(urls.map((u) => u.replace("http://api/api/v1", "")), ["/attendance/export?from=2026-10-01&to=2026-10-07&format=xlsx", "/auth/refresh", "/attendance/export?from=2026-10-01&to=2026-10-07&format=xlsx"]);
  await assert.rejects(client.download("/attendance/export?from=bad&to=x"), (e) => e instanceof HttpError && e.message === "Range is limited to 92 days");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.download("/attendance/export?from=2026-10-01&to=2026-10-07", cancelled.signal), (e) => (e as Error).name === "AbortError");
});
