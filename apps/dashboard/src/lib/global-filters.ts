import { addDays, localDate } from "@workfolio/shared";

/** Global page filters carried in the URL: `?date=YYYY-MM-DD&team=<uuid>`. */
export interface GlobalFilterValues {
  date: string;
  teamId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
export function isLocalDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return addDays(value, 0) === value;
  } catch {
    return false;
  }
}

/** Today in the viewer's own time zone. */
export function todayLocal(now: number = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return localDate(now, timeZone);
}

/**
 * Reads the filters; invalid values are ignored: a bad date means today, a non-uuid team (or one missing from
 * `knownTeamIds`, when the list is known) means all teams (null).
 */
export function parseGlobalFilters(params: URLSearchParams, today: string, knownTeamIds?: readonly string[]): GlobalFilterValues {
  const date = params.get("date");
  const team = params.get("team")?.toLowerCase() ?? null;
  const teamOk = !!team && UUID.test(team) && (!knownTeamIds || knownTeamIds.some((id) => id.toLowerCase() === team));
  return { date: isLocalDate(date) ? date : today, teamId: teamOk ? team : null };
}

/** The query string for `next`, keeping unrelated params; defaults (today, all teams) are left out of the URL. */
export function serialiseGlobalFilters(params: URLSearchParams, next: GlobalFilterValues, today: string): string {
  const out = new URLSearchParams(params);
  if (isLocalDate(next.date) && next.date !== today) out.set("date", next.date);
  else out.delete("date");
  if (next.teamId && UUID.test(next.teamId)) out.set("team", next.teamId);
  else out.delete("team");
  const s = out.toString();
  return s ? `?${s}` : "";
}
