// SSR tests for the employee panel (W3-EMPLOYEE). No per-file hooks: the shared loader resolves next/link.
import assert from "node:assert/strict";
import { test } from "node:test";
import Link from "next/link";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttendanceCurrent, AttendanceSession, MissingClockOutsResponse } from "@workfolio/shared";
import { EmptyState, PageHeader } from "@/components/kit";
import { CalendarGrid } from "@/app/my/_components/attendance-calendar";
import { MissingClockOutBanner } from "@/app/my/_components/missing-clock-out-banner";
import { MissingList } from "@/app/my/_components/team-attendance";
import { calendarMonth } from "@/app/my/_lib/attendance";

test("loader: a component using the kit and next/link renders on the server", () => {
  const html = renderToStaticMarkup(
    <>
      <PageHeader title="Kit page" />
      <EmptyState title="Nothing yet" />
      <Link href="/my/attendance">Go</Link>
    </>,
  );
  assert.match(html, /Kit page/);
  assert.match(html, /<a href="\/my\/attendance">Go<\/a>/);
});

const open = { id: "s1", clockInAt: "2026-11-19T03:30:00.000Z", clockOutAt: null, status: "OPEN", breaks: [] } as unknown as AttendanceSession;
const cur = (serverTime: string, state: AttendanceCurrent["state"] = "CLOCKED_IN"): AttendanceCurrent => ({ state, session: open, serverTime, missingClockOut: false });
const action = <Link href="/my/attendance?correct=missing-clock-out#request-correction">Request a correction</Link>;

test("banner: local date/time of the clock-in and the correction action; nothing when current", () => {
  const html = renderToStaticMarkup(<MissingClockOutBanner current={cur("2026-11-20T04:00:00.000Z")} tz="Asia/Kolkata" action={action} />);
  assert.match(html, /You are still clocked in since 19 Nov 2026, 09:00/);
  assert.match(html, /data-testid="missing-clock-out-banner"/);
  assert.match(html, /href="\/my\/attendance\?correct=missing-clock-out#request-correction"/);
  assert.equal(renderToStaticMarkup(<MissingClockOutBanner current={cur("2026-11-19T06:00:00.000Z")} tz="Asia/Kolkata" action={action} />), "");
  assert.equal(renderToStaticMarkup(<MissingClockOutBanner current={cur("2026-11-25T06:00:00.000Z", "CLOCKED_OUT")} tz="Asia/Kolkata" action={action} />), "");
});

test("calendar grid: table semantics, weekday headers, text label per day, today marked", () => {
  const weeks = calendarMonth({
    month: "2026-11",
    timeZone: "UTC",
    timesheet: { days: [{ date: "2026-11-02", firstClockIn: "2026-11-02T09:30:00.000Z", netMs: 27_000_000, incomplete: false } as never] },
    expected: { days: [{ date: "2026-11-02", startAt: "2026-11-02T09:00:00.000Z", dueAt: "2026-11-02T09:15:00.000Z" }] },
    leave: [],
    now: Date.parse("2026-11-20T12:00:00.000Z"),
  });
  const html = renderToStaticMarkup(<CalendarGrid month="2026-11" weeks={weeks} />);
  assert.match(html, /<table[^>]*data-testid="my-attendance-calendar"/);
  assert.match(html, /<caption[^>]*>November 2026: /);
  assert.equal((html.match(/<th scope="col"/g) ?? []).length, 7);
  assert.match(html, /<span class="sr-only">2026-11-02, Late, late by 30 min, worked 7h 30m<\/span>/);
  assert.match(html, /aria-current="date"/);
});

test("team missing clock-outs: reasons as text, pending correction, empty state", () => {
  const data: MissingClockOutsResponse = {
    generatedAt: "2026-11-20T12:00:00.000Z",
    thresholds: { workdayMinutes: 480, workdayGraceMinutes: 120, maxShiftMinutes: 840, staleDeviceMinutes: 30, longBreakMinutes: 120 },
    items: [{
      employee: { id: "e1", fullName: "Ana <b>", employeeCode: "E1", timezone: "UTC" }, accountStatus: "ACTIVE", employmentStatus: "ACTIVE",
      sessionId: "s1", clockInAt: "2026-11-19T09:00:00.000Z", clockInLocal: "2026-11-19T09:00", openForMinutes: 1620,
      lastDeviceSeenAt: null, openBreakSince: null, reasons: ["PREVIOUS_DAY", "MAX_SHIFT_EXCEEDED"], pendingCorrectionId: "c1",
    }],
  };
  const html = renderToStaticMarkup(<MissingList data={data} />);
  assert.match(html, /Ana &lt;b&gt;/);
  assert.match(html, /From an earlier day/);
  assert.match(html, /Very long shift/);
  assert.match(html, /Pending review/);
  assert.match(renderToStaticMarkup(<MissingList data={{ ...data, items: [] }} />), /No missing clock-outs/);
});
