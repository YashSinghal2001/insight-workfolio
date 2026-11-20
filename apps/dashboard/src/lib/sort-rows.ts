export type SortDirection = "asc" | "desc";
export type SortValue = string | number | null | undefined;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * A sorted copy of `rows` by `value(row)`. Numbers compare numerically, strings with a locale collator
 * (case-insensitive, "item 2" before "item 10"); null/undefined/NaN always sort last; ties keep their order.
 */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, direction: SortDirection = "asc"): T[] {
  const sign = direction === "asc" ? 1 : -1;
  const missing = (v: SortValue) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const am = missing(a.v), bm = missing(b.v);
      if (am || bm) return am === bm ? a.i - b.i : am ? 1 : -1;
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
      return c ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}
