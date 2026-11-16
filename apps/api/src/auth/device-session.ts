import { ConflictException, ForbiddenException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import { DEVICE_ERROR, type ActiveDeviceSummary } from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";

/**
 * One active device sign-in per account (migration 0031). The "active login" is a live session bound to
 * a device (sessions.device_id); the unique index sessions_one_active_device_per_user makes a second one
 * impossible, so two concurrent claims cannot both succeed (the loser's transaction rolls back). Web
 * sessions are never bound and never count. State lives only in the database: API restarts change nothing.
 */

const OS_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows" };
export const osLabel = (platform: string) => OS_LABEL[platform] ?? platform;

/** The device holding the account's live sign-in, if any. */
export async function activeDeviceOf(db: DatabaseClient, userId: string): Promise<ActiveDeviceSummary | null> {
  const row = (
    await db.execute({
      sql: `SELECT d.id, d.device_name, d.platform, d.last_seen_at, s.created_at FROM sessions s JOIN devices d ON d.id = s.device_id
            WHERE s.user_id = ? AND s.device_id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ?`,
      args: [userId, new Date().toISOString()],
    })
  ).rows[0];
  if (!row) return null;
  return { id: String(row.id), deviceName: String(row.device_name), platform: String(row.platform), lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at), since: String(row.created_at) };
}

export function activeElsewhere(active: ActiveDeviceSummary | null): ConflictException {
  const where = active ? `${active.deviceName} (${osLabel(active.platform)})` : "another device";
  return new ConflictException({
    error: "Conflict",
    message: `Your account is already signed in on ${where}. Sign out on that device first, or switch to this device.`,
    code: DEVICE_ERROR.ACTIVE_ON_ANOTHER_DEVICE,
    details: { activeDevice: active },
  });
}

export const deviceRevoked = () =>
  new ForbiddenException({
    error: "Forbidden",
    message: "This device was revoked by an administrator. Ask an administrator to approve registering it again.",
    code: DEVICE_ERROR.DEVICE_REVOKED,
  });

export const rejectedAudit = (userId: string, deviceId: string, cause: string) =>
  accountAudit({ actorUserId: userId, targetUserId: userId, action: "DEVICE_SESSION_REJECTED", resourceType: "DEVICE", resourceId: deviceId, metadata: { cause } });

export interface Claim {
  userId: string;
  deviceId: string;
  /** The session that becomes the active one (being inserted, or already existing and unbound). */
  sessionId: string;
  /** Statement that binds the session to the device: the session INSERT at login, or an UPDATE. */
  bind: InStatement;
  /** Explicit, password-confirmed switch: ends the sign-in on the other device first. */
  takeover?: boolean;
}

/**
 * Makes `sessionId` the account's active device sign-in in one transaction. Ends first, in order: device
 * sessions that have expired (they no longer hold the slot), older sessions on this same device (a repeat
 * sign-in on one installation replaces itself), and, only on takeover, the session on the other device.
 * Throws 409 ACTIVE_ON_ANOTHER_DEVICE when another device still holds it. Returns rows bound (0 = the
 * session was ended in the meantime).
 */
export async function claimDeviceSession(db: DatabaseClient, c: Claim): Promise<number> {
  const now = new Date().toISOString();
  const takeover: InStatement[] = c.takeover
    ? [
        {
          sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id IS NOT NULL AND device_id <> ? AND revoked_at IS NULL",
          args: [now, c.userId, c.deviceId],
        },
        accountAudit({ actorUserId: c.userId, targetUserId: c.userId, action: "DEVICE_SESSION_TAKEOVER", resourceType: "DEVICE", resourceId: c.deviceId }, "changes() > 0", { changesAs: "count" }),
      ]
    : [];
  try {
    const results = await db.batch(
      [
        { sql: "UPDATE sessions SET revoked_at = expires_at WHERE user_id = ? AND device_id IS NOT NULL AND revoked_at IS NULL AND expires_at <= ?", args: [c.userId, now] },
        { sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL AND id <> ?", args: [now, c.userId, c.deviceId, c.sessionId] },
        ...takeover,
        c.bind,
        accountAudit({ actorUserId: c.userId, targetUserId: c.userId, action: "DEVICE_SESSION_STARTED", resourceType: "DEVICE", resourceId: c.deviceId, metadata: { sessionId: c.sessionId } }, "changes() > 0"),
      ],
      "write",
    );
    return results[results.length - 2]?.rowsAffected ?? 0;
  } catch (err) {
    if (!isUniqueViolation(err, "sessions.user_id")) throw err;
    await db.batch([rejectedAudit(c.userId, c.deviceId, DEVICE_ERROR.ACTIVE_ON_ANOTHER_DEVICE)], "write");
    throw activeElsewhere(await activeDeviceOf(db, c.userId));
  }
}
