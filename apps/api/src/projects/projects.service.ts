import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isUniqueViolation, type DatabaseClient, type InStatement, type Row } from "@workfolio/database";
import {
  addDays,
  attendanceEnd,
  localDate,
  zonedToUtc,
  type EmployeeRef,
  type Project,
  type ProjectHistoryItem,
  type ProjectStatus,
  type ProjectTask,
  type ProjectTimeSummary,
  type TaskStatus,
  type TimeEndReason,
  type TimeEntry,
  type TimerState,
} from "@workfolio/shared";
import type { AuthContext } from "../auth/auth.service.js";
import { EmployeeLocks } from "../common/employee-locks.js";
import { DATABASE } from "../database/database.module.js";
import { EmployeesService } from "../employees/employees.service.js";
import { iso, str } from "../attendance/sessions.js";
import { TimesheetService } from "../attendance/timesheet.service.js";

const ENTRY = `
  SELECT e.id, e.started_at, e.ended_at, e.end_reason, e.employee_id, p.full_name, p.employee_code, p.timezone,
         e.project_id, j.code AS project_code, j.name AS project_name, e.task_id, t.title AS task_title
  FROM task_time_entries e
  JOIN employee_profiles p ON p.id = e.employee_id
  JOIN projects j ON j.id = e.project_id
  JOIN project_tasks t ON t.id = e.task_id`;

const employeeOf = (r: Row, prefix = ""): EmployeeRef => ({
  id: String(r[`${prefix}employee_id`]),
  fullName: String(r.full_name),
  employeeCode: String(r.employee_code),
  timezone: String(r.timezone),
});

const toEntry = (r: Row): TimeEntry => ({
  id: String(r.id),
  employee: employeeOf(r),
  project: { id: String(r.project_id), code: String(r.project_code), name: String(r.project_name) },
  task: { id: String(r.task_id), title: String(r.task_title) },
  startedAt: String(r.started_at),
  endedAt: str(r.ended_at),
  endReason: (r.end_reason as TimeEndReason | null) ?? null,
  durationMs: r.ended_at ? Date.parse(String(r.ended_at)) - Date.parse(String(r.started_at)) : null,
});

