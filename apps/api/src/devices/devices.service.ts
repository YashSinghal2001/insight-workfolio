import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import { DEVICE_ERROR, type Device, type DeviceHistoryEvent, type DeviceListItem, type DeviceStatusResponse, type RegisterDeviceInput } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { sha256 } from "../auth/crypto.js";
import { activeDeviceOf, claimDeviceSession, deviceRevoked } from "../auth/device-session.js";
import { DATABASE } from "../database/database.module.js";
import { accountAudit } from "../audit/account-audit.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Device columns plus its sign-in state, for a query over `devices d`. */
export const DEVICE_COLUMNS = `d.id, d.device_name, d.platform, d.registered_at, d.last_seen_at, d.revoked_at, d.reregistration_approved_at,
  (SELECT max(s.created_at) FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ${NOW}) AS session_started_at,
  (SELECT max(s.created_at) FROM sessions s WHERE s.device_id = d.id) AS last_login_at`;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export const toDevice = (r: Row): Device => ({
  id: String(r.id),
  deviceName: String(r.device_name),
  platform: String(r.platform),
  registeredAt: String(r.registered_at),
  lastSeenAt: str(r.last_seen_at),
  revokedAt: str(r.revoked_at),
  status: r.revoked_at !== null ? "REVOKED" : r.session_started_at !== null ? "ACTIVE" : "INACTIVE",
  sessionStartedAt: r.revoked_at !== null ? null : str(r.session_started_at),
  lastLoginAt: str(r.last_login_at),
  reregistrationApprovedAt: str(r.reregistration_approved_at),
});

/**
 * Devices are registered, and device-bound records written, only by a desktop sign-in: a browser
 * (cookie) session cannot make up an installation id and clock in or upload from the web.
 */
function assertDesktop(caller: AuthContext) {
  if (caller.client !== "DESKTOP") throw new ForbiddenException("This action is only available from the desktop app");
}

/** A device as validated for an attendance request. */
export interface DeviceContext {
  employeeId: string;
  deviceId: string;
}

/**
 * Devices are identified by a random installation UUID the app keeps in the OS credential store.
 * Only its SHA-256 is stored (the UUID has 122 random bits, so no salt/HMAC is needed) and it is
 * never returned by the API.
 *
 * Registration and sign-in are separate (migration 0031): an employee may register several devices,
 * but only one holds the account's live sign-in (see auth/device-session.ts). Every device-bound write
 * goes through require(), which accepts only the session that is that device's active sign-in.
 */
