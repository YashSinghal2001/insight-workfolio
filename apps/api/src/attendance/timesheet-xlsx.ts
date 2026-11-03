import type { Blob } from "node:buffer";
import type Stream from "node:stream";
import { TIMESHEET_CSV_COLUMNS, TIMESHEET_CSV_FORMAT, timesheetSummary, type Cell, type EmployeeRef } from "@workfolio/shared";
import writeExcelFile, { type CellObject, type Feature, type SheetData } from "write-excel-file/node";
import { getCellAddress, getOrderOfSiblings, getSelfClosingTagMarkup, insertElementMarkupAccordingToOrderOfSiblings } from "write-excel-file/utility";

const HEADER = { fontWeight: "bold", backgroundColor: "#E5E7EB" } as const;

/**
 * Every text cell is a String cell with the Text ("@") format: stored as a string, never as a
 * formula, so "=HYPERLINK(...)" in a name is shown, not run (unlike CSV, no apostrophe is needed).
 */
function cell(type: (typeof TIMESHEET_CSV_COLUMNS)[number]["type"], v: Cell): CellObject | null {
  if (v === null) return null; // unknown stays blank, never 0
  if (type === "number") return { value: v as number, type: Number, format: "0" };
  // A local date as an Excel date (serial number of that calendar day, no time or zone).
  if (type === "date") return { value: new Date(`${v as string}T00:00:00Z`), type: Date, format: "yyyy-mm-dd" };
  return { value: String(v), type: String, format: "@" };
}

/** Header-row filter on the first sheet (the library has frozen rows built in, not filters). */
const autoFilter = (lastRow: number, lastColumn: number): Feature<Stream | Buffer | Blob> => ({
  files: {
    transform: {
      "xl/worksheets/sheet{id}.xml": {
        transform: (xml, _options, { sheetIndex }) =>
          sheetIndex !== 0
            ? xml
            : insertElementMarkupAccordingToOrderOfSiblings(
                xml,
                getSelfClosingTagMarkup("autoFilter", { ref: `A1:${getCellAddress(lastRow, lastColumn)}` }),
                getOrderOfSiblings("xl/worksheets/sheet{id}.xml", "worksheet")!,
                "worksheet",
              ),
      },
    },
  },
});

/**
 * The draft timesheet as a native workbook: "Timesheet" (the same 16 columns and rows as the CSV)
 * and "Summary" (only exact counts and column sums). Built in memory; nothing is stored.
 */
export async function timesheetXlsx(employee: EmployeeRef, rows: Cell[][], range: { from: string; to: string }, generatedAt = new Date()): Promise<Buffer> {
  const sheet: SheetData = [
    TIMESHEET_CSV_COLUMNS.map((c) => ({ value: c.header, type: String, ...HEADER })),
    ...rows.map((r) => TIMESHEET_CSV_COLUMNS.map((c, i) => cell(c.type, r[i] ?? null))),
  ];
  const text = (v: string) => ({ value: v, type: String, format: "@" });
  const summary: SheetData = [
    ["Field", "Value", "Note"].map((v) => ({ value: v, type: String, ...HEADER })),
    [text("Format"), text(TIMESHEET_CSV_FORMAT), text("Draft: not approved for payroll or accounting")],
    [text("Employee code"), text(employee.employeeCode), null],
    [text("Employee name"), text(employee.fullName), null],
    [text("Time zone"), text(employee.timezone), text("Work dates and times are in this zone")],
    [text("Work dates from"), cell("date", range.from), text("Shifts belong to the local date of their clock-in")],
    [text("Work dates to"), cell("date", range.to), null],
    [text("Generated (UTC)"), text(generatedAt.toISOString()), null],
    ...timesheetSummary(rows).map((s) => [text(s.label), cell("number", s.value), text(s.note)]),
  ];
  return writeExcelFile(
    [
      { data: sheet, sheet: "Timesheet", columns: TIMESHEET_CSV_COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 },
      { data: summary, sheet: "Summary", columns: [{ width: 46 }, { width: 28 }, { width: 90 }], stickyRowsCount: 1 },
    ],
    { features: [autoFilter(rows.length, TIMESHEET_CSV_COLUMNS.length - 1)] },
  ).toBuffer();
}

/**
 * Organisation-wide draft timesheet: "Timesheet" (every employee's rows, the same 16 columns as the
 * per-employee file) and "Summary" (one row per employee: the same exact counts and column sums as the
 * per-employee Summary sheet, plus an "All employees" total row and the format and range below it).
 */
export async function orgTimesheetXlsx(perEmployee: { employee: EmployeeRef; rows: Cell[][] }[], range: { from: string; to: string }, generatedAt = new Date()): Promise<Buffer> {
  const rows = perEmployee.flatMap((e) => e.rows);
  const sheet: SheetData = [
    TIMESHEET_CSV_COLUMNS.map((c) => ({ value: c.header, type: String, ...HEADER })),
    ...rows.map((r) => TIMESHEET_CSV_COLUMNS.map((c, i) => cell(c.type, r[i] ?? null))),
  ];
  const text = (v: string) => ({ value: v, type: String, format: "@" });
  const labels = timesheetSummary([]).map((s) => s.label);
  const summary: SheetData = [
    ["Employee code", "Employee name", "Time zone", ...labels].map((v) => ({ value: v, type: String, ...HEADER })),
    ...perEmployee.map(({ employee, rows: mine }) => [
      text(employee.employeeCode),
      text(employee.fullName),
      text(employee.timezone),
      ...timesheetSummary(mine).map((s) => cell("number", s.value)),
    ]),
    [text("All employees"), text(`${perEmployee.length} employees`), null, ...timesheetSummary(rows).map((s) => cell("number", s.value))],
    [null],
    [text("Format"), text(TIMESHEET_CSV_FORMAT), text("Draft: not approved for payroll or accounting")],
    [text("Work dates from"), cell("date", range.from), text("Each employee's own time zone; shifts belong to the local date of their clock-in")],
    [text("Work dates to"), cell("date", range.to), null],
    [text("Generated (UTC)"), text(generatedAt.toISOString()), null],
    [text("Sums"), text("Rows are rounded down to the minute; open shifts are blank, not zero"), null],
  ];
  return writeExcelFile(
    [
      { data: sheet, sheet: "Timesheet", columns: TIMESHEET_CSV_COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 },
      { data: summary, sheet: "Summary", columns: [{ width: 16 }, { width: 28 }, { width: 22 }, ...labels.map(() => ({ width: 20 }))], stickyRowsCount: 1 },
    ],
    { features: [autoFilter(rows.length, TIMESHEET_CSV_COLUMNS.length - 1)] },
  ).toBuffer();
}
