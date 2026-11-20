/**
 * Stale-response guard for overlapping loads: each `begin()` returns an `isCurrent()` check that stays true only
 * until the next `begin()`. Apply a response only while it is current, so an older, slower request never
 * overwrites a newer one.
 */
export function latestOnly(): { begin: () => () => boolean } {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}
