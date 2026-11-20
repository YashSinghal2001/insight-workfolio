import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isUniqueViolation, type DatabaseClient, type Row } from "@workfolio/database";
import {
  type AccountStatus,
  type CreateEmployeeResponse,
  type EmployeeRef,
  type Invitation,
  type InvitationResponse,
  type Permission,
  type Device,
  type Employee,
  type ListEmployeesQuery,
  type Paginated,
  type SetupToken,
  type UpdateEmployeeInput,
  platformRoleOf,
} from "@workfolio/shared";
import { accountAudit, employeeReadAudit } from "../audit/account-audit.js";
import type { AuthContext } from "../auth/auth.service.js";
import { RateLimiter } from "../auth/crypto.js";
import { setupLink, setupTokenStatements } from "../auth/setup-token.js";
import { assertTeamReadable, canReadEmployee, readScope, scopeSql, teamFilterSql } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";
import { DEVICE_COLUMNS, toDevice } from "../devices/devices.service.js";
import type { Env } from "../config/env.js";
import { assertCanDisable } from "../roles/roles.service.js";
import { deliverInvitation, INVITATION_TRANSPORT, type InvitationTransport, invitationEmail, RESEND_COOLDOWN_MS } from "./invitations.js";

/** Desktop version of the employee's most recently checked non-revoked device: the column and the appVersion filter. */
const APP_VERSION = `(SELECT s.installed_version FROM devices d JOIN desktop_update_status s ON s.device_id = d.id
            WHERE d.employee_id = p.id AND d.revoked_at IS NULL ORDER BY s.last_check_at DESC, d.id LIMIT 1)`;

// password_hash is reduced to a boolean in SQL so the hash never leaves the database.
const SELECT = `
  SELECT p.id, p.user_id, u.email, u.role, u.admin_title, u.status, u.password_hash IS NOT NULL AS password_set,
         p.employee_code, p.full_name, p.timezone, p.employment_status, p.created_at,
         max(p.updated_at, u.updated_at) AS updated_at,
         i.id AS inv_id, i.recipient AS inv_recipient, i.provider AS inv_provider, i.status AS inv_status, i.attempts AS inv_attempts,
         i.sent_at AS inv_sent_at, i.last_error AS inv_last_error, i.created_at AS inv_created_at, t.expires_at AS inv_expires_at, t.used_at AS inv_used_at,
         (SELECT json_group_array(json_object('id', tt.id, 'name', tt.name)) FROM team_members tm JOIN teams tt ON tt.id = tm.team_id
            WHERE tm.employee_id = p.id AND tt.active = 1) AS teams_json,
         (SELECT group_concat(DISTINCT d.platform) FROM devices d WHERE d.employee_id = p.id AND d.revoked_at IS NULL) AS platforms,
         ${APP_VERSION} AS app_version
  FROM employee_profiles p JOIN users u ON u.id = p.user_id
  LEFT JOIN account_invitations i ON i.id = (SELECT id FROM account_invitations WHERE user_id = u.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  LEFT JOIN account_setup_tokens t ON t.id = i.setup_token_id`;

