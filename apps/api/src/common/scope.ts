import { NotFoundException } from "@nestjs/common";
import type { DatabaseClient } from "@workfolio/database";
import { hasPermission, isTeamHeadPermission, type Permission } from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";

/**
 * Data scope of a read (W41). "all": the permission's role holds it (admins). "team": the caller heads an
 * active team and the permission is a team-head one, so only those teams' members. "own": nothing beyond
 * the caller's own records. Route access is decided by AuthGuard; this decides which rows.
 */
export type ReadScope = "all" | "team" | "own";

export function readScope(caller: AuthContext, permission: Permission): ReadScope {
  if (hasPermission(caller.role, permission)) return "all";
  return caller.teamHead && isTeamHeadPermission(permission) ? "team" : "own";
}

/** employee_profiles ids in the active teams user `?` heads. */
const TEAM_MEMBERS = "SELECT tm.employee_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.head_user_id = ? AND t.active = 1";

/**
 * SQL to append to a WHERE: restricts `column` (an employee_profiles id) to what the caller may read
 * under `permission`. Empty for "all". Uses one positional `?` (the caller's user id).
 */
export function scopeSql(caller: AuthContext, permission: Permission, column: string): { sql: string; args: string[] } {
  switch (readScope(caller, permission)) {
    case "all":
      return { sql: "", args: [] };
    case "team":
      return { sql: ` AND ${column} IN (${TEAM_MEMBERS})`, args: [caller.id] };
    default:
      return { sql: ` AND ${column} IN (SELECT id FROM employee_profiles WHERE user_id = ?)`, args: [caller.id] };
  }
}

/** Whether the employee is in the caller's scope for `permission` (admins: always, no lookup). */
export async function inScope(db: DatabaseClient, caller: AuthContext, permission: Permission, employeeId: string): Promise<boolean> {
  if (readScope(caller, permission) === "all") return true;
  const scope = scopeSql(caller, permission, "p.id");
  const { rows } = await db.execute({ sql: `SELECT 1 FROM employee_profiles p WHERE p.id = ?${scope.sql}`, args: [employeeId, ...scope.args] });
  return rows.length > 0;
}

/** Like inScope, but the caller's own profile always counts (own-record reads). */
export async function canReadEmployee(db: DatabaseClient, caller: AuthContext, permission: Permission, employeeId: string): Promise<boolean> {
  if (readScope(caller, permission) === "all") return true;
  const team = scopeSql(caller, permission, "p.id");
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM employee_profiles p WHERE p.id = ? AND (p.user_id = ? OR (1${team.sql}))`,
    args: [employeeId, caller.id, ...team.args],
  });
  return rows.length > 0;
}

/**
 * Optional team filter (`?teamId=`, docs/IMPLEMENTATION-CONTRACTS.md §4): SQL to append to a WHERE that keeps
 * `column` (an employee_profiles id) to the members of one active team. Empty when no team is given. Combine
 * with scopeSql (the caller's own scope); call assertTeamReadable first so a foreign team is a 404.
 */
export function teamFilterSql(teamId: string | null | undefined, column: string): { sql: string; args: string[] } {
  if (!teamId) return { sql: "", args: [] };
  return {
    sql: ` AND ${column} IN (SELECT tm.employee_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.id = ? AND t.active = 1)`,
    args: [teamId],
  };
}

/**
 * 404 unless the caller may filter by this team under `permission`: "all" scope (admins) any existing team;
 * "team" scope (heads) only an active team they head; "own" scope never. No-op without a team.
 */
export async function assertTeamReadable(db: DatabaseClient, caller: AuthContext, permission: Permission, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const scope = readScope(caller, permission);
  const { rows } =
    scope === "all"
      ? await db.execute({ sql: "SELECT 1 FROM teams WHERE id = ?", args: [teamId] })
      : scope === "team"
        ? await db.execute({ sql: "SELECT 1 FROM teams WHERE id = ? AND head_user_id = ? AND active = 1", args: [teamId, caller.id] })
        : { rows: [] };
  if (!rows.length) throw new NotFoundException("Team not found");
}
