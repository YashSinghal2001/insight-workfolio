// Durable upload queues (attendance events, activity intervals): drain FIFO with exponential backoff.
// No Tauri imports; storage and transport are injected so node tests can drive it.
import {
  SYNC_BATCH_MAX,
  transition,
  type AttendanceCurrent,
  type AttendanceEventType,
  type AttendanceSession,
  type AttendanceState,
  type SyncResponse,
} from "@workfolio/shared";
import { HttpError, isNetworkError } from "./session.ts";

export interface QueuedEvent {
  id: string;
  userId: string;
  deviceId: string;
  type: AttendanceEventType;
  /** Device clock (UTC ISO) when the button was pressed. */
  occurredAt: string;
  status?: "PENDING" | "REJECTED";
  reason?: string | null;
}

/** Anything queued locally: PENDING until uploaded (then removed) or REJECTED (kept, visible). */
export interface Queued {
  id: string;
  status?: string | null;
  reason?: string | null;
}

/** Durable store (SQLite via Rust in the app), already scoped to one employee + device. */
export interface Queue<T extends Queued = QueuedEvent> {
  list(): Promise<T[]>;
  ack(ids: string[]): Promise<void>;
  reject(id: string, reason: string): Promise<void>;
}

/** Server answer: one result per item, in any order. */
export interface Results {
  results: { id: string; status: "ACCEPTED" | "DUPLICATE" | "REJECTED"; reason?: string }[];
}

export type Send<T, R extends Results> = (body: { sentAt: string; items: T[] }) => Promise<R>;

export type SyncPhase =
  | "idle" // nothing pending
  | "syncing"
  | "offline" // server unreachable; retry scheduled
  | "error" // server error; retry scheduled
  | "blocked"; // 401/403: signed out or device revoked; no automatic retry

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: string | null;
  error: string | null;
  /** When the next automatic retry happens (epoch ms), if scheduled. */
  retryAt: number | null;
}

export interface SyncOptions<R> {
  onStatus?: (s: SyncStatus) => void;
  onSynced?: (response: R, at: string) => void;
  /** Items per upload (server limit). */
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SyncEngine<T extends Queued = QueuedEvent, R extends Results = SyncResponse> {
  status: SyncStatus;
  private failures = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: unknown = null;
  private stopped = false;
  private readonly queue: Queue<T>;
  private readonly send: Send<T, R>;
  private readonly opts: SyncOptions<R>;

  constructor(queue: Queue<T>, send: Send<T, R>, opts: SyncOptions<R> = {}, lastSyncAt: string | null = null) {
    this.queue = queue;
    this.send = send;
    this.opts = opts;
    this.status = { phase: "idle", lastSyncAt, error: null, retryAt: null };
  }

  /** Sync now (new event, reconnection, app start). Resets the backoff. */
  kick(): Promise<void> {
    this.failures = 0;
    this.cancelTimer();
    return this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  /** At most one upload in flight; a call during one queues exactly one more pass. */
  drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    const batch = this.opts.batchSize ?? SYNC_BATCH_MAX;
    const pending = (await this.queue.list()).filter((e) => (e.status ?? "PENDING") === "PENDING").slice(0, batch);
    if (this.stopped) return;
    if (!pending.length) return this.set({ phase: "idle", error: null, retryAt: null });
    this.set({ phase: "syncing" });
    let res: R;
    try {
      // FIFO in one ordered batch; the server applies items in this order.
      res = await this.send({ sentAt: new Date(this.now()).toISOString(), items: pending });
    } catch (err) {
      return this.failed(err);
    }
    const done: string[] = [];
    for (const r of res.results) {
      if (r.status === "REJECTED") await this.queue.reject(r.id, r.reason ?? "Rejected by server");
      else done.push(r.id); // ACCEPTED or DUPLICATE (already applied earlier): safe to drop
    }
    await this.queue.ack(done);
    this.failures = 0;
    const at = new Date(this.now()).toISOString();
    this.set({ phase: "idle", lastSyncAt: at, error: null, retryAt: null });
    this.opts.onSynced?.(res, at);
    if (pending.length === batch) this.again = true; // more than one batch queued
  }

  private failed(err: unknown) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return this.set({ phase: "blocked", error: err.message, retryAt: null });
    }
    this.failures++;
    const delay = Math.min(this.opts.maxDelayMs ?? 300_000, (this.opts.baseDelayMs ?? 2_000) * 2 ** (this.failures - 1));
    this.cancelTimer();
    this.timer = (this.opts.setTimer ?? setTimeout)(() => void this.drain(), delay);
    this.set({
      phase: isNetworkError(err) ? "offline" : "error",
      error: isNetworkError(err) ? "Server unreachable" : (err as Error).message,
      retryAt: this.now() + delay,
    });
  }

  private cancelTimer() {
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.status);
  }
}

// ---- Offline preview ----------------------------------------------------------

export interface Projection {
  state: AttendanceState;
  session: AttendanceSession | null;
  /** Number of not-yet-synced events included (times from the device clock). */
  unsynced: number;
}

/**
 * Last server snapshot plus pending events, using the same state machine as the server.
 * Shown as a preview only; the server stays authoritative.
 */
export function project(current: AttendanceCurrent | null, queued: QueuedEvent[]): Projection | null {
  if (!current) return null;
  let state = current.state;
  let session = current.session && structuredClone(current.session);
  let unsynced = 0;
  for (const e of queued) {
    if ((e.status ?? "PENDING") !== "PENDING") continue;
    const next = transition(state, e.type);
    if (!next) continue; // the server will reject it; shown in the sync panel instead
    unsynced++;
    state = next;
    if (e.type === "CLOCK_IN") session = { id: e.id, clockInAt: e.occurredAt, clockOutAt: null, status: "OPEN", breaks: [], corrected: false, clockInSource: "ONLINE" };
    else if (e.type === "BREAK_START") session!.breaks.push({ id: e.id, startedAt: e.occurredAt, endedAt: null });
    else if (e.type === "BREAK_END") session!.breaks.at(-1)!.endedAt = e.occurredAt;
    else session = { ...session!, clockOutAt: e.occurredAt, status: "CLOSED" };
  }
  return { state, session, unsynced };
}
