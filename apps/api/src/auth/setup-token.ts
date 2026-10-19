import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "@workfolio/database";
import type { SetupToken } from "@workfolio/shared";
import { randomToken, sha256 } from "./crypto.js";

export const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Issues a one-time password-setup token and invalidates any earlier unused ones.
 * Only the hash is stored; the plaintext is returned once for out-of-band delivery.
 */
export async function issueSetupToken(db: DatabaseClient, userId: string): Promise<SetupToken> {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString();
  await db.batch(
    [
      {
        sql: "UPDATE account_setup_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
        args: [now.toISOString(), userId],
      },
      {
        sql: "INSERT INTO account_setup_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        args: [randomUUID(), userId, sha256(token), expiresAt],
      },
    ],
    "write",
  );
  return { token, expiresAt };
}

export const setupLink = (dashboardUrl: string, token: string) =>
  // Fragment, not query string: never sent to servers, so it can't land in access logs.
  `${dashboardUrl.replace(/\/$/, "")}/setup-password#token=${token}`;
