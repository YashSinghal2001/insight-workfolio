import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  type AccountStatus,
  type CreateEmployeeResponse,
  type EmployeeRef,
  type Permission,
  type Device,
  type Employee,
  type ListEmployeesQuery,
  type Paginated,
  type SetupToken,
  type UpdateEmployeeInput,
} from "@workfolio/shared";
import { accountAudit, employeeReadAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { setupTokenStatements } from "../auth/setup-token.js";
import { canReadEmployee, scopeSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { toDevice } from "../devices/devices.service.js";
import { assertCanDisable } from "../roles/roles.service.js";

// password_hash is reduced to a boolean in SQL so the hash never leaves the database.
const SELECT = `
  SELECT p.id, p.user_id, u.email, u.role, u.status, u.password_hash IS NOT NULL AS password_set,
         p.employee_code, p.full_name, p.timezone, p.employment_status, p.created_at,
         max(p.updated_at, u.updated_at) AS updated_at
  FROM employee_profiles p JOIN users u ON u.id = p.user_id`;

const toEmployee = (r: Row): Employee => ({
  id: String(r.id),
  userId: String(r.user_id),
  email: String(r.email),
  role: r.role as Employee["role"],
  accountStatus: r.status as Employee["accountStatus"],
  passwordSet: Boolean(r.password_set),
  employeeCode: String(r.employee_code),
  fullName: String(r.full_name),
  timezone: String(r.timezone),
  employmentStatus: r.employment_status as Employee["employmentStatus"],
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/**
 * Disabling `u` keeps at least one other active administrator and, when `u` is a Super Admin, one other
 * active Super Admin. Evaluated inside the write itself, so concurrent disables/demotions cannot race past it.
 */
const KEEPS_ADMINS = `(u.role <> 'ADMIN' OR (
  (SELECT count(*) FROM users o WHERE o.role = 'ADMIN' AND o.status = 'ACTIVE' AND o.id <> u.id) >= 1
  AND (u.admin_title IS NOT 'SUPER_ADMIN'
    OR (SELECT count(*) FROM users o WHERE o.role = 'ADMIN' AND o.admin_title = 'SUPER_ADMIN' AND o.status = 'ACTIVE' AND o.id <> u.id) >= 1)))`;

/** Holds while user `?` is not a Super Admin; added to writes by non-Super-Admin callers so a concurrent promotion can't slip through. */
const NOT_SUPER_ADMIN = "NOT EXISTS (SELECT 1 FROM users sa WHERE sa.id = ? AND sa.role = 'ADMIN' AND sa.admin_title = 'SUPER_ADMIN')";
const SUPER_ADMIN_ONLY = "Only a Super Admin can manage a Super Admin account";

function conflict(err: unknown): never {
  if (isUniqueViolation(err, "users.email")) throw new ConflictException("Email is already in use");
  if (isUniqueViolation(err, "employee_profiles.employee_code")) {
    throw new ConflictException("Employee code is already in use");
  }
  throw err;
}

@Injectable()
export class EmployeesService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  /** Without `caller`: every employee (internal use). With it: the caller's data scope (team heads: their teams). */
  async list({ q, page, pageSize }: ListEmployeesQuery, caller?: AuthContext, permission: Permission = "employees:read"): Promise<Paginated<Employee>> {
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const scope = caller ? scopeSql(caller, permission, "p.id") : { sql: "", args: [] };
    const where = `WHERE (?1 IS NULL OR p.full_name LIKE ?1 ESCAPE '\\' OR u.email LIKE ?1 ESCAPE '\\'
                   OR p.employee_code LIKE ?1 ESCAPE '\\')${scope.sql.replace("?", "?4")}`;
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `${SELECT} ${where} ORDER BY p.full_name COLLATE NOCASE, p.id LIMIT ?2 OFFSET ?3`,
          args: [like, pageSize, (page - 1) * pageSize, ...scope.args],
        },
        { sql: `SELECT count(*) AS n FROM employee_profiles p JOIN users u ON u.id = p.user_id ${where}`, args: [like, null, null, ...scope.args] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toEmployee), total: Number(count!.rows[0]!.n), page, pageSize };
  }

  /** Creates the account without a password and returns a one-time setup token. */
  async create(input: { email: string; fullName: string; employeeCode: string; timezone: string }, caller: AuthContext) {
    const userId = randomUUID();
    const id = randomUUID();
    const { setup, statements } = setupTokenStatements(userId, caller.id);
    try {
      // Account, profile, setup link and their audit rows commit together or not at all.
      await this.db.batch(
        [
          { sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [userId, input.email] },
          {
            sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, ?)",
            args: [id, userId, input.employeeCode, input.fullName, input.timezone],
          },
          accountAudit({ actorUserId: caller.id, targetUserId: userId, action: "ACCOUNT_CREATED", resourceType: "ACCOUNT", resourceId: userId, metadata: { employeeId: id } }),
          ...statements,
        ],
        "write",
      );
    } catch (err) {
      conflict(err);
    }
    return { employee: await this.require(id), setup } satisfies CreateEmployeeResponse;
  }

  /**
   * Admins see any employee, team heads their teams' members; everyone else only their own record. A record the caller may not
   * see is reported as 404, exactly like a missing one, so guessed IDs reveal nothing.
   */
  async getForCaller(id: string, caller: AuthContext): Promise<Employee> {
    const employee = await this.find(id);
    if (!employee || (employee.userId !== caller.id && !(await canReadEmployee(this.db, caller, "employees:read", id)))) {
      throw new NotFoundException("Employee not found");
    }
    return employee;
  }

  async devicesForCaller(id: string, caller: AuthContext): Promise<Device[]> {
    await this.getForCaller(id, caller);
    const { rows } = await this.db.execute({
      sql: `SELECT id, device_name, platform, registered_at, last_seen_at, revoked_at
            FROM devices WHERE employee_id = ? ORDER BY registered_at DESC`,
      args: [id],
    });
    return rows.map(toDevice);
  }

  async update(id: string, patch: UpdateEmployeeInput, caller: AuthContext): Promise<Employee> {
    const current = await this.require(id);
    const guard = await this.superAdminGuard(caller, current.userId);
    const now = new Date().toISOString();
    const columns = {
      fullName: "full_name",
      employeeCode: "employee_code",
      timezone: "timezone",
      employmentStatus: "employment_status",
    } as const;
    // Only fields whose value actually changes are written and named in the audit row (never values).
    const sets = Object.entries(columns).filter(([k]) => {
      const v = patch[k as keyof typeof columns];
      return v !== undefined && v !== current[k as keyof typeof columns];
    });
    const statements = [];
    if (sets.length) {
      statements.push({
        sql: `UPDATE employee_profiles SET ${sets.map(([, c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?${guard.sql}`,
        args: [...sets.map(([k]) => patch[k as keyof typeof columns]!), now, id, ...guard.args],
      });
    }
    const emailChanged = patch.email !== undefined && patch.email !== current.email;
    if (emailChanged) {
      statements.push({ sql: `UPDATE users SET email = ?, updated_at = ? WHERE id = ?${guard.sql}`, args: [patch.email!, now, current.userId, ...guard.args] });
    }
    const fields = [...sets.map(([k]) => k), ...(emailChanged ? ["email"] : [])];
    if (fields.length) {
      statements.push(accountAudit({ actorUserId: caller.id, targetUserId: current.userId, action: "ACCOUNT_UPDATED", resourceType: "ACCOUNT", resourceId: current.userId, metadata: { employeeId: id, fields: fields.join(",") } }, guard.when, { whenArgs: guard.args }));
    }
    try {
      // Every write carries the same guard, so either all apply or (target promoted meanwhile) none.
      if (statements.length && !(await this.db.batch(statements, "write"))[0]!.rowsAffected) throw new ForbiddenException(SUPER_ADMIN_ONLY);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      conflict(err);
    }
    return this.require(id);
  }

  /** Disabling an account also revokes all of its sessions immediately. */
  async setAccountStatus(id: string, status: AccountStatus, caller: AuthContext): Promise<Employee> {
    const current = await this.require(id);
    if (current.userId === caller.id) throw new BadRequestException("You cannot change your own account status");
    const guard = await this.superAdminGuard(caller, current.userId);
    if (current.accountStatus === status) return current; // nothing changes, nothing to audit
    const now = new Date().toISOString();
    const target = { actorUserId: caller.id, targetUserId: current.userId, resourceType: "ACCOUNT", resourceId: current.userId } as const;
    if (status === "ACTIVE") {
      const [enabled] = await this.db.batch(
        [
          { sql: `UPDATE users SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status <> 'ACTIVE'${guard.sql}`, args: [now, current.userId, ...guard.args] },
          accountAudit({ ...target, action: "ACCOUNT_ENABLED", metadata: { employeeId: id } }, "changes() > 0"),
        ],
        "write",
      );
      if (!enabled!.rowsAffected) await this.superAdminGuard(caller, current.userId); // 403 if promoted meanwhile
      return this.require(id);
    }
    await assertCanDisable(this.db, current.userId); // clear message; the guard below is what holds under races
    // Sessions first, then the audit row (changes() = sessions revoked), then browser-extension links,
    // then the account: all under the same in-statement condition, so either all happen or none.
    const disabling = `EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'ACTIVE' AND ${KEEPS_ADMINS})${guard.sql}`;
    const disablingArgs = [current.userId, ...guard.args];
    const [, , , disabled] = await this.db.batch(
      [
        { sql: `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${disabling}`, args: [now, current.userId, ...disablingArgs] },
        accountAudit({ ...target, action: "ACCOUNT_DISABLED", metadata: { employeeId: id } }, disabling, { whenArgs: disablingArgs, changesAs: "sessionsRevoked" }),
        { sql: `UPDATE website_extension_links SET revoked_at = ?, revoked_by = ? WHERE employee_id = ? AND revoked_at IS NULL AND ${disabling}`, args: [now, caller.id, id, ...disablingArgs] },
        { sql: `UPDATE users AS u SET status = 'DISABLED', updated_at = ? WHERE u.id = ? AND u.status = 'ACTIVE' AND ${KEEPS_ADMINS}${guard.sql}`, args: [now, current.userId, ...guard.args] },
      ],
      "write",
    );
    if (!disabled!.rowsAffected) {
      await this.superAdminGuard(caller, current.userId); // 403 if promoted meanwhile
      const fresh = await this.require(id);
      if (fresh.accountStatus === "DISABLED") return fresh; // a concurrent request disabled it first
      throw new ConflictException("This is the last active administrator or Super Admin");
    }
    return this.require(id);
  }

  /** New one-time setup link (lost link or admin-initiated password reset). */
  async reissueSetupToken(id: string, caller: AuthContext): Promise<SetupToken> {
    const { userId } = await this.require(id);
    const guard = await this.superAdminGuard(caller, userId);
    const { setup, statements } = setupTokenStatements(userId, caller.id, guard.when ? { when: guard.when, args: guard.args } : undefined);
    const [, inserted] = await this.db.batch(statements, "write");
    if (!inserted!.rowsAffected) {
      await this.superAdminGuard(caller, userId); // promoted to Super Admin meanwhile → 403
      throw new ConflictException("The setup link could not be issued; try again");
    }
    return setup;
  }

  /**
   * 403 when a non-Super-Admin caller targets a Super Admin account. Otherwise returns the in-write
   * guard (empty for Super Admin callers): `sql` to append to a WHERE, `when` for an audit row.
   */
  private async superAdminGuard(caller: AuthContext, userId: string) {
    if (caller.platformRole === "SUPER_ADMIN") return { sql: "", when: undefined, args: [] as string[] };
    const { rows } = await this.db.execute({ sql: `SELECT ${NOT_SUPER_ADMIN} AS ok`, args: [userId] });
    if (!Number(rows[0]!.ok)) throw new ForbiddenException(SUPER_ADMIN_ONLY);
    return { sql: ` AND ${NOT_SUPER_ADMIN}`, when: NOT_SUPER_ADMIN, args: [userId] };
  }

  /**
   * Whose attendance a read refers to. Without `employeeId`: the caller's own profile. With it:
   * any employee for admins (attendance:read-all), team members for team heads (W41); otherwise only
   * the caller's own, else 404.
   */
  async attendanceTarget(
    caller: AuthContext,
    employeeId?: string,
    readAll: Permission = "attendance:read-all",
  ): Promise<EmployeeRef & { userId: string }> {
    const { rows } = await this.db.execute({
      sql: `SELECT id, user_id, full_name, employee_code, timezone FROM employee_profiles WHERE ${employeeId ? "id" : "user_id"} = ?`,
      args: [employeeId ?? caller.id],
    });
    const r = rows[0];
    if (!r && !employeeId) throw new ForbiddenException("This account has no employee profile; choose an employee");
    if (!r || (employeeId && r.user_id !== caller.id && !(await canReadEmployee(this.db, caller, readAll, String(r.id))))) {
      throw new NotFoundException("Employee not found");
    }
    return {
      id: String(r.id),
      userId: String(r.user_id),
      fullName: String(r.full_name),
      employeeCode: String(r.employee_code),
      timezone: String(r.timezone),
    };
  }

  /**
   * Audits a served read of ANOTHER employee's records (admin or team head); nothing for the caller's own.
   * Call it after the data was produced, so refused or failed requests leave no row.
   */
  async auditRead(caller: AuthContext, employee: { id: string; userId: string }, action: Parameters<typeof employeeReadAudit>[2], metadata: Parameters<typeof employeeReadAudit>[3] = {}): Promise<void> {
    const audit = employeeReadAudit(caller, employee, action, metadata);
    if (audit) await this.db.execute(audit);
  }

  async findByUserId(userId: string): Promise<Employee | null> {
    const { rows } = await this.db.execute({ sql: `${SELECT} WHERE p.user_id = ?`, args: [userId] });
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  private async find(id: string): Promise<Employee | null> {
    const { rows } = await this.db.execute({ sql: `${SELECT} WHERE p.id = ?`, args: [id] });
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  private async require(id: string): Promise<Employee> {
    const employee = await this.find(id);
    if (!employee) throw new NotFoundException("Employee not found");
    return employee;
  }
}
