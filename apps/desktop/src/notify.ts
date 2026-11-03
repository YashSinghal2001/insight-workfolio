// OS notifications for state changes only: a condition notifies once when it starts and stays quiet
// until it has cleared. No Tauri imports, so node tests can drive it; main.ts injects the sender.

/** `on`: true = condition holds, false = recovered, null = unknown right now (state unchanged). */
export type Notify = (key: string, on: boolean | null, title: string, body: string) => boolean;

/** Edge-triggered sender. Returns true when it sent. Send failures are logged, never thrown. */
export function edgeNotifier(send: (title: string, body: string) => Promise<unknown>): Notify {
  const active = new Set<string>();
  return (key, on, title, body) => {
    if (on === null) return false;
    if (!on) return (active.delete(key), false);
    if (active.has(key)) return false;
    active.add(key);
    send(title, body).catch((err) => console.warn("notification failed", err));
    return true;
  };
}

/**
 * Whether screenshot uploads are failing after an upload pass. Offline ("Server unreachable") is
 * already shown as OFFLINE and is not an upload problem: unknown. A pass that did nothing because
 * attendance is still syncing tells nothing either: unknown. Nothing failed otherwise: recovered.
 */
export function uploadsFailing(failed: string | null, attendancePending: boolean): boolean | null {
  if (failed === "Server unreachable") return null;
  if (failed) return true;
  return attendancePending ? null : false;
}