/** ACCEPTED once the password is set; EXPIRED once its link expired or was replaced (used_at also marks invalidation). */
function toInvitation(r: Row): Invitation | null {
  if (r.inv_id == null) return null;
  const expiresAt = String(r.inv_expires_at);
  const status: Invitation["status"] = r.password_set
    ? "ACCEPTED"
    : r.inv_used_at != null || expiresAt <= new Date().toISOString()
      ? "EXPIRED"
      : (r.inv_status as Invitation["status"]);
  return {
    id: String(r.inv_id),
    status,
    recipient: String(r.inv_recipient),
    provider: r.inv_provider as Invitation["provider"],
    attempts: Number(r.inv_attempts),
    sentAt: r.inv_sent_at == null ? null : String(r.inv_sent_at),
    lastError: r.inv_last_error == null ? null : String(r.inv_last_error),
    expiresAt,
    createdAt: String(r.inv_created_at),
  };
}

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
  invitation: toInvitation(r),
  platformRole: platformRoleOf(r.role as Employee["role"], r.admin_title as string | null),
  teams: (JSON.parse(String(r.teams_json ?? "[]")) as { id: string; name: string }[]).sort((a, b) => a.name.localeCompare(b.name)),
  platforms: r.platforms == null ? [] : String(r.platforms).split(",").sort(),
  appVersion: r.app_version == null ? null : String(r.app_version),
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
  /** Invitation emails per admin (create + resend): bounds what one account can send from the IT mailbox. */
  private readonly inviteLimiter = new RateLimiter(30, 15 * 60_000);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    @Inject(INVITATION_TRANSPORT) private readonly mail: InvitationTransport,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get inviting() {
    return this.mail.name !== "none";
  }

  private limitInvitations(caller: AuthContext) {
    if (!this.inviteLimiter.hit(caller.id)) throw new HttpException("Too many invitations from this account; try again later", HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Emails the invitation for a PENDING row and returns the response: the link only when no email went out. */
  private async invite(employeeId: string, inv: { id: string; setupTokenId: string; token: string; expiresAt: string }, caller: AuthContext): Promise<InvitationResponse> {
    const e = await this.require(employeeId);
    const sent = await deliverInvitation(this.db, this.mail, {
      id: inv.id,
      userId: e.userId,
      setupTokenId: inv.setupTokenId,
      actorUserId: caller.id,
      message: invitationEmail({
        to: e.email,
        fullName: e.fullName,
        link: setupLink(this.config.get("DASHBOARD_URL", { infer: true }), inv.token),
        expiresAt: inv.expiresAt,
        timeZone: e.timezone,
        support: this.config.get("MAIL_SENDER", { infer: true }) ?? "your IT department",
      }),
    });
    return { employee: await this.require(employeeId), ...(sent ? {} : { setup: { token: inv.token, expiresAt: inv.expiresAt } }) };
  }

  /**
   * Without `caller`: every employee (internal use). With it: the caller's data scope (team heads: their teams).
   * Optional filters (AND): team (active members; a team the caller may not read is a 404), identity, platform and
   * installed desktop version of a non-revoked device.
   */
  async list({ q, page, pageSize, teamId, role, platform, appVersion }: ListEmployeesQuery, caller?: AuthContext, permission: Permission = "employees:read"): Promise<Paginated<Employee>> {
    if (caller) await assertTeamReadable(this.db, caller, permission, teamId);
    const conditions: string[] = [];
    const args: (string | number | null)[] = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push("(p.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR p.employee_code LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    if (role === "EMPLOYEE") conditions.push("u.role = 'EMPLOYEE'");
    if (role === "ADMIN") conditions.push("u.role = 'ADMIN' AND u.admin_title IS NOT 'SUPER_ADMIN'");
    if (role === "SUPER_ADMIN") conditions.push("u.role = 'ADMIN' AND u.admin_title = 'SUPER_ADMIN'");
    if (platform) {
      conditions.push("EXISTS (SELECT 1 FROM devices d WHERE d.employee_id = p.id AND d.revoked_at IS NULL AND d.platform = ?)");
      args.push(platform);
    }
    if (appVersion) {
      conditions.push(`${APP_VERSION} = ?`);
      args.push(appVersion);
    }
    const team = teamFilterSql(teamId, "p.id");
    const scope = caller ? scopeSql(caller, permission, "p.id") : { sql: "", args: [] };
    const where = `WHERE 1${conditions.map((c) => ` AND ${c}`).join("")}${team.sql}${scope.sql}`;
    const whereArgs = [...args, ...team.args, ...scope.args];
    const [rows, count] = await this.db.batch(
      [
        { sql: `${SELECT} ${where} ORDER BY p.full_name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`, args: [...whereArgs, pageSize, (page - 1) * pageSize] },
        { sql: `SELECT count(*) AS n FROM employee_profiles p JOIN users u ON u.id = p.user_id ${where}`, args: whereArgs },
      ],
      "read",
    );
    const items = rows!.rows.map(toEmployee);
    return { items: caller ? await this.ownTeamsOnly(caller, permission, items) : items, total: Number(count!.rows[0]!.n), page, pageSize };
  }

  /** A team head ("team" scope) sees only the teams they head in `teams`, never the names of a member's other teams. */
  private async ownTeamsOnly(caller: AuthContext, permission: Permission, employees: Employee[]): Promise<Employee[]> {
    if (readScope(caller, permission) !== "team") return employees;
    const { rows } = await this.db.execute({ sql: "SELECT id FROM teams WHERE head_user_id = ? AND active = 1", args: [caller.id] });
    const headed = new Set(rows.map((t) => String(t.id)));
    return employees.map((e) => ({ ...e, teams: e.teams.filter((t) => headed.has(t.id)) }));
  }

  /**
   * Creates the account without a password. With an invitation provider, emails the one-time setup link (the
   * account is committed first: a failed email never undoes or duplicates it); otherwise returns the link.
   */
  async create(input: { email: string; fullName: string; employeeCode: string; timezone: string }, caller: AuthContext): Promise<CreateEmployeeResponse> {
    if (this.inviting) this.limitInvitations(caller);
    const userId = randomUUID();
    const id = randomUUID();
    const invitationId = randomUUID();
    const { id: setupTokenId, setup, statements } = setupTokenStatements(userId, caller.id);
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
          ...(this.inviting
            ? [{ sql: "INSERT INTO account_invitations (id, user_id, setup_token_id, recipient, provider, created_by) VALUES (?, ?, ?, ?, ?, ?)", args: [invitationId, userId, setupTokenId, input.email, this.mail.name, caller.id] }]
            : []),
        ],
        "write",
      );
    } catch (err) {
      conflict(err);
    }
    if (!this.inviting) return { employee: await this.require(id), setup };
    return this.invite(id, { id: invitationId, setupTokenId, ...setup }, caller);
  }

  /**
   * Emails a fresh invitation (new link; earlier links stop working). Only for an active account whose password
   * is not set yet, and not while another invitation to it is in flight or was sent in the last minute. Every
   * condition is checked inside the write itself, so concurrent resends cannot both go out.
   */
  async resendInvitation(id: string, caller: AuthContext): Promise<InvitationResponse> {
    const e = await this.require(id);
    if (!this.inviting) throw new ConflictException("No invitation email provider is configured; issue a setup link instead");
    if (e.passwordSet) throw new ConflictException("This account is already activated");
    if (e.accountStatus !== "ACTIVE") throw new ConflictException("This account is disabled");
    const guard = await this.superAdminGuard(caller, e.userId);
    this.limitInvitations(caller);
    const since = new Date(Date.now() - RESEND_COOLDOWN_MS).toISOString();
    const when = [
      guard.when,
      "(SELECT password_hash IS NULL AND status = 'ACTIVE' FROM users WHERE id = ?)",
      "NOT EXISTS (SELECT 1 FROM account_invitations WHERE user_id = ? AND ((status = 'PENDING' AND updated_at > ?) OR (status = 'SENT' AND sent_at > ?)))",
    ]
      .filter(Boolean)
      .join(" AND ");
    const args = [...guard.args, e.userId, e.userId, since, since];
    const invitationId = randomUUID();
    const { id: setupTokenId, setup, statements } = setupTokenStatements(e.userId, caller.id, { when, args });
    const [, inserted] = await this.db.batch(
      [
        ...statements,
        {
          sql: `INSERT INTO account_invitations (id, user_id, setup_token_id, recipient, provider, created_by) SELECT ?, ?, ?, ?, ?, ? WHERE ${when}`,
          args: [invitationId, e.userId, setupTokenId, e.email, this.mail.name, caller.id, ...args],
        },
      ],
      "write",
    );
    if (!inserted!.rowsAffected) {
      await this.superAdminGuard(caller, e.userId); // promoted to Super Admin meanwhile → 403
      throw new ConflictException("An invitation was sent moments ago, or the account changed meanwhile; refresh and try again");
    }
    return this.invite(id, { id: invitationId, setupTokenId, ...setup }, caller);
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
    return employee.userId === caller.id ? employee : (await this.ownTeamsOnly(caller, "employees:read", [employee]))[0]!;
  }

  async devicesForCaller(id: string, caller: AuthContext): Promise<Device[]> {
    await this.getForCaller(id, caller);
    const { rows } = await this.db.execute({
      sql: `SELECT ${DEVICE_COLUMNS} FROM devices d WHERE d.employee_id = ? ORDER BY d.registered_at DESC`,
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
