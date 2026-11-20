type VisibilityDoc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Loads now and every `everyMs` while the page is visible; catches up as soon as it is shown again.
 * Only the newest request's outcome is delivered (a slow older response never overwrites a newer one),
 * and nothing is delivered after the returned stop function runs (use it as an effect cleanup).
 */
export function pollWhileVisible<T>(
  load: () => Promise<T>,
  onData: (data: T) => void,
  onError: (err: unknown) => void,
  everyMs: number,
  doc: VisibilityDoc = document,
): () => void {
  let seq = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = () => {
    const mine = ++seq;
    const current = () => !stopped && mine === seq;
    load().then((d) => current() && onData(d), (e) => current() && onError(e));
  };
  const sync = () => {
    clearInterval(timer);
    if (doc.visibilityState === "hidden") return;
    refresh();
    timer = setInterval(refresh, everyMs);
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    stopped = true;
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", sync);
  };
}
