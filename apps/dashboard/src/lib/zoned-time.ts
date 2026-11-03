/**
 * An instant as wall-clock time in `timeZone`, with the zone named, e.g.
 * "2 Nov 2026, 14:30:05 (Asia/Kolkata)". Null for an unknown zone, so callers can fall back.
 */
export function zonedTime(iso: string, timeZone: string): string | null {
  try {
    return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(iso))} (${timeZone})`;
  } catch {
    return null;
  }
}
