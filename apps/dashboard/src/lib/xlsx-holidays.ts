// Holiday import from .xlsx (W39), parsed in the browser with no library: an .xlsx file is a ZIP of
// XML parts. The result is the same "date,name" CSV the API already validates (POST /holidays/import),
// so the server stays the single source of truth. Plain string/regex XML extraction keeps this
// runnable in node for apps/dashboard/src/lib/xlsx-holidays.test.mjs.

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

/** ZIP central directory → entry name → bytes reader (STORED copied, DEFLATE inflated natively). */
// ponytail: no ZIP64 or encrypted entries; a spreadsheet of holidays is far below 4 GB.
export function readZip(b: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This is not a valid .xlsx file.");
  const entries = new Map<string, () => Promise<Uint8Array>>();
  let p = u32(b, eocd + 16);
  for (let n = u16(b, eocd + 10); n > 0; n--) {
    if (u32(b, p) !== 0x02014b50) throw new Error("This is not a valid .xlsx file.");
    const method = u16(b, p + 10), size = u32(b, p + 20), nameLen = u16(b, p + 28), local = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const data = b.slice(start, start + size);
    entries.set(name, async () => {
      if (method === 0) return data;
      if (method !== 8) throw new Error(`Unsupported compression in ${name}.`);
      const out = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(out).arrayBuffer());
    });
  }
  return entries;
}

const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!,
  );
const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
/** Text of all <t> runs (rich text included, phonetic <rPh> runs excluded). */
const runs = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join("");

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]!));
}

export type Cell = { type: "number"; value: number } | { type: "text"; value: string } | { type: "error"; value: string };

const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Rows of a worksheet as { row number, cells by column index }. */
export function parseSheet(xml: string, shared: string[]): { row: number; cells: Cell[] }[] {
  const out: { row: number; cells: Cell[] }[] = [];
  let lastRow = 0;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = Number(attr(r[1]!, "r")) || lastRow + 1;
    lastRow = row;
    const cells: Cell[] = [];
    let col = -1;
    for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1]!, "r");
      col = ref ? colIndex(ref) : col + 1;
      const t = attr(c[1]!, "t") ?? "n", body = c[2] ?? "";
      const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      if (t === "inlineStr") cells[col] = { type: "text", value: runs(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? "") };
      else if (v === undefined) continue;
      else if (t === "s") cells[col] = { type: "text", value: shared[Number(v)] ?? "" };
      else if (t === "n") cells[col] = { type: "number", value: Number(v) };
      else if (t === "e") cells[col] = { type: "error", value: unescapeXml(v) };
      else cells[col] = { type: "text", value: unescapeXml(v) }; // str (formula text), d (ISO date), b
    }
    out.push({ row, cells });
  }
  return out;
}

const ymd = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};

/** Excel serial day → YYYY-MM-DD. 1900 system keeps Lotus's fake 1900-02-29 (serial 60), which is rejected. */
export function serialToDate(serial: number, date1904 = false): string | null {
  const day = Math.floor(serial); // a time of day on the date is ignored
  if (!Number.isFinite(serial) || day < 1) return null;
  if (date1904) return new Date(Date.UTC(1904, 0, 1 + day)).toISOString().slice(0, 10);
  if (day === 60) return null;
  return new Date(Date.UTC(1899, 11, day < 60 ? 31 + day : 30 + day)).toISOString().slice(0, 10);
}

/** A cell as a date: { date } or { error } (null when the cell does not look like a date at all). */
export function cellDate(cell: Cell | undefined, date1904 = false): { date: string } | { error: string } | null {
  if (!cell) return null;
  if (cell.type === "number") {
    const date = serialToDate(cell.value, date1904);
    return date ? { date } : { error: `${cell.value} is not a valid Excel date` };
  }
  const s = cell.value.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+Z?)?$/);
  if (m) return ymdOr(Number(m[1]), Number(m[2]), Number(m[3]), s);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d <= 12 && mo <= 12 && d !== mo) return { error: `"${s}" is ambiguous (day/month or month/day?); write it as YYYY-MM-DD or use a date cell` };
  return ymdOr(Number(m[3]), mo, d, s);
}
const ymdOr = (y: number, m: number, d: number, s: string) => {
  const date = ymd(y, m, d);
  return date ? { date } : { error: `"${s}" is not a real date` };
};

const cellText = (c: Cell | undefined) => (c ? (c.type === "number" ? String(c.value) : c.value).replace(/\s+/g, " ").trim() : "");

/**
 * Worksheet rows → "date,name" CSV for POST /holidays/import, or one error per bad spreadsheet row.
 * Column A is the date, column B the name; the first row is skipped as a header when A isn't a date.
 */
export function rowsToHolidayCsv(rows: { row: number; cells: Cell[] }[], date1904 = false): { csv: string; count: number; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  rows
    .filter((r) => cellText(r.cells[0]) || cellText(r.cells[1]))
    .forEach((r, i) => {
      const parsed = cellDate(r.cells[0], date1904);
      const name = cellText(r.cells[1]);
      if (i === 0 && parsed === null) return; // header row
      if (r.cells[0]?.type === "error") return void errors.push(`Row ${r.row}: the date cell shows ${r.cells[0].value}`);
      if (!parsed) return void errors.push(`Row ${r.row}: "${cellText(r.cells[0])}" is not a date (use a date cell, YYYY-MM-DD or day/month/year)`);
      if ("error" in parsed) return void errors.push(`Row ${r.row}: ${parsed.error}`);
      if (!name || name.length > 120) return void errors.push(`Row ${r.row}: the name must be 1–120 characters`);
      if (seen.has(parsed.date)) return void errors.push(`Row ${r.row}: ${parsed.date} appears twice`);
      seen.add(parsed.date);
      lines.push(`${parsed.date},"${name.replace(/"/g, '""')}"`);
    });
  if (!lines.length && !errors.length) errors.push("The first sheet has no holidays");
  return { csv: lines.join("\n"), count: lines.length, errors };
}

/** .xlsx bytes → CSV payload (first worksheet). Throws with a user-facing message for unreadable files. */
export async function xlsxToHolidayCsv(bytes: Uint8Array): Promise<{ csv: string; count: number; errors: string[] }> {
  if (u32(bytes, 0) === 0xe011cfd0) throw new Error("This is an old .xls (Excel 97–2003) file. Save it as .xlsx or CSV and choose it again.");
  if (u32(bytes, 0) !== 0x04034b50) throw new Error("This is not a valid .xlsx file.");
  const zip = readZip(bytes);
  const text = async (name: string) => {
    const read = zip.get(name);
    return read ? new TextDecoder().decode(await read()) : null;
  };
  const workbook = await text("xl/workbook.xml");
  if (!workbook) throw new Error("This is not a valid .xlsx file (no workbook).");
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const rid = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const rels = (await text("xl/_rels/workbook.xml.rels")) ?? "";
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]!).find((a) => attr(a, "Id") === rid);
  const target = rel ? attr(rel, "Target")! : "worksheets/sheet1.xml";
  const sheet = await text(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  if (!sheet) throw new Error("The first worksheet could not be read.");
  const shared = parseSharedStrings((await text("xl/sharedStrings.xml")) ?? "");
  return rowsToHolidayCsv(parseSheet(sheet, shared), date1904);
}
