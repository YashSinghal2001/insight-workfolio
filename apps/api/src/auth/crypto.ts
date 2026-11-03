import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const argon2Async = promisify(argon2);

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/** Argon2id hash in standard PHC string format, verifiable by other Argon2 libraries. */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const hash = await argon2Async("argon2id", { message: password, nonce, ...ARGON });
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(nonce)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = PHC.exec(encoded);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, "base64");
  const actual = await argon2Async("argon2id", {
    message: password,
    nonce: Buffer.from(m[4]!, "base64"),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

/** Verified against when the user doesn't exist, so login timing doesn't reveal accounts. */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString("hex"));

/** 256-bit random, URL-safe. */
export const randomToken = () => randomBytes(32).toString("base64url");

/** High-entropy tokens only need a fast hash; passwords use Argon2id. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Fixed-window counter keyed by IP or email.
 * ponytail: in-memory, per process; move to the database or Redis if the API runs >1 instance.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Hard cap on tracked keys so many distinct IPs/emails can't grow memory without bound. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Records an attempt; returns false once the key is over its limit. */
  hit(key: string): boolean {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.delete(key); // re-inserted below, so Map order stays oldest-window-first
      if (this.hits.size >= this.maxKeys) {
        for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
        // Still full of live windows: evict the oldest. ponytail: that key's count restarts early.
        for (const k of this.hits.keys()) {
          if (this.hits.size < this.maxKeys) break;
          this.hits.delete(k);
        }
      }
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    return ++entry.count <= this.limit;
  }

  /** Whole seconds until the key's current window ends (for Retry-After); 0 when it has none. */
  retryAfter(key: string): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
