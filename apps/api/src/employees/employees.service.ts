import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  hasPermission,
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
import type { AuthContext } from "../auth/auth.service.js";
import { issueSetupToken } from "../auth/setup-token.js";
import { DATABASE } from "../database/database.module.js";
import { toDevice } from "../devices/devices.service.js";

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

  async list({ q, page, pageSize }: ListEmployeesQuery): Promise<Paginated<Employee>> {
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = `WHERE ?1 IS NULL OR p.full_name LIKE ?1 ESCAPE '\\' OR u.email LIKE ?1 ESCAPE '\\'
                   OR p.employee_code LIKE ?1 ESCAPE '\\'`;
    const [rows, count] = await this.db.batch(
      [
        {
          sql: `${SELECT} ${where} ORDER BY p.full_name COLLATE NOCASE, p.id LIMIT ?2 OFFSET ?3`,
          args: [like, pageSize, (page - 1) * pageSize],
        },
        { sql: `SELECT count(*) AS n FROM employee_profiles p JOIN users u ON u.id = p.user_id ${where}`, args: [like] },
      ],
      "read",
    );
    return { items: rows!.rows.map(toEmployee), total: Number(count!.rows[0]!.n), page, pageSize };
  }

  /** Creates the account without a password and returns a one-time setup token. */
  async create(input: { email: string; fullName: string; employeeCode: string; timezone: string }) {
    const userId = randomUUID();
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'EMPLOYEE')", args: [userId, input.email] },
          {
            sql: "INSERT INTO employee_profiles (id, user_id, employee_code, full_name, timezone) VALUES (?, ?, ?, ?, ?)",
            args: [id, userId, input.employeeCode, input.fullName, input.timezone],
          },
        ],
        "write",
      );
    } catch (err) {
      conflict(err);
    }
    const setup = await issueSetupToken(this.db, userId);
    return { employee: await this.require(id), setup } satisfies CreateEmployeeResponse;
  }

  /**
   * Admins see any employee; everyone else only their own record. A record the caller may not
   * see is reported as 404, exactly like a missing one, so guessed IDs reveal nothing.
   */
  async getForCaller(id: string, caller: AuthContext): Promise<Employee> {
    const employee = await this.find(id);
    if (!employee || (!hasPermission(caller.role, "employees:read") && employee.userId !== caller.id)) {
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

  async update(id: string, patch: UpdateEmployeeInput): Promise<Employee> {
    const current = await this.require(id);
    const now = new Date().toISOString();
    const columns = {
      fullName: "full_name",
      employeeCode: "employee_code",
      timezone: "timezone",
      employmentStatus: "employment_status",
    } as const;
    const sets = Object.entries(columns).filter(([k]) => patch[k as keyof typeof columns] !== undefined);
    const statements = [];
    if (sets.length) {
      statements.push({
        sql: `UPDATE employee_profiles SET ${sets.map(([, c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        args: [...sets.map(([k]) => patch[k as keyof typeof columns]!), now, id],
      });
    }
    if (patch.email !== undefined && patch.email !== current.email) {
      statements.push({ sql: "UPDATE users SET email = ?, updated_at = ? WHERE id = ?", args: [patch.email, now, current.userId] });
    }
    try {
      if (statements.length) await this.db.batch(statements, "write");
    } catch (err) {
      conflict(err);
    }
    return this.require(id);
  }

  /** Disabling an account also revokes all of its sessions immediately. */
  async setAccountStatus(id: string, status: AccountStatus, caller: AuthContext): Promise<Employee> {
    const current = await this.require(id);
    if (current.userId === caller.id) throw new BadRequestException("You cannot change your own account status");
    const now = new Date().toISOString();
    await this.db.batch(
      [
        { sql: "UPDATE users SET status = ?, updated_at = ? WHERE id = ?", args: [status, now, current.userId] },
        ...(status === "DISABLED"
          ? [{ sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", args: [now, current.userId] }]
          : []),
      ],
      "write",
    );
    return this.require(id);
  }

  /** New one-time setup link (lost link or admin-initiated password reset). */
  async reissueSetupToken(id: string): Promise<SetupToken> {
    return issueSetupToken(this.db, (await this.require(id)).userId);
  }

  /**
   * Whose attendance a read refers to. Without `employeeId`: the caller's own profile. With it:
   * any employee for admins (attendance:read-all); otherwise only the caller's own, else 404.
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
    if (!r || (employeeId && !hasPermission(caller.role, readAll) && r.user_id !== caller.id)) {
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
