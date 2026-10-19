import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import type { Device, DeviceStatusResponse, RegisterDeviceInput } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { sha256 } from "../auth/crypto.js";
import { DATABASE } from "../database/database.module.js";

const COLUMNS = "id, device_name, platform, registered_at, last_seen_at, revoked_at";

export const toDevice = (r: Row): Device => ({
  id: String(r.id),
  deviceName: String(r.device_name),
  platform: String(r.platform),
  registeredAt: String(r.registered_at),
  lastSeenAt: r.last_seen_at === null ? null : String(r.last_seen_at),
  revokedAt: r.revoked_at === null ? null : String(r.revoked_at),
});

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
    if (existing) return this.touch(employeeId, ident, now) as Promise<Device>;
    try {
      await this.db.execute({
        sql: `INSERT INTO devices (id, employee_id, device_name, platform, device_identifier, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [randomUUID(), employeeId, input.deviceName, input.platform, ident, now],
      });
    } catch (err) {
      if (isUniqueViolation(err, "devices.employee_id")) {
        throw new ConflictException("Another device is already registered. Ask an administrator to revoke it first.");
      }
      throw err;
    }
    return (await this.touch(employeeId, ident, now))!;
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
    return { status: "ACTIVE", device: (await this.touch(employeeId, ident!, new Date().toISOString()))!, otherActiveDevice };
  }

  /**
   * Validates that the installation is the caller's active device and records last-seen in the
   * same statement. Unknown and revoked devices get the same 403 shape; GET /devices/me says which.
   */
  async require(caller: AuthContext, installationId: string | undefined): Promise<DeviceContext> {
    const employeeId = await this.employeeIdFor(caller);
    const device = installationId ? await this.touch(employeeId, sha256(installationId), new Date().toISOString()) : null;
    if (!device) throw new ForbiddenException("This device is not registered or has been revoked");
    return { employeeId, deviceId: device.id };
  }

  /** Admin revocation. Idempotent; the device's attendance history is kept. */
  async revoke(id: string): Promise<Device> {
    await this.db.execute({
      sql: "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      args: [new Date().toISOString(), id],
    });
    const { rows } = await this.db.execute({ sql: `SELECT ${COLUMNS} FROM devices WHERE id = ?`, args: [id] });
    if (!rows[0]) throw new NotFoundException("Device not found");
    return toDevice(rows[0]);
  }

  private async touch(employeeId: string, ident: string, now: string): Promise<Device | null> {
    const { rows } = await this.db.execute({
      sql: `UPDATE devices SET last_seen_at = ?
            WHERE employee_id = ? AND device_identifier = ? AND revoked_at IS NULL RETURNING ${COLUMNS}`,
      args: [now, employeeId, ident],
    });
    return rows[0] ? toDevice(rows[0]) : null;
  }
}
