import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import { platformRoleOf, roleOf, type PlatformRole, type Role, type RoleChange, type RoleUser } from "@workfolio/shared";
import { iso, str } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";
import { DATABASE } from "../database/database.module.js";

/**
 * Role identities (docs/roles.md). Super Admin and Admin share the ADMIN permission role. Safeguards:
 * nobody changes their own role (no self-lockout), only a Super Admin grants or removes the Super Admin
 * identity (no escalation), and the change never leaves zero active administrators or, once one exists,
 * zero active Super Admins (both checked inside the UPDATE itself, so concurrent changes cannot race past
 * them). Every change is recorded with who and why.
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  async users(): Promise<RoleUser[]> {
    const { rows } = await this.db.execute(
      `SELECT u.id, u.email, u.role, u.admin_title, u.status, p.id AS employee_id, p.full_name, p.employee_code
       FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id ORDER BY u.role, u.email`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.email),
      platformRole: platformRoleOf(r.role as Role, str(r.admin_title)),
      status: r.status as RoleUser["status"],
      employee: r.employee_id ? { id: String(r.employee_id), fullName: String(r.full_name), employeeCode: String(r.employee_code) } : null,
    }));
  }

  async change(actor: AuthContext, userId: string, to: PlatformRole, reason: string): Promise<RoleUser> {
    if (userId === actor.id) throw new ForbiddenException("You cannot change your own role");
    const target = (await this.users()).find((u) => u.id === userId);
    if (!target) throw new NotFoundException("User not found");
    const from = target.platformRole;
    if (from === to) throw new BadRequestException("The user already has this role");
    if ((from === "SUPER_ADMIN" || to === "SUPER_ADMIN") && actor.platformRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only a Super Admin can grant or remove the Super Admin role");
    }
    if (to === "EMPLOYEE" && !target.employee) throw new BadRequestException("This account has no employee profile, so it cannot be an employee");
    const now = iso(Date.now());
    // Guards evaluated by the database in the same statement as the change.
    const keepsAdmin = from !== "EMPLOYEE" && to === "EMPLOYEE" ? "AND (SELECT count(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ?1) >= 1" : "";
    const keepsSuper = from === "SUPER_ADMIN" ? "AND (SELECT count(*) FROM users WHERE admin_title = 'SUPER_ADMIN' AND role = 'ADMIN' AND status = 'ACTIVE' AND id <> ?1) >= 1" : "";
    const [res] = await this.db.batch(
      [
        {
          sql: `UPDATE users SET role = ?2, admin_title = ?3, updated_at = ?4 WHERE id = ?1 ${keepsAdmin} ${keepsSuper}`,
          args: [userId, roleOf(to), to === "EMPLOYEE" ? null : to, now],
        },
        {
          sql: "INSERT INTO role_changes (id, target_user_id, actor_id, from_role, to_role, reason) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0",
          args: [randomUUID(), userId, actor.id, from, to, reason],
        },
      ],
      "write",
    );
    if (!res!.rowsAffected) {
      throw new ConflictException(from === "SUPER_ADMIN" ? "This is the last active Super Admin" : "This is the last active administrator");
    }
    this.logger.log({ targetId: userId, actorId: actor.id, from, to }, "Role changed");
    return (await this.users()).find((u) => u.id === userId)!;
  }

  async history(): Promise<RoleChange[]> {
    const { rows } = await this.db.execute(
      `SELECT c.target_user_id, t.email AS target_email, c.actor_id, a.email AS actor_email, c.from_role, c.to_role, c.reason, c.created_at
       FROM role_changes c JOIN users t ON t.id = c.target_user_id LEFT JOIN users a ON a.id = c.actor_id ORDER BY c.created_at DESC, c.rowid DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      target: { id: String(r.target_user_id), email: String(r.target_email) },
      by: { id: String(r.actor_id ?? ""), email: String(r.actor_email ?? "server bootstrap") },
      from: r.from_role as PlatformRole,
      to: r.to_role as PlatformRole,
      reason: String(r.reason),
      at: String(r.created_at),
    }));
  }

}

/** Disabling an administrator's account must not leave zero active administrators (or Super Admins). */
export async function assertCanDisable(db: DatabaseClient, userId: string) {
  const r = (await db.execute({
    sql: `SELECT u.role, u.admin_title,
            (SELECT count(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ?1) AS admins,
            (SELECT count(*) FROM users WHERE role = 'ADMIN' AND admin_title = 'SUPER_ADMIN' AND status = 'ACTIVE' AND id <> ?1) AS supers
          FROM users u WHERE u.id = ?1`,
    args: [userId],
  })).rows[0];
  if (!r || r.role !== "ADMIN") return;
  if (Number(r.admins) < 1) throw new ConflictException("This is the last active administrator");
  if (r.admin_title === "SUPER_ADMIN" && Number(r.supers) < 1) throw new ConflictException("This is the last active Super Admin");
}
