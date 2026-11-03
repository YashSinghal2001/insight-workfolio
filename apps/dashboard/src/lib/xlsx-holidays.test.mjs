// Run: node --test apps/dashboard/src/lib/xlsx-holidays.test.mjs (Node strips the helper's types).
// Fixtures are minimal .xlsx files written here (ZIP with STORED or DEFLATE entries via node:zlib).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { parseHolidayCsv } from "../../../../packages/shared/src/holidays.ts";
import { cellDate, serialToDate, xlsxToHolidayCsv } from "./xlsx-holidays.ts";

/** Minimal ZIP writer: { name: xml } → bytes. */
function zip(files, deflate) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const head = (sig, size) => { const h = Buffer.alloc(size); h.writeUInt32LE(sig, 0); return h; };
    const l = head(0x04034b50, 30);
    l.writeUInt16LE(20, 4); l.writeUInt16LE(deflate ? 8 : 0, 8); l.writeUInt32LE(crc32(raw), 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = head(0x02014b50, 46);
    c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data);
    centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

/** A workbook whose first sheet (sheet "Holidays" → rId7 → worksheets/data.xml) holds `rows`. */
function xlsx(rows, { deflate = true, date1904 = false, shared = [] } = {}) {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Holidays" sheetId="1" r:id="rId7"/><sheet name="Other" sheetId="2" r:id="rId8"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId8" Target="worksheets/other.xml"/><Relationship Id="rId7" Type="ws" Target="worksheets/data.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si>${s}</si>`).join("")}</sst>`,
    "xl/worksheets/other.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/data.xml": `<worksheet><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells}</row>`).join("")}</sheetData></worksheet>`,
  }, deflate);
}

const SHARED = ["<t>Date</t>", "<t>Holiday</t>", "<r><t>Christmas</t></r><r><rPr/><t xml:space=\"preserve\"> Day, office</t></r>", "<t>Diwali &amp; \"Lights\"</t>"];
const GOOD = [
  `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`, // header (shared strings)
  `<c r="A2" s="1"><v>46381</v></c><c r="B2" t="s"><v>2</v></c>`, // serial 46381 = 2026-12-25
  `<c r="A3" t="inlineStr"><is><t>2026-01-26</t></is></c><c r="B3" t="inlineStr"><is><t>Republic Day</t></is></c>`,
  `<c r="A4" t="str"><v>15/8/2026</v></c><c r="B4" t="s"><v>3</v></c>`, // d/m/yyyy text (formula result)
];

test("serial dates: 1900 system with the Lotus leap-year bug, and the 1904 system", () => {
  assert.equal(serialToDate(1), "1900-01-01");
  assert.equal(serialToDate(59), "1900-02-28");
  assert.equal(serialToDate(60), null); // the non-existent 1900-02-29
  assert.equal(serialToDate(61), "1900-03-01");
  assert.equal(serialToDate(46381), "2026-12-25");
  assert.equal(serialToDate(46381.75), "2026-12-25");
  assert.equal(serialToDate(44919, true), "2026-12-25"); // 1904 serials are 1462 lower
  assert.equal(serialToDate(0), null);
});

test("text dates: ISO, unambiguous d/m/yyyy, and refusals", () => {
  assert.deepEqual(cellDate({ type: "text", value: "2026-03-01" }), { date: "2026-03-01" });
  assert.deepEqual(cellDate({ type: "text", value: "2026-03-01T00:00:00" }), { date: "2026-03-01" }); // t="d" cells
  assert.deepEqual(cellDate({ type: "text", value: "25/12/2026" }), { date: "2026-12-25" });
  assert.deepEqual(cellDate({ type: "text", value: "1.1.2027" }), { date: "2027-01-01" });
  assert.match(cellDate({ type: "text", value: "3/4/2026" }).error, /ambiguous/);
  assert.match(cellDate({ type: "text", value: "31/02/2026" }).error, /not a real date/);
  assert.match(cellDate({ type: "text", value: "2026-02-30" }).error, /not a real date/);
  assert.equal(cellDate({ type: "text", value: "Date" }), null);
});

for (const deflate of [true, false]) {
  test(`a ${deflate ? "DEFLATE" : "STORED"} workbook becomes the API's CSV payload`, async () => {
    const r = await xlsxToHolidayCsv(xlsx(GOOD, { deflate, shared: SHARED }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.count, 3);
    assert.equal(r.csv, ['2026-12-25,"Christmas Day, office"', '2026-01-26,"Republic Day"', '2026-08-15,"Diwali & ""Lights"""'].join("\n"));
    // The shared parser (what POST /holidays/import runs) accepts it unchanged.
    const parsed = parseHolidayCsv(r.csv);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.rows, [
      { date: "2026-12-25", name: "Christmas Day, office" },
      { date: "2026-01-26", name: "Republic Day" },
      { date: "2026-08-15", name: 'Diwali & "Lights"' },
    ]);
  });
}

test("date1904 workbooks shift serials; no header row is fine", async () => {
  const r = await xlsxToHolidayCsv(xlsx([`<c r="A1"><v>44919</v></c><c r="B1" t="inlineStr"><is><t>Xmas</t></is></c>`], { date1904: true }));
  assert.deepEqual(r, { csv: '2026-12-25,"Xmas"', count: 1, errors: [] });
});

test("bad rows are reported by spreadsheet row, nothing is returned for upload", async () => {
  const rows = [
    ...GOOD,
    `<c r="A5" t="inlineStr"><is><t>soon</t></is></c><c r="B5" t="inlineStr"><is><t>Bad date</t></is></c>`,
    `<c r="A6"><v>46381</v></c><c r="B6" t="inlineStr"><is><t>Again</t></is></c>`,
    `<c r="A7" t="inlineStr"><is><t>2/3/2026</t></is></c><c r="B7" t="inlineStr"><is><t>Ambiguous</t></is></c>`,
    `<c r="A8"><v>46400</v></c>`,
    ``,
    `<c r="A10" t="e"><v>#VALUE!</v></c><c r="B10" t="inlineStr"><is><t>Formula</t></is></c>`,
  ];
  const r = await xlsxToHolidayCsv(xlsx(rows, { shared: SHARED }));
  assert.deepEqual(r.errors, [
    'Row 5: "soon" is not a date (use a date cell, YYYY-MM-DD or day/month/year)',
    "Row 6: 2026-12-25 appears twice",
    'Row 7: "2/3/2026" is ambiguous (day/month or month/day?); write it as YYYY-MM-DD or use a date cell',
    "Row 8: the name must be 1–120 characters",
    "Row 10: the date cell shows #VALUE!",
  ]);
});

test("old .xls and non-xlsx files are refused with a clear message", async () => {
  await assert.rejects(xlsxToHolidayCsv(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /old \.xls/);
  await assert.rejects(xlsxToHolidayCsv(new TextEncoder().encode("date,name\n")), /not a valid \.xlsx/);
  await assert.rejects(xlsxToHolidayCsv(xlsx([`<c r="A1"><v>1</v></c>`]).slice(0, 200)), /not a valid \.xlsx/);
});