/**
 * Projects, tasks and task timers (F11). Separate from attendance: nothing here writes attendance
 * tables. Timer times are server times. A timer needs an open shift with no break running, and is
 * ended at the first recorded break or clock-out (applied whenever timers are read or changed), so
 * break and attendance code stay untouched. Defaults pending approval: docs/project-time.md.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseClient,
    private readonly employees: EmployeesService,
    private readonly timesheets: TimesheetService,
    private readonly locks: EmployeeLocks,
  ) {}

  // ---- Admin: projects, tasks, assignments --------------------------------------------------

  async list(): Promise<Project[]> {
    const [projects, tasks, members] = await this.db.batch(
      [
        "SELECT id, code, name, description, status, created_at FROM projects ORDER BY status, code",
        "SELECT id, project_id, title, status FROM project_tasks ORDER BY status DESC, created_at, id",
        `SELECT m.project_id, m.employee_id, m.assigned_at, p.full_name, p.employee_code, p.timezone FROM project_members m
         JOIN employee_profiles p ON p.id = m.employee_id WHERE m.removed_at IS NULL ORDER BY p.full_name`,
      ],
      "read",
    );
    return projects!.rows.map((r) => ({
      ...this.toProject(r, tasks!.rows),
      members: members!.rows.filter((m) => m.project_id === r.id).map((m) => ({ ...employeeOf(m), assignedAt: String(m.assigned_at) })),
    }));
  }

  async create(caller: AuthContext, input: { code: string; name: string; description: string | null }): Promise<Project> {
    const id = randomUUID();
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO projects (id, code, name, description, created_by) VALUES (?, ?, ?, ?, ?)", args: [id, input.code, input.name, input.description, caller.id] },
          this.audit(id, caller, "PROJECT_CREATED", input),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err, "projects.code")) throw new ConflictException("A project with this code already exists");
      throw err;
    }
    return this.project(id);
  }

  async update(caller: AuthContext, id: string, input: { name?: string; description?: string | null; status?: ProjectStatus }): Promise<Project> {
    await this.project(id);
    const sets = Object.entries({ name: input.name, description: input.description, status: input.status }).filter(([, v]) => v !== undefined);
    await this.db.batch(
      [
        { sql: `UPDATE projects SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, args: [...sets.map(([, v]) => v ?? null), iso(Date.now()), id] },
        this.audit(id, caller, input.status === "ARCHIVED" ? "PROJECT_ARCHIVED" : input.status === "ACTIVE" ? "PROJECT_RESTORED" : "PROJECT_UPDATED", Object.fromEntries(sets)),
      ],
      "write",
    );
    return this.project(id);
  }

  async assign(caller: AuthContext, projectId: string, employeeId: string): Promise<Project> {
    await this.project(projectId);
    const employee = await this.employees.attendanceTarget(caller, employeeId, "projects:manage"); // 404 if unknown
    try {
      await this.db.batch(
        [
          { sql: "INSERT INTO project_members (id, project_id, employee_id, assigned_by) VALUES (?, ?, ?, ?)", args: [randomUUID(), projectId, employee.id, caller.id] },
          this.audit(projectId, caller, "EMPLOYEE_ASSIGNED", { employeeId: employee.id, employeeCode: employee.employeeCode }),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("This employee is already assigned to the project");
      throw err;
    }
    return this.withMembers(projectId);
  }

  /** Ends the assignment (kept in history). A running timer is not stopped; new ones are refused. */
  async unassign(caller: AuthContext, projectId: string, employeeId: string): Promise<Project> {
    await this.project(projectId);
    const now = iso(Date.now());
    const [res] = await this.db.batch(
      [
        { sql: "UPDATE project_members SET removed_by = ?, removed_at = ? WHERE project_id = ? AND employee_id = ? AND removed_at IS NULL", args: [caller.id, now, projectId, employeeId] },
        { sql: "INSERT INTO project_audit (id, project_id, actor_id, action, details) SELECT ?, ?, ?, 'EMPLOYEE_UNASSIGNED', ? WHERE changes() > 0", args: [randomUUID(), projectId, caller.id, JSON.stringify({ employeeId })] },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("This employee is not assigned to the project");
    return this.withMembers(projectId);
  }

  async createTask(caller: AuthContext, projectId: string, title: string): Promise<Project> {
    await this.project(projectId);
    const id = randomUUID();
    await this.db.batch(
      [
        { sql: "INSERT INTO project_tasks (id, project_id, title, created_by) VALUES (?, ?, ?, ?)", args: [id, projectId, title, caller.id] },
        this.audit(projectId, caller, "TASK_CREATED", { taskId: id, title }),
      ],
      "write",
    );
    return this.withMembers(projectId);
  }

  async updateTask(caller: AuthContext, projectId: string, taskId: string, input: { title?: string; status?: TaskStatus }): Promise<Project> {
    // Fixed column names (never request body keys) in the SET clause.
    const sets = Object.entries({ title: input.title, status: input.status }).filter(([, v]) => v !== undefined);
    const [res] = await this.db.batch(
      [
        { sql: `UPDATE project_tasks SET ${sets.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND project_id = ?`, args: [...sets.map(([, v]) => v!), iso(Date.now()), taskId, projectId] },
        {
          sql: "INSERT INTO project_audit (id, project_id, actor_id, action, details) SELECT ?, ?, ?, ?, ? WHERE changes() > 0",
          args: [randomUUID(), projectId, caller.id, input.status === "CLOSED" ? "TASK_CLOSED" : input.status === "OPEN" ? "TASK_REOPENED" : "TASK_UPDATED", JSON.stringify({ taskId, ...Object.fromEntries(sets) })],
        },
      ],
      "write",
    );
    if (!res!.rowsAffected) throw new NotFoundException("Task not found in this project");
    return this.withMembers(projectId);
  }

  async history(projectId: string): Promise<ProjectHistoryItem[]> {
    await this.project(projectId);
    const { rows } = await this.db.execute({
      // The latest 500 changes, oldest first.
      sql: `SELECT * FROM (SELECT a.action, a.created_at, a.actor_id, u.email, a.details, a.rowid AS seq FROM project_audit a JOIN users u ON u.id = a.actor_id
            WHERE a.project_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 500) ORDER BY created_at, seq`,
      args: [projectId],
    });
    return rows.map((r) => ({ action: String(r.action), at: String(r.created_at), by: { id: String(r.actor_id), email: String(r.email) }, details: JSON.parse(String(r.details)) }));
  }

  /** Completed task time by project, task and employee, beside attendance worked time (a separate measure). */
  async summary(from: string, to: string, employeeId?: string): Promise<ProjectTimeSummary> {
    await this.closeEnded(employeeId ?? null);
    const entries = (await this.db.execute({
      sql: `${ENTRY} WHERE e.ended_at IS NOT NULL AND e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at`,
      args: [`${addDays(from, -1)}T00:00:00.000Z`, `${addDays(to, 2)}T00:00:00.000Z`], // widened for every zone; exact local dates below
    })).rows.map(toEntry).filter((e) => {
      const d = localDate(e.startedAt, e.employee.timezone);
      return d >= from && d <= to && (!employeeId || e.employee.id === employeeId);
    });
    const statuses = new Map((await this.db.execute("SELECT id, status FROM projects")).rows.map((r) => [String(r.id), r.status as ProjectStatus]));
    const projects = new Map<string, ProjectTimeSummary["byProject"][number]>();
    const people = new Map<string, ProjectTimeSummary["byEmployee"][number]>();
    for (const e of entries) {
      const p = projects.get(e.project.id) ?? { project: { ...e.project, status: statuses.get(e.project.id)! }, taskMs: 0, entries: 0, byTask: [] };
      const t = p.byTask.find((x) => x.task.id === e.task.id) ?? p.byTask[p.byTask.push({ task: e.task, taskMs: 0, entries: 0 }) - 1]!;
      const who = people.get(e.employee.id) ?? { employee: e.employee, taskMs: 0, entries: 0, attendanceNetMs: 0 };
      for (const x of [p, t, who]) {
        x.taskMs += e.durationMs!;
        x.entries++;
      }
      projects.set(e.project.id, p);
      people.set(e.employee.id, who);
    }
    for (const who of people.values()) who.attendanceNetMs = (await this.timesheets.forEmployee(who.employee, from, to)).totals.netMs;
    const running = Number((await this.db.execute({ sql: "SELECT count(*) AS n FROM task_time_entries WHERE ended_at IS NULL AND (?1 IS NULL OR employee_id = ?1)", args: [employeeId ?? null] })).rows[0]!.n);
    return {
      from,
      to,
      byProject: [...projects.values()].sort((a, b) => a.project.code.localeCompare(b.project.code)),
      byEmployee: [...people.values()].sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName)),
      running,
    };
  }

  // ---- Employee: assignments and timers -------------------------------------------------------

  /** Active projects the caller is assigned to, with their open tasks. */
  async assignments(caller: AuthContext): Promise<Project[]> {
    const employee = await this.employees.attendanceTarget(caller);
    const [projects, tasks] = await this.db.batch(
      [
        {
          sql: `SELECT j.id, j.code, j.name, j.description, j.status, j.created_at FROM projects j
                JOIN project_members m ON m.project_id = j.id AND m.employee_id = ? AND m.removed_at IS NULL
                WHERE j.status = 'ACTIVE' ORDER BY j.code`,
          args: [employee.id],
        },
        {
          sql: `SELECT t.id, t.project_id, t.title, t.status FROM project_tasks t
                JOIN project_members m ON m.project_id = t.project_id AND m.employee_id = ? AND m.removed_at IS NULL
                WHERE t.status = 'OPEN' ORDER BY t.created_at, t.id`,
          args: [employee.id],
        },
      ],
      "read",
    );
    return projects!.rows.map((r) => this.toProject(r, tasks!.rows));
  }

  async state(caller: AuthContext): Promise<TimerState> {
    const employee = await this.employees.attendanceTarget(caller);
    await this.closeEnded(employee.id);
    const [latest, shift] = await this.db.batch(
      [
        { sql: `${ENTRY} WHERE e.employee_id = ? ORDER BY e.started_at DESC, e.created_at DESC LIMIT 1`, args: [employee.id] },
        {
          sql: `SELECT s.id, EXISTS (SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL) AS on_break
                FROM attendance_sessions s WHERE s.employee_id = ? AND s.clock_out_at IS NULL`,
          args: [employee.id],
        },
      ],
      "read",
    );
    const last = latest!.rows[0] ? toEntry(latest!.rows[0]) : null;
    const resumable = last?.endReason === "PAUSED" && (await this.startable(employee.id, last.task.id)) === null;
    return {
      running: last && !last.endedAt ? last : null,
      paused: resumable ? last : null,
      attendance: { clockedIn: !!shift!.rows[0], onBreak: !!shift!.rows[0]?.on_break },
      serverTime: iso(Date.now()),
    };
  }

  /**
   * Starts a timer at the server's time. Starting the task that is already running returns it
   * (a repeated tap or retry); any other running timer must be paused or stopped first.
   */
  async start(caller: AuthContext, taskId: string): Promise<TimeEntry> {
    const employee = await this.employees.attendanceTarget(caller);
    return this.locks.run(employee.id, async () => {
      await this.closeEnded(employee.id);
      const problem = await this.startable(employee.id, taskId);
      if (problem === "missing") throw new NotFoundException("Task not found");
      if (problem) throw new ConflictException(problem);
      const running = await this.running(employee.id);
      if (running) {
        if (running.task.id === taskId) return running;
        throw new ConflictException(`A timer is already running for ${running.project.code} · ${running.task.title}; pause or stop it first`);
      }
      const id = randomUUID();
      // One statement: the open shift without a running break, the current assignment, the active
      // project and the open task are checked as the row is written, so a break, clock-out, unassign,
      // archive or task close recorded at the same moment (e.g. by another API instance) cannot slip in.
      const insert = () =>
        this.db.execute({
          sql: `INSERT INTO task_time_entries (id, employee_id, project_id, task_id, attendance_session_id, started_at)
                SELECT ?1, ?2, t.project_id, t.id, s.id, ?3 FROM project_tasks t
                JOIN projects j ON j.id = t.project_id AND j.status = 'ACTIVE'
                JOIN project_members m ON m.project_id = t.project_id AND m.employee_id = ?2 AND m.removed_at IS NULL
                JOIN attendance_sessions s ON s.employee_id = ?2 AND s.clock_out_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM break_sessions b WHERE b.attendance_session_id = s.id AND b.ended_at IS NULL)
                WHERE t.id = ?4 AND t.status = 'OPEN'`,
          args: [id, employee.id, iso(Date.now()), taskId],
        });
      try {
        if (!(await insert()).rowsAffected) {
          // Changed since the check above: report the real reason.
          const now = await this.startable(employee.id, taskId);
          if (now === "missing") throw new NotFoundException("Task not found");
          throw new ConflictException(now ?? "Clock in (and end any break) before starting a task timer");
        }
      } catch (err) {
        // Another API instance started one at the same moment: the database allows one running timer.
        if (!isUniqueViolation(err)) throw err;
        const other = await this.running(employee.id);
        if (other?.task.id === taskId) return other; // the same start, sent twice
        throw new ConflictException("A timer is already running; refresh and try again");
      }
      this.logger.log({ entryId: id, employeeId: employee.id, taskId }, "Task timer started");
      return this.entry(id);
    });
  }

  /** Pause or stop the given timer (by id, so a late duplicate cannot end a newer one). */
  async end(caller: AuthContext, entryId: string, reason: "PAUSED" | "STOPPED"): Promise<TimeEntry> {
    const employee = await this.employees.attendanceTarget(caller);
    return this.locks.run(employee.id, async () => {
      await this.closeEnded(employee.id);
      const entry = await this.entry(entryId, employee.id);
      const ended = (e: TimeEntry) => new ConflictException(`This timer already ended (${e.endReason!.toLowerCase().replace("_", "-")})`);
      if (entry.endedAt) throw ended(entry);
      const res = await this.db.execute({
        sql: "UPDATE task_time_entries SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
        args: [iso(Date.now()), reason, entryId],
      });
      // Ended in between (another API instance, or a break/clock-out): report that, not success.
      if (!res.rowsAffected) throw ended(await this.entry(entryId));
      this.logger.log({ entryId, employeeId: employee.id, reason }, "Task timer ended");
      return this.entry(entryId);
    });
  }

  /** Entries that started on local dates [from, to] (employee's zone): own, or any employee for admins. */
  async entries(caller: AuthContext, from: string, to: string, employeeId?: string): Promise<TimeEntry[]> {
    const employee = await this.employees.attendanceTarget(caller, employeeId, "projects:manage");
    await this.closeEnded(employee.id);
    const { rows } = await this.db.execute({
      sql: `${ENTRY} WHERE e.employee_id = ? AND e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at DESC`,
      args: [employee.id, zonedToUtc(`${from}T00:00`, employee.timezone), zonedToUtc(`${addDays(to, 1)}T00:00`, employee.timezone)],
    });
    return rows.map(toEntry);
  }

  // ---- internals ---------------------------------------------------------------------------------

  private toProject(r: Row, tasks: Row[]): Project {
    return {
      id: String(r.id),
      code: String(r.code),
      name: String(r.name),
      description: str(r.description),
      status: r.status as ProjectStatus,
      createdAt: String(r.created_at),
      tasks: tasks.filter((t) => t.project_id === r.id).map((t): ProjectTask => ({ id: String(t.id), projectId: String(t.project_id), title: String(t.title), status: t.status as TaskStatus })),
    };
  }

  private async project(id: string): Promise<Project> {
    const [p, tasks] = await this.db.batch(
      [
        { sql: "SELECT id, code, name, description, status, created_at FROM projects WHERE id = ?", args: [id] },
        { sql: "SELECT id, project_id, title, status FROM project_tasks WHERE project_id = ? ORDER BY status DESC, created_at, id", args: [id] },
      ],
      "read",
    );
    if (!p!.rows[0]) throw new NotFoundException("Project not found");
    return this.toProject(p!.rows[0], tasks!.rows);
  }

  private async withMembers(id: string): Promise<Project> {
    return (await this.list()).find((p) => p.id === id)!;
  }

  private audit(projectId: string, caller: AuthContext, action: string, details: object): InStatement {
    return { sql: "INSERT INTO project_audit (id, project_id, actor_id, action, details) VALUES (?, ?, ?, ?, ?)", args: [randomUUID(), projectId, caller.id, action, JSON.stringify(details)] };
  }

  /** Null when the employee may log time on the task now; otherwise why not ("missing" = 404). */
  private async startable(employeeId: string, taskId: string): Promise<string | null> {
    const { rows } = await this.db.execute({
      sql: `SELECT t.status AS task_status, j.status AS project_status FROM project_tasks t JOIN projects j ON j.id = t.project_id
            JOIN project_members m ON m.project_id = j.id AND m.employee_id = ? AND m.removed_at IS NULL WHERE t.id = ?`,
      args: [employeeId, taskId],
    });
    const r = rows[0];
    if (!r) return "missing"; // unknown task, or a project the employee is not assigned to: not revealed
    if (r.project_status !== "ACTIVE") return "This project is archived";
    if (r.task_status !== "OPEN") return "This task is closed";
    return null;
  }

  private async running(employeeId: string): Promise<TimeEntry | null> {
    const { rows } = await this.db.execute({ sql: `${ENTRY} WHERE e.employee_id = ? AND e.ended_at IS NULL`, args: [employeeId] });
    return rows[0] ? toEntry(rows[0]) : null;
  }

  private async entry(id: string, employeeId?: string): Promise<TimeEntry> {
    const { rows } = await this.db.execute({ sql: `${ENTRY} WHERE e.id = ? AND (?2 IS NULL OR e.employee_id = ?2)`, args: [id, employeeId ?? null] });
    if (!rows[0]) throw new NotFoundException("Timer entry not found");
    return toEntry(rows[0]);
  }

  /**
   * Ends running timers whose shift has since had a break or a clock-out (including ones synced
   * later from offline), at that recorded time. Reads attendance; never writes it.
   */
  private async closeEnded(employeeId: string | null): Promise<void> {
    const { rows } = await this.db.execute({
      sql: `SELECT e.id, e.started_at, s.clock_out_at,
              (SELECT min(b.started_at) FROM break_sessions b
                WHERE b.attendance_session_id = e.attendance_session_id AND coalesce(b.ended_at, '9999') > e.started_at) AS break_at
            FROM task_time_entries e JOIN attendance_sessions s ON s.id = e.attendance_session_id
            WHERE e.ended_at IS NULL AND (?1 IS NULL OR e.employee_id = ?1)`,
      args: [employeeId],
    });
    for (const r of rows) {
      const end = attendanceEnd(String(r.started_at), { clockOutAt: str(r.clock_out_at), breaks: r.break_at ? [{ startedAt: String(r.break_at), endedAt: null }] : [] });
      if (!end) continue;
      await this.db.execute({ sql: "UPDATE task_time_entries SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", args: [end.at, end.reason, String(r.id)] });
      this.logger.log({ entryId: String(r.id), reason: end.reason }, "Task timer ended by attendance");
    }
  }
}
