import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type InStatement } from "@workfolio/database";
import type { EmployeeRef, Team, TeamCreateInput, TeamLabel, TeamLabelInput, TeamProductivityQuery, TeamProductivityResponse, TeamUpdateInput } from "@workfolio/shared";
import { ActivityService } from "../activity/activity.service.js";
import { iso, str } from "../attendance/sessions.js";
import type { AuthContext } from "../auth/auth.service.js";
import { readScope } from "../common/scope.js";
import { DATABASE } from "../database/database.module.js";

const SELECT = `SELECT t.id, t.name, t.active, t.created_at, t.updated_at, h.id AS head_id, h.email AS head_email, hp.full_name AS head_name
  FROM teams t LEFT JOIN users h ON h.id = t.head_user_id LEFT JOIN employee_profiles hp ON hp.user_id = h.id`;

/** W40 teams (admin) and the F05 per-team productivity view (admins: every active team; team heads: theirs). */
@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly activity: ActivityService,
  ) {}

  /** Every team (active first), with its head and members. ponytail: unpaginated; fine for tens of teams. */
  async list(): Promise<Team[]> {
    return this.load();
  }

  async create(admin: AuthContext, input: TeamCreateInput): Promise<Team> {
    await this.assertHead(input.headUserId);
    const id = randomUUID();
    try {
      await this.db.execute({ sql: "INSERT INTO teams (id, name, head_user_id, created_by) VALUES (?, ?, ?, ?)", args: [id, input.name, input.headUserId, admin.id] });
    } catch (err) {
      throw this.conflict(err, input.name);
    }
    this.logger.log({ teamId: id, actorId: admin.id, headUserId: input.headUserId }, "Team created");
    return this.require(id);
  }

  /** Rename, change or clear the head, deactivate or reactivate. A deactivated team gives its head no access. */
  async update(admin: AuthContext, id: string, patch: TeamUpdateInput): Promise<Team> {
    if (patch.headUserId !== undefined) await this.assertHead(patch.headUserId);
    const columns = { name: "name", headUserId: "head_user_id", active: "active" } as const;
    const sets = (Object.keys(columns) as (keyof typeof columns)[]).filter((k) => patch[k] !== undefined);
    const value = (k: keyof typeof columns) => (k === "active" ? (patch.active ? 1 : 0) : patch[k]!);
    try {
      const { rowsAffected } = await this.db.execute({
        sql: `UPDATE teams SET ${sets.map((k) => `${columns[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        args: [...sets.map(value), new Date().toISOString(), id],
      });
      if (!rowsAffected) throw new NotFoundException("Team not found");
    } catch (err) {
      throw this.conflict(err, patch.name);
    }
    this.logger.log({ teamId: id, actorId: admin.id, fields: sets.join(",") }, "Team updated");
    return this.require(id);
  }

  /** Replaces the member list. Employees may belong to several teams. Unknown employee ids are a 400. */
  async setMembers(admin: AuthContext, id: string, employeeIds: string[]): Promise<Team> {
    await this.require(id);
    if (employeeIds.length) {
      const { rows } = await this.db.execute({ sql: `SELECT count(*) AS n FROM employee_profiles WHERE id IN (${employeeIds.map(() => "?").join(", ")})`, args: employeeIds });
      if (Number(rows[0]!.n) !== employeeIds.length) throw new BadRequestException("Unknown employee in the member list");
    }
    const keep = employeeIds.length ? ` AND employee_id NOT IN (${employeeIds.map(() => "?").join(", ")})` : "";
    const statements: InStatement[] = [
      { sql: `DELETE FROM team_members WHERE team_id = ?${keep}`, args: [id, ...employeeIds] },
      ...employeeIds.map((e) => ({ sql: "INSERT OR IGNORE INTO team_members (team_id, employee_id, added_by) VALUES (?, ?, ?)", args: [id, e, admin.id] })),
    ];
    await this.db.batch(statements, "write");
    this.logger.log({ teamId: id, actorId: admin.id, members: employeeIds.length }, "Team members set");
    return this.require(id);
  }

  /** F05 per team: the team's current application labels (they override the organisation's for its members). */
  async labels(id: string): Promise<TeamLabel[]> {
    await this.require(id);
    const { rows } = await this.db.execute({
      sql: "SELECT id, team_id, match_kind, value, category, created_at FROM team_application_category_rules WHERE team_id = ? AND ended_at IS NULL ORDER BY match_kind, lower(value)",
      args: [id],
    });
    return rows.map((r) => ({
      id: String(r.id),
      teamId: String(r.team_id),
      matchKind: r.match_kind as TeamLabel["matchKind"],
      value: String(r.value),
      category: r.category as TeamLabel["category"],
      createdAt: String(r.created_at),
    }));
  }

  /** Sets the team's label for an application: ends the current one for the same app (if any) and adds the new one. */
  async setLabel(admin: AuthContext, id: string, input: TeamLabelInput): Promise<TeamLabel[]> {
    await this.require(id);
    const labelId = randomUUID();
    await this.db.batch(
      [
        {
          sql: "UPDATE team_application_category_rules SET ended_at = ?, ended_by = ? WHERE team_id = ? AND match_kind = ? AND lower(value) = lower(?) AND ended_at IS NULL",
          args: [iso(Date.now()), admin.id, id, input.matchKind, input.value],
        },
        { sql: "INSERT INTO team_application_category_rules (id, team_id, match_kind, value, category, created_by) VALUES (?, ?, ?, ?, ?, ?)", args: [labelId, id, input.matchKind, input.value, input.category, admin.id] },
      ],
      "write",
    ).catch((err: unknown) => {
      throw isUniqueViolation(err) ? new ConflictException("The label was changed at the same time; reload and try again") : err;
    });
    this.logger.log({ teamId: id, actorId: admin.id, labelId, ...input }, "Team application label set");
    return this.labels(id);
  }

  /** Ends the team's label (kept as history); its members fall back to the organisation label. */
  async removeLabel(admin: AuthContext, id: string, labelId: string): Promise<TeamLabel[]> {
    const { rowsAffected } = await this.db.execute({
      sql: "UPDATE team_application_category_rules SET ended_at = ?, ended_by = ? WHERE id = ? AND team_id = ? AND ended_at IS NULL",
      args: [iso(Date.now()), admin.id, labelId, id],
    });
    if (!rowsAffected) throw new NotFoundException("Team label not found");
    this.logger.log({ teamId: id, actorId: admin.id, labelId }, "Team application label removed");
    return this.labels(id);
  }

  /**
   * F05 per team: the members' activity totals (the same label scoring as /activity/overview, so each
   * member's team labels apply), summed per active team. An employee in two teams counts in both.
   */
  async productivity(caller: AuthContext, q: TeamProductivityQuery): Promise<TeamProductivityResponse> {
    const all = readScope(caller, "activity:read-all") === "all";
    const teams = (await this.load(all ? "t.active = 1" : "t.active = 1 AND t.head_user_id = ?", all ? [] : [caller.id]));
    const unique = new Map(teams.flatMap((t) => t.members.map((m) => [m.id, m] as const)));
    const { items, categoriesConfigured } = await this.activity.overview([...unique.values()], q.from, q.to);
    const byEmployee = new Map(items.map((r) => [r.employee.id, r]));
    return {
      from: q.from,
      to: q.to,
      categoriesConfigured,
      items: teams.map((t) => {
        const rows = t.members.map((m) => byEmployee.get(m.id)!);
        const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
        const clockedInMs = sum((r) => r.clockedInMs);
        const productiveMs = categoriesConfigured ? sum((r) => r.productiveMs ?? 0) : null;
        return {
          team: { id: t.id, name: t.name },
          memberCount: rows.length,
          clockedInMs,
          activeMs: sum((r) => r.activeMs),
          idleMs: sum((r) => r.idleMs),
          unobservedMs: sum((r) => r.unobservedMs),
          productiveMs,
          productiveShare: productiveMs !== null && clockedInMs > 0 ? productiveMs / clockedInMs : null,
        };
      }),
    };
  }

  private async load(where = "1", args: string[] = []): Promise<Team[]> {
    const [teams, members] = await this.db.batch(
      [
        { sql: `${SELECT} WHERE ${where} ORDER BY t.active DESC, t.name COLLATE NOCASE, t.id`, args },
        {
          sql: `SELECT tm.team_id, p.id, p.full_name, p.employee_code, p.timezone FROM team_members tm
                JOIN employee_profiles p ON p.id = tm.employee_id JOIN teams t ON t.id = tm.team_id
                WHERE ${where} ORDER BY p.full_name COLLATE NOCASE, p.id`,
          args,
        },
      ],
      "read",
    );
    const byTeam = new Map<string, EmployeeRef[]>();
    for (const m of members!.rows) {
      const list = byTeam.get(String(m.team_id)) ?? [];
      list.push({ id: String(m.id), fullName: String(m.full_name), employeeCode: String(m.employee_code), timezone: String(m.timezone) });
      byTeam.set(String(m.team_id), list);
    }
    return teams!.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      active: Boolean(r.active),
      head: r.head_id == null ? null : { id: String(r.head_id), email: String(r.head_email), fullName: str(r.head_name) },
      members: byTeam.get(String(r.id)) ?? [],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  private async require(id: string): Promise<Team> {
    const team = (await this.load("t.id = ?", [id]))[0];
    if (!team) throw new NotFoundException("Team not found");
    return team;
  }

  /** A head must be an active account. */
  private async assertHead(userId: string | null) {
    if (userId === null) return;
    const { rows } = await this.db.execute({ sql: "SELECT 1 FROM users WHERE id = ? AND status = 'ACTIVE'", args: [userId] });
    if (!rows.length) throw new BadRequestException("The team head must be an active account");
  }

  private conflict(err: unknown, name: string | undefined) {
    if (isUniqueViolation(err, "teams.name")) return new ConflictException(`A team named "${name}" already exists`);
    return err;
  }
}