@Injectable()
export class DevicesService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  /** The caller's employee profile id. Accounts without a profile (bootstrap admins) cannot clock. */
  async employeeIdFor(caller: AuthContext): Promise<string> {
    const { rows } = await this.db.execute({ sql: "SELECT id FROM employee_profiles WHERE user_id = ?", args: [caller.id] });
    if (!rows[0]) throw new ForbiddenException("This account has no employee profile");
    return String(rows[0].id);
  }

  /**
   * Idempotent for the same installation. A new installation is recorded even while another device holds
   * the sign-in (then 409 ACTIVE_ON_ANOTHER_DEVICE: registered, not signed in). A revoked installation
   * registers again only after an admin approved it; it never inherits its old sessions.
   */
  async register(caller: AuthContext, input: RegisterDeviceInput): Promise<Device> {
    assertDesktop(caller);
    const employeeId = await this.employeeIdFor(caller);
    const ident = sha256(input.installationId);
    const now = new Date().toISOString();
    const existing = (
      await this.db.execute({ sql: "SELECT id, revoked_at, reregistration_approved_at FROM devices WHERE employee_id = ? AND device_identifier = ?", args: [employeeId, ident] })
    ).rows[0];
    // A session is the sign-in of one device only; it cannot enroll a different installation.
    if (caller.deviceId !== null && caller.deviceId !== existing?.id) throw new ForbiddenException("This sign-in belongs to another device");
    let deviceId: string;
    if (existing) {
      deviceId = String(existing.id);
      if (existing.revoked_at !== null) {
        if (existing.reregistration_approved_at === null) throw deviceRevoked();
        // The approval is consumed here: the old record (and its history) is reused, authorized again.
        await this.db.batch(
          [
            {
              sql: `UPDATE devices SET revoked_at = NULL, reregistration_approved_at = NULL, reregistration_approved_by = NULL,
                      device_name = ?, platform = ?, last_seen_at = ?
                    WHERE id = ? AND revoked_at IS NOT NULL AND reregistration_approved_at IS NOT NULL`,
              args: [input.deviceName, input.platform, now, deviceId],
            },
            accountAudit({ actorUserId: caller.id, targetUserId: caller.id, action: "DEVICE_REREGISTERED", resourceType: "DEVICE", resourceId: deviceId, metadata: { platform: input.platform } }, "changes() > 0"),
          ],
          "write",
        );
      }
    } else {
      // No silent ownership transfer: an installation still authorized for someone else stays theirs.
      const owned = await this.db.execute({ sql: "SELECT 1 FROM devices WHERE device_identifier = ? AND employee_id <> ? AND revoked_at IS NULL", args: [ident, employeeId] });
      if (owned.rows.length) {
        throw new ConflictException({
          error: "Conflict",
          message: "This computer is registered to another employee. An administrator must revoke it there first.",
          code: DEVICE_ERROR.DEVICE_OWNED_BY_ANOTHER_EMPLOYEE,
        });
      }
      deviceId = randomUUID();
      try {
        // The device name is user-chosen free text (may hold a person's name): kept out of the audit.
        await this.db.batch(
          [
            {
              sql: `INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
              args: [deviceId, employeeId, input.deviceName, input.platform, ident, now],
            },
            accountAudit({ actorUserId: caller.id, targetUserId: caller.id, action: "DEVICE_REGISTERED", resourceType: "DEVICE", resourceId: deviceId, metadata: { platform: input.platform } }),
          ],
          "write",
        );
      } catch (err) {
        if (!isUniqueViolation(err, "devices.")) throw err;
        // A concurrent registration of this same installation won the race: still idempotent.
        deviceId = String((await this.db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ? AND device_identifier = ?", args: [employeeId, ident] })).rows[0]!.id);
      }
    }
    const device = await this.byId(deviceId);
    if (device.status === "REVOKED") throw deviceRevoked(); // revoked again in the meantime
    await this.bind(caller, deviceId);
    await this.touchSeen(deviceId);
    return this.byId(deviceId);
  }

  /** Status of the calling installation. A desktop session not yet bound claims the device here (older apps). */
  async status(caller: AuthContext, installationId: string | undefined): Promise<DeviceStatusResponse> {
    const employeeId = await this.employeeIdFor(caller);
    const row = installationId
      ? (await this.db.execute({ sql: `SELECT ${DEVICE_COLUMNS} FROM devices d WHERE d.employee_id = ? AND d.device_identifier = ?`, args: [employeeId, sha256(installationId)] })).rows[0]
      : undefined;
    const state = async (status: DeviceStatusResponse["status"], device: Device | null): Promise<DeviceStatusResponse> => {
      const active = await activeDeviceOf(this.db, caller.id);
      const elsewhere = active && active.id !== device?.id ? active : null;
      return { status, device, otherActiveDevice: !!elsewhere, activeDevice: elsewhere };
    };
    if (!row) return state("NOT_REGISTERED", null);
    const device = toDevice(row);
    if (device.status === "REVOKED") return state("REVOKED", device);
    if (caller.client !== "DESKTOP") return state(device.status === "ACTIVE" ? "ACTIVE" : "INACTIVE", device); // a browser only looks
    if (caller.deviceId !== null && caller.deviceId !== device.id) return state("INACTIVE", device);
    try {
      await this.bind(caller, device.id);
    } catch (err) {
      if (err instanceof ConflictException) return state("INACTIVE", device);
      throw err;
    }
    await this.touchSeen(device.id);
    return state("ACTIVE", await this.byId(device.id));
  }

  /**
   * Validates that the installation is the caller's authorized device AND that this session is its active
   * sign-in, and records last-seen. Unknown and revoked devices get the same 403 shape; GET /devices/me
   * says which. Another device holding the sign-in is 409.
   */
  async require(caller: AuthContext, installationId: string | undefined): Promise<DeviceContext> {
    assertDesktop(caller);
    const employeeId = await this.employeeIdFor(caller);
    const row = installationId
      ? (await this.db.execute({ sql: "SELECT id FROM devices WHERE employee_id = ? AND device_identifier = ? AND revoked_at IS NULL", args: [employeeId, sha256(installationId)] })).rows[0]
      : undefined;
    if (!row) throw new ForbiddenException("This device is not registered or has been revoked");
    const deviceId = String(row.id);
    await this.bind(caller, deviceId);
    await this.touchSeen(deviceId);
    return { employeeId, deviceId };
  }

  /**
   * Admin revocation. Idempotent (audited once); the device's records are kept. The sessions bound to
   * the device are revoked in the same transaction, so its refresh and access tokens stop working at
   * once; the employee's other devices and web sessions are unaffected. Any pending re-registration
   * approval is withdrawn.
   */
  async revoke(actor: AuthContext, id: string, reason?: string): Promise<Device> {
    const owner = await this.ownerForAdmin(actor, id);
    const now = new Date().toISOString();
    await this.db.batch(
      [
        { sql: "UPDATE devices SET revoked_at = ?, reregistration_approved_at = NULL, reregistration_approved_by = NULL WHERE id = ? AND revoked_at IS NULL", args: [now, id] },
        accountAudit({ actorUserId: actor.id, targetUserId: owner, action: "DEVICE_REVOKED", resourceType: "DEVICE", resourceId: id, reason: reason ?? null }, "changes() > 0"),
        { sql: "UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL", args: [now, id] },
      ],
      "write",
    );
    return this.byId(id);
  }

  /**
   * Admin: allow a revoked device to be registered again. Nothing is reactivated here; the employee must
   * sign in on that device with their password and register it, which consumes the approval.
   */
  async allowReregistration(actor: AuthContext, id: string): Promise<Device> {
    const owner = await this.ownerForAdmin(actor, id);
    const [updated] = await this.db.batch(
      [
        {
          sql: "UPDATE devices SET reregistration_approved_at = ?, reregistration_approved_by = ? WHERE id = ? AND revoked_at IS NOT NULL AND reregistration_approved_at IS NULL",
          args: [new Date().toISOString(), actor.id, id],
        },
        accountAudit({ actorUserId: actor.id, targetUserId: owner, action: "DEVICE_REREGISTRATION_APPROVED", resourceType: "DEVICE", resourceId: id }, "changes() > 0"),
      ],
      "write",
    );
    const device = await this.byId(id);
    if (!updated?.rowsAffected && device.status !== "REVOKED") throw new ConflictException("Only a revoked device needs re-registration approval");
    return device;
  }

  /** Admin: end the device's sign-in (the device stays registered). Idempotent. */
  async endSessionAsAdmin(actor: AuthContext, id: string): Promise<Device> {
    const owner = await this.ownerForAdmin(actor, id);
    await this.endSession(actor.id, owner, id, "ADMIN");
    return this.byId(id);
  }

  /**
   * The employee signs one of their own devices out (e.g. from the dashboard when that computer is off or
   * lost), which frees the account to sign in elsewhere. Another employee's device is 404.
   */
  async endOwnSession(caller: AuthContext, id: string): Promise<Device> {
    const mine = await this.db.execute({ sql: "SELECT 1 FROM devices d JOIN employee_profiles p ON p.id = d.employee_id WHERE d.id = ? AND p.user_id = ?", args: [id, caller.id] });
    if (!mine.rows.length) throw new NotFoundException("Device not found");
    await this.endSession(caller.id, caller.id, id, "EMPLOYEE");
    return this.byId(id);
  }

  /** Every employee's devices, for the admin device overview. */
  async list(): Promise<DeviceListItem[]> {
    const { rows } = await this.db.execute(
      `SELECT ${DEVICE_COLUMNS}, p.id AS employee_id, p.full_name, p.employee_code, u.email
       FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id
       ORDER BY p.full_name, d.registered_at`,
    );
    return rows.map((r) => ({ ...toDevice(r), employeeId: String(r.employee_id), employeeName: String(r.full_name), employeeCode: String(r.employee_code), email: String(r.email) }));
  }

  /** The device's registration, revocation and sign-in history (account audit). */
  async history(id: string): Promise<DeviceHistoryEvent[]> {
    await this.byId(id);
    const { rows } = await this.db.execute({
      sql: `SELECT a.id, a.action, a.reason, a.created_at, u.email FROM account_audit a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.resource_type = 'DEVICE' AND a.resource_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      args: [id],
    });
    return rows.map((r) => ({ id: String(r.id), action: String(r.action), actorEmail: str(r.email), reason: str(r.reason), createdAt: String(r.created_at) }));
  }

  /** The caller's session becomes the device's active sign-in (no-op when it already is). */
  private async bind(caller: AuthContext, deviceId: string): Promise<void> {
    if (caller.deviceId === deviceId) return;
    if (caller.deviceId !== null) throw new ForbiddenException("This sign-in belongs to another device");
    const bound = await claimDeviceSession(this.db, {
      userId: caller.id,
      deviceId,
      sessionId: caller.sessionId,
      bind: {
        // Re-checks the device inside the transaction: a revoke committed meanwhile wins.
        sql: `UPDATE sessions SET device_id = ? WHERE id = ? AND user_id = ? AND device_id IS NULL AND revoked_at IS NULL AND expires_at > ?
                AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL)`,
        args: [deviceId, caller.sessionId, caller.id, new Date().toISOString(), deviceId],
      },
    });
    if (bound !== 1) throw new ForbiddenException("This device is not registered or has been revoked");
    caller.deviceId = deviceId;
  }

  private async endSession(actorId: string, ownerId: string, deviceId: string, by: "ADMIN" | "EMPLOYEE") {
    await this.db.batch(
      [
        { sql: "UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL", args: [new Date().toISOString(), deviceId] },
        accountAudit({ actorUserId: actorId, targetUserId: ownerId, action: "DEVICE_SESSION_ENDED", resourceType: "DEVICE", resourceId: deviceId, metadata: { cause: by === "ADMIN" ? "ENDED_BY_ADMIN" : "ENDED_BY_EMPLOYEE" } }, "changes() > 0"),
      ],
      "write",
    );
  }

  /** The device's account; only a Super Admin manages a Super Admin's devices (same rule as accounts). */
  private async ownerForAdmin(actor: AuthContext, id: string): Promise<string> {
    const { rows } = await this.db.execute({
      sql: `SELECT p.user_id, (u.role = 'ADMIN' AND u.admin_title = 'SUPER_ADMIN') AS super_admin
            FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id WHERE d.id = ?`,
      args: [id],
    });
    if (!rows[0]) throw new NotFoundException("Device not found");
    if (Number(rows[0].super_admin) && actor.platformRole !== "SUPER_ADMIN") throw new ForbiddenException("Only a Super Admin can manage a Super Admin account");
    return String(rows[0].user_id);
  }

  private async byId(id: string): Promise<Device> {
    const row = (await this.db.execute({ sql: `SELECT ${DEVICE_COLUMNS} FROM devices d WHERE d.id = ?`, args: [id] })).rows[0];
    if (!row) throw new NotFoundException("Device not found");
    return toDevice(row);
  }

  private async touchSeen(deviceId: string) {
    await this.db.execute({ sql: "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL", args: [new Date().toISOString(), deviceId] });
  }
}
