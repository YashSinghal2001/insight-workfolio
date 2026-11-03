import { z } from "zod";
import type { UserRef } from "./api.js";

// ---- Holiday calendar (W38) and import (W39) -------------------------------------------------
// Organisation-wide: one holiday per local date, read in each employee's own time zone. A holiday
// is never ABSENT in the daily view and does not use leave balance.

export const holidaySchema = z.strictObject({
  date: z.iso.date(),
  name: z.string().trim().min(1).max(120),
});
export type HolidayInput = z.infer<typeof holidaySchema>;

export const listHolidaysQuerySchema = z.strictObject({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export interface Holiday {
  id: string;
  date: string;
  name: string;
  createdBy: UserRef;
  createdAt: string;
}

/** At most this many rows per import. */
export const HOLIDAY_IMPORT_MAX_ROWS = 500;
/** POST /holidays/import: the CSV text (the dashboard reads the chosen file in the browser). */
export const importHolidaysSchema = z.strictObject({ csv: z.string().max(100_000) });
export interface HolidayImportResult {
  created: number;
  /** Dates that already had a holiday (left unchanged). */
  skipped: string[];
}

/**
 * Parses "date,name" CSV (header row optional; dates YYYY-MM-DD; a name may be quoted). Returns the
 * rows, or one error per bad line ("Line 3: …"); nothing is imported when there is any error.
 */
export function parseHolidayCsv(text: string): { rows: HolidayInput[]; errors: string[] } {
  const rows: HolidayInput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || (i === 0 && /^"?date"?\s*,/i.test(line))) return;
    const comma = line.indexOf(",");
    let name = comma < 0 ? "" : line.slice(comma + 1).trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/""/g, '"');
    const parsed = holidaySchema.safeParse({ date: (comma < 0 ? line : line.slice(0, comma)).trim().replace(/^"|"$/g, ""), name });
    if (!parsed.success) errors.push(`Line ${i + 1}: expected YYYY-MM-DD,name (name 1–120 characters)`);
    else if (seen.has(parsed.data.date)) errors.push(`Line ${i + 1}: ${parsed.data.date} appears twice`);
    else {
      seen.add(parsed.data.date);
      rows.push(parsed.data);
    }
  });
  if (!rows.length && !errors.length) errors.push("The file has no holidays");
  if (rows.length > HOLIDAY_IMPORT_MAX_ROWS) errors.push(`At most ${HOLIDAY_IMPORT_MAX_ROWS} holidays per import`);
  return { rows, errors };
}
