import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import type { Device, DeviceStatusResponse, RegisterDeviceInput } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { sha256 } from "../auth/crypto.js";
import { DATABASE } from "../database/database.module.js";
import { accountAudit } from "../audit/account-audit.js";

const COLUMNS = "id, device_name, platform, registered_at, last_seen_at, revoked_at";

export const toDevice = (r: Row): Device => ({
  id: String(r.id),
  deviceName: String(r.device_name),
  platform: String(r.platform),
  registeredAt: String(r.registered_at),
  lastSeenAt: r.last_seen_at === null ? null : String(r.last_seen_at),
  revokedAt: r.revoked_at === null ? null : String(r.revoked_at),
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

  /** Idempotent for the same installation. One active device per employee (MVP). */
  async register(caller: AuthContext, input: RegisterDeviceInput): Promise<Device> {
    assertDesktop(caller);
    const employeeId = await this.employeeIdFor(caller);
    const ident = sha256(input.installationId);
    const now = new Date().toISOString();
    const existing = (
      await this.db.execute({
        sql: `SELECT ${COLUMNS} FROM devices WHERE employee_id = ? AND device_identifier = ?`,
        args: [employeeId, ident],
      })
    ).rows[0];
    if (existing?.revoked_at) throw new ForbiddenException("This device was revoked by an administrator");
    if (existing) return this.touchActive(caller, employeeId, ident, now);
    const id = randomUUID();
    try {
      // The device name is user-chosen free text (may hold a person's name): kept out of the audit.
      await this.db.batch(
        [
          {
            sql: `INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [id, employeeId, input.deviceName, input.platform, ident, now],
          },
          accountAudit({
            actorUserId: caller.id,
            targetUserId: caller.id,
            action: "DEVICE_REGISTERED",
            resourceType: "DEVICE",
            resourceId: id,
            metadata: { platform: input.platform },
          }),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err, "devices.")) {
        // A concurrent registration of this same installation won the race: still idempotent.
        const mine = await this.touch(caller, employeeId, ident, now);
        if (mine) return mine;
        throw new ConflictException("Another device is already registered. Ask an administrator to revoke it first.");
      }
      throw err;
    }
    return this.touchActive(caller, employeeId, ident, now);
  }

  async status(caller: AuthContext, installationId: string | undefined): Promise<DeviceStatusResponse> {
    const employeeId = await this.employeeIdFor(caller);
    const ident = installationId ? sha256(installationId) : null;
    const { rows } = await this.db.execute({
      sql: `SELECT ${COLUMNS}, device_identifier IS ?1 AS mine FROM devices
            WHERE employee_id = ?2 AND (revoked_at IS NULL OR device_identifier IS ?1)`,
      args: [ident, employeeId],
    });
    const mine = rows.find((r) => r.mine);
    const otherActiveDevice = rows.some((r) => !r.mine && r.revoked_at === null);
    if (!mine) return { status: "NOT_REGISTERED", device: null, otherActiveDevice };
    if (mine.revoked_at !== null) return { status: "REVOKED", device: toDevice(mine), otherActiveDevice };
    return { status: "ACTIVE", device: await this.touchActive(caller, employeeId, ident!, new Date().toISOString()), otherActiveDevice };
  }

  /**
   * Validates that the installation is the caller's active device and records last-seen in the
   * same statement. Unknown and revoked devices get the same 403 shape; GET /devices/me says which.
   */
  async require(caller: AuthContext, installationId: string | undefined): Promise<DeviceContext> {
    assertDesktop(caller);
    const employeeId = await this.employeeIdFor(caller);
    const device = installationId ? await this.touch(caller, employeeId, sha256(installationId), new Date().toISOString()) : null;
    if (!device) throw new ForbiddenException("This device is not registered or has been revoked");
    return { employeeId, deviceId: device.id };
  }

  /**
   * Admin revocation. Idempotent (audited once); the device's attendance history is kept. The sessions
   * bound to the device (see touch()) are revoked in the same transaction, so its refresh and access
   * tokens stop working at once; the user's other devices and web sessions are unaffected.
   */
  async revoke(actor: AuthContext, id: string): Promise<Device> {
    const { rows: found } = await this.db.execute({
      sql: `SELECT p.user_id, (u.role = 'ADMIN' AND u.admin_title = 'SUPER_ADMIN') AS super_admin
            FROM devices d JOIN employee_profiles p ON p.id = d.employee_id JOIN users u ON u.id = p.user_id WHERE d.id = ?`,
      args: [id],
    });
    if (!found[0]) throw new NotFoundException("Device not found");
    // Same rule as account management (employees.service.ts): only a Super Admin manages a Super Admin's devices.
    if (Number(found[0].super_admin) && actor.platformRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only a Super Admin can manage a Super Admin account");
    }
    const now = new Date().toISOString();
    await this.db.batch(
      [
        { sql: "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", args: [now, id] },
        accountAudit(
          { actorUserId: actor.id, targetUserId: String(found[0].user_id), action: "DEVICE_REVOKED", resourceType: "DEVICE", resourceId: id },
          "changes() > 0",
        ),
        { sql: "UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL", args: [now, id] },
      ],
      "write",
    );
    const { rows } = await this.db.execute({ sql: `SELECT ${COLUMNS} FROM devices WHERE id = ?`, args: [id] });
    return toDevice(rows[0]!);
  }

  /** touch() for a device just seen active: revoked in the meantime gives the same 403 as require(). */
  private async touchActive(caller: AuthContext, employeeId: string, ident: string, now: string): Promise<Device> {
    const device = await this.touch(caller, employeeId, ident, now);
    if (!device) throw new ForbiddenException("This device is not registered or has been revoked");
    return device;
  }

  /**
   * Records last-seen on the caller's active device and binds the caller's session to it (first device
   * wins; a no-op when already bound or the device is not active), so revoke() can end that session.
   */
  private async touch(caller: AuthContext, employeeId: string, ident: string, now: string): Promise<Device | null> {
    const [touched] = await this.db.batch(
      [
        {
          sql: `UPDATE devices SET last_seen_at = ?
                WHERE employee_id = ? AND device_identifier = ? AND revoked_at IS NULL RETURNING ${COLUMNS}`,
          args: [now, employeeId, ident],
        },
        {
          sql: `UPDATE sessions SET device_id = (SELECT id FROM devices WHERE employee_id = ? AND device_identifier = ? AND revoked_at IS NULL)
                WHERE id = ? AND user_id = ? AND device_id IS NULL`,
          args: [employeeId, ident, caller.sessionId, caller.id],
        },
      ],
      "write",
    );
    const row = touched?.rows[0];
    return row ? toDevice(row) : null;
  }
}
