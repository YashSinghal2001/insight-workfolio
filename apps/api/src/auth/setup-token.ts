import { randomUUID } from "node:crypto";
import type { InStatement } from "@workfolio/database";
import type { SetupToken } from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import { randomToken, sha256 } from "./crypto.js";

export const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * A new one-time setup token as statements (invalidate earlier unused ones, store the sha256 hash only),
 * with its SETUP_LINK_ISSUED audit row, so the caller commits link, change and audit in one batch.
 * `guard` (SQL condition + its args) is checked inside every statement: nothing is written unless it holds.
 */
export function setupTokenStatements(userId: string, actorUserId: string | null, guard?: { when: string; args: string[] }) {
  const token = randomToken();
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString();
  const statements: InStatement[] = [
    { sql: `UPDATE account_setup_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL${guard ? ` AND ${guard.when}` : ""}`, args: [now.toISOString(), userId, ...(guard?.args ?? [])] },
    { sql: `INSERT INTO account_setup_tokens (id, user_id, token_hash, expires_at) SELECT ?, ?, ?, ?${guard ? ` WHERE ${guard.when}` : ""}`, args: [id, userId, sha256(token), expiresAt, ...(guard?.args ?? [])] },
    accountAudit({ actorUserId, targetUserId: userId, action: "SETUP_LINK_ISSUED", resourceType: "SETUP_LINK", resourceId: id, metadata: { expiresAt } }, guard?.when, { whenArgs: guard?.args }),
  ];
  return { id, setup: { token, expiresAt } satisfies SetupToken, statements };
}

export const setupLink = (dashboardUrl: string, token: string) =>
  // Fragment, not query string: never sent to servers, so it can't land in access logs.
  `${dashboardUrl.replace(/\/$/, "")}/setup-password#token=${token}`;
