// Pure shaping for the Reports pages and the timesheet week grid (W2-REPORTS). No React, no fetch: unit-tested in node.
import {
  addDays,
  formatDuration,
  MONTHLY_STATUS_CODES,
  type Cell,
  type DailyAttendanceRow,
  type DailyAttendanceStatus,
  type EmployeeRef,
  type MonthlyAttendanceDay,
  type MonthlyAttendanceRow,
  type Paginated,
} from "@workfolio/shared";

/** Whole minutes as "7h 05m" (the timesheet's format). */
export const hm = (minutes: number) => formatDuration(minutes * 60_000);

/** Every page of a paginated read (pageSize ≤ 100), stopping at `maxPages`. */
export async function fetchAllPages<T>(get: (page: number) => Promise<Paginated<T>>, maxPages = 50): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await get(page);
    items.push(...r.items);
    if (!r.items.length || items.length >= r.total) break;
  }
  return items;
}

// ---- Daily attendance -------------------------------------------------------------------

export const DAILY_TABS = [
  { id: "worked", label: "Worked" },
  { id: "late", label: "Late" },
  { id: "leave", label: "On leave" },
  { id: "absent", label: "Absent" },
] as const;
export type DailyTab = (typeof DAILY_TABS)[number]["id"];

export interface DailyReportRow {
  employee: EmployeeRef;
  date: string;
  status: DailyAttendanceStatus;
  /** Local HH:MM. Clock-out and worked minutes come from the monthly read; null when unknown (open shift or not loaded). */
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
}

const inTab: Record<DailyTab, (r: DailyReportRow) => boolean> = {
  worked: (r) => r.clockIn !== null,
  late: (r) => r.status === "LATE",
  leave: (r) => r.status === "ON_LEAVE",
  absent: (r) => r.status === "ABSENT",
};
export const dailyTabRows = (rows: DailyReportRow[], tab: DailyTab) => rows.filter(inTab[tab]);
export const dailyTabCounts = (rows: DailyReportRow[]) =>
  Object.fromEntries(DAILY_TABS.map((t) => [t.id, dailyTabRows(rows, t.id).length])) as Record<DailyTab, number>;

/** /attendance/daily rows, with that day's clock-out and worked minutes from /attendance/monthly when available. */
export function dailyReportRows(daily: DailyAttendanceRow[], monthly: MonthlyAttendanceRow[] | null): DailyReportRow[] {
  const days = new Map(monthly?.map((m) => [m.employee.id, m.days]) ?? []);
  return daily.map((d) => {
    const m = days.get(d.employee.id)?.find((x) => x.date === d.date);
    return {
      employee: d.employee,
      date: d.date,
      status: d.status,
      clockIn: d.firstClockInLocal?.slice(11, 16) ?? null,
      clockOut: m?.lastOutLocal ?? null,
      workedMinutes: m && m.status !== "OPEN" ? m.workedMinutes : null,
      lateMinutes: d.lateMinutes,
    };
  });
}

export const DAILY_EXPORT_HEADER = ["Employee code", "Employee name", "Time zone", "Date", "Status", "Clock in", "Clock out", "Worked minutes", "Late minutes"];
export const dailyExportCells = (rows: DailyReportRow[]): Cell[][] =>
  rows.map((r) => [r.employee.employeeCode, r.employee.fullName, r.employee.timezone, r.date, r.status, r.clockIn, r.clockOut, r.workedMinutes, r.lateMinutes]);

// ---- Monthly in/out and overtime ------------------------------------------------------------

/** "09:00–17:30" (an open shift ends with "–"), or the export's day code (A, LV, H, WO, …). */
export const inOutCell = (d: MonthlyAttendanceDay) =>
  d.firstInLocal ? `${d.firstInLocal}–${d.lastOutLocal ?? ""}` : (MONTHLY_STATUS_CODES[d.status as DailyAttendanceStatus] ?? "—");

/** Worked = days with a clock-in; non-worked = scheduled days without one (absent + leave); late = late days. */
export const inOutCounts = (r: MonthlyAttendanceRow) => ({ worked: r.totals.workedDays, nonWorked: r.totals.absentDays + r.totals.leaveDays, late: r.totals.lateDays });

export const overtimeSummary = (r: MonthlyAttendanceRow) => ({ days: r.days.filter((d) => d.overtimeMinutes > 0).length, minutes: r.totals.overtimeMinutes });

// ---- Timesheet week grid -------------------------------------------------------------------

export const weekDates = (from: string) => Array.from({ length: 7 }, (_, i) => addDays(from, i));
/** The months (YYYY-MM) a 7-day week touches: one or two monthly reads. */
export const weekMonths = (from: string) => [...new Set(weekDates(from).map((d) => d.slice(0, 7)))];

export interface WeekGridRow {
  employee: EmployeeRef;
  /** One per date; null when the employee is not listed for that month. */
  cells: (MonthlyAttendanceDay | null)[];
  totals: { workedDays: number; workMinutes: number; breakMinutes: number };
}

/** Nothing worked on a scheduled day: tinted red (with a text label, never colour alone). */
export const missedDay = (d: MonthlyAttendanceDay | null) => d?.status === "ABSENT";

/**
 * Merges the monthly reads of a week into employee × 7-day rows. Employees keep the order of the last month's
 * read (it lists everyone who existed by the end of the week), then any listed only earlier.
 */
export function weekGrid(months: MonthlyAttendanceRow[][], from: string): WeekGridRow[] {
  const dates = weekDates(from);
  const byEmployee = new Map<string, { employee: EmployeeRef; days: Map<string, MonthlyAttendanceDay> }>();
  for (const rows of [...months].reverse())
    for (const r of rows) {
      const e = byEmployee.get(r.employee.id) ?? { employee: r.employee, days: new Map() };
      for (const d of r.days) if (d.date >= dates[0]! && d.date <= dates[6]!) e.days.set(d.date, d);
      byEmployee.set(r.employee.id, e);
    }
  return [...byEmployee.values()].map(({ employee, days }) => {
    const cells = dates.map((d) => days.get(d) ?? null);
    const done = cells.filter((c): c is MonthlyAttendanceDay => !!c);
    return {
      employee,
      cells,
      totals: {
        workedDays: done.filter((c) => c.firstInLocal).length,
        workMinutes: done.reduce((a, c) => a + c.workedMinutes, 0),
        breakMinutes: done.reduce((a, c) => a + c.breakMinutes, 0),
      },
    };
  });
}

// ---- Minimal XLSX writer ----------------------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** ZIP with STORED entries (no compression; report files are small). */
// ponytail: no ZIP64; a browser-built report stays far below 4 GB.
function zip(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const header = (size: number, sig: number) => {
      const h = new DataView(new ArrayBuffer(size));
      h.setUint32(0, sig, true);
      return h;
    };
    const local = header(30, 0x04034b50);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    const dir = header(46, 0x02014b50);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, n.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(dir.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const col = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : col(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/**
 * One-sheet workbook. Text is an inline string (never a formula, so "=HYPERLINK(…)" is shown as typed), numbers are
 * numbers, null is a blank cell. The first row is the header.
 */
export function xlsxBytes(sheet: string, rows: Cell[][]): Uint8Array {
  const body = rows
    .map((r, y) => `<row r="${y + 1}">${r.map((v, x) => (v === null ? "" : typeof v === "number" ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`)).join("")}</row>`)
    .join("");
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = "http://schemas.openxmlformats.org";
  return zip([
    ["[Content_Types].xml", `${xml}<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `${xml}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${xml}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${xml}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `${xml}<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
  ]);
}
