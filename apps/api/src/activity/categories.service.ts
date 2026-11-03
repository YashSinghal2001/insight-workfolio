import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient } from "@workfolio/database";
import { categorizeForEmployee, type ApplicationCategory, type ApplicationCategoryInput, type ApplicationCategoryRule } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { iso } from "../attendance/sessions.js";
import { DATABASE } from "../database/database.module.js";

/**
 * Application productivity labels (F05). Same semantics as website category rules: removing a rule
 * ends it (kept), the category of a current rule may change, every change is audited in
 * activity_category_audit. Labels apply when reports are read (retroactive).
 */
@Injectable()
export class ActivityCategoriesService {
  private readonly logger = new Logger(ActivityCategoriesService.name);

  constructor(@Inject(DATABASE) private readonly db: DatabaseClient) {}

  async rules(): Promise<ApplicationCategoryRule[]> {
    const { rows } = await this.db.execute(
      "SELECT id, match_kind, value, category, created_at, updated_at FROM application_category_rules WHERE ended_at IS NULL ORDER BY match_kind, lower(value)",
    );
    return rows.map((r) => ({
      id: String(r.id),
      matchKind: r.match_kind as ApplicationCategoryRule["matchKind"],
      value: String(r.value),
      category: r.category as ApplicationCategoryRule["category"],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  /**
   * F05 per team: how activity of these employees is labelled. Organisation rules plus the current
   * rules of each active team the employee is in (categorizeForEmployee decides; docs/teams.md).
   * `configured`: any organisation rule, or a team rule reaching one of these employees.
   */
  async labelsFor(employeeIds: readonly string[]): Promise<{ configured: boolean; category: (employeeId: string, app: { applicationIdentifier: string | null; applicationName: string | null }) => ApplicationCategory }> {
    const [org, { rows }] = await Promise.all([
      this.rules(),
      employeeIds.length
        ? this.db.execute({
            sql: `SELECT tm.employee_id, r.team_id, r.id, r.match_kind, r.value, r.category
                  FROM team_application_category_rules r JOIN teams t ON t.id = r.team_id AND t.active = 1 JOIN team_members tm ON tm.team_id = r.team_id
                  WHERE r.ended_at IS NULL AND tm.employee_id IN (${employeeIds.map(() => "?").join(", ")})`,
            args: [...employeeIds],
          })
        : { rows: [] },
    ]);
    const byEmployee = new Map<string, Map<string, Pick<ApplicationCategoryRule, "id" | "matchKind" | "value" | "category">[]>>();
    for (const r of rows) {
      const teams = byEmployee.get(String(r.employee_id)) ?? new Map();
      const list = teams.get(String(r.team_id)) ?? [];
      list.push({ id: String(r.id), matchKind: r.match_kind as ApplicationCategoryRule["matchKind"], value: String(r.value), category: r.category as ApplicationCategoryRule["category"] });
      teams.set(String(r.team_id), list);
      byEmployee.set(String(r.employee_id), teams);
    }
    return {
      configured: org.length > 0 || rows.length > 0,
      category: (employeeId, app) => categorizeForEmployee(app, org, [...(byEmployee.get(employeeId)?.values() ?? [])]),
    };
  }

  async add(admin: AuthContext, input: ApplicationCategoryInput) {
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO application_category_rules (id, match_kind, value, category, created_by) VALUES (?, ?, ?, ?, ?)", args: [id, input.matchKind, input.value, input.category, admin.id] },
          { sql: "INSERT INTO activity_category_audit (id, actor_id, action, rule_id, details) VALUES (?, ?, 'RULE_ADDED', ?, ?)", args: [randomUUID(), admin.id, id, JSON.stringify(input)] },
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A rule for this application already exists");
      throw err;
    }
    this.logger.log({ actorId: admin.id, ruleId: id }, "Application category rule added");
    return this.rules();
  }

  async update(admin: AuthContext, id: string, category: ApplicationCategoryRule["category"]) {
    const [res] = await this.db.batch(
      [
        { sql: "UPDATE application_category_rules SET category = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL", args: [category, iso(Date.now()), id] },
        { sql: "INSERT INTO activity_category_audit (id, actor_id, action, rule_id, details) SELECT ?, ?, 'RULE_CHANGED', ?, ? WHERE changes() > 0", args: [randomUUID(), admin.id, id, JSON.stringify({ category })] },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("Rule not found");
    this.logger.log({ actorId: admin.id, ruleId: id }, "Application category rule changed");
    return this.rules();
  }

  async remove(admin: AuthContext, id: string) {
    const [res] = await this.db.batch(
      [
        { sql: "UPDATE application_category_rules SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL", args: [iso(Date.now()), admin.id, id] },
        { sql: "INSERT INTO activity_category_audit (id, actor_id, action, rule_id) SELECT ?, ?, 'RULE_REMOVED', ? WHERE changes() > 0", args: [randomUUID(), admin.id, id] },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("Rule not found");
    this.logger.log({ actorId: admin.id, ruleId: id }, "Application category rule removed");
    return this.rules();
  }
}
