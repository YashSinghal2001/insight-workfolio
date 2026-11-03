"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatDuration, type Project, type ProjectHistoryItem, type ProjectTimeSummary } from "@workfolio/shared";
import { ConfirmDialog, EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/kit";
import { RangePicker, weekRange, type Range } from "@/components/range-picker";
import { Badge, buttonClass, Card, inputClass, secondaryButtonClass } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { EmployeePicker } from "../_components/employee-picker";

const th = "px-4 py-3 font-medium";
const td = "px-4 py-3";
const small = `${secondaryButtonClass} !px-2 !py-1 text-xs`;

/** One project: rename, archive or restore, tasks, assignments and its change history. */
function ProjectCard({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [history, setHistory] = useState<ProjectHistoryItem[] | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "archive" } | { kind: "remove"; member: { id: string; fullName: string } } | null>(null);
  const archived = project.status === "ARCHIVED";
  const base = `/projects/${project.id}`;

  async function run(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, body });
      onChanged();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** For confirmed actions: the error is shown inside the dialog. */
  async function confirmed(path: string, method: string, body?: unknown) {
    try {
      await api(path, { method, body });
    } catch (err) {
      throw new Error(errorMessage(err));
    }
    onChanged();
  }
  return (
    <article className="rounded-lg border border-border bg-surface p-4 text-sm" aria-label={`${project.code} ${project.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-mono text-xs text-muted">{project.code}</span> <span className="font-medium">{project.name}</span>{" "}
          <Badge ok={!archived}>{archived ? "Archived: no new timers" : "Active"}</Badge>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy} className={small} onClick={() => (archived ? void run(base, "PATCH", { status: "ACTIVE" }) : setConfirm({ kind: "archive" }))}>
            {archived ? "Restore" : "Archive"}
          </button>
        </div>
      </div>
      {project.description && <p className="mt-1 text-muted">{project.description}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted">Edit name and description</summary>
        <form
          className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]"
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await run(base, "PATCH", { name: f.get("name"), description: f.get("description") });
          }}
        >
          <input name="name" aria-label="Project name" required maxLength={120} defaultValue={project.name} className={inputClass} />
          <input name="description" aria-label="Project description" maxLength={1000} defaultValue={project.description ?? ""} className={inputClass} />
          <button type="submit" disabled={busy} className={secondaryButtonClass}>Save</button>
        </form>
      </details>
      {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <section aria-label="Tasks">
          <h4 className="mb-1 text-xs font-medium text-muted uppercase">Tasks</h4>
          <ul className="flex flex-col gap-1">
            {project.tasks.length === 0 && <li className="text-muted">No tasks yet.</li>}
            {project.tasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span className={t.status === "CLOSED" ? "text-muted line-through" : ""}>{t.title}</span>
                <button type="button" disabled={busy} className={small} onClick={() => void run(`${base}/tasks/${t.id}`, "PATCH", { status: t.status === "OPEN" ? "CLOSED" : "OPEN" })}>
                  {t.status === "OPEN" ? "Close" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await run(`${base}/tasks`, "POST", { title })) setTitle("");
            }}
          >
            <input aria-label={`New task for ${project.code}`} placeholder="New task" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            <button type="submit" disabled={busy || !title.trim()} className={secondaryButtonClass}>Add</button>
          </form>
        </section>

        <section aria-label="Assigned employees">
          <h4 className="mb-1 text-xs font-medium text-muted uppercase">Assigned employees</h4>
          <ul className="flex flex-col gap-1">
            {!project.members?.length && <li className="text-muted">Nobody is assigned.</li>}
            {project.members?.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span>{m.fullName} <span className="font-mono text-xs text-muted">{m.employeeCode}</span></span>
                <button type="button" disabled={busy} className={small} onClick={() => setConfirm({ kind: "remove", member: m })}>Remove</button>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await run(`${base}/members`, "POST", { employeeId: assignee })) setAssignee("");
            }}
          >
            <EmployeePicker
              value={assignee}
              onChange={(id) => setAssignee(id)}
              label="Employee to assign"
              selectLabel={`Assign an employee to ${project.code}`}
              exclude={project.members?.map((m) => m.id)}
            />
            <button type="submit" disabled={busy || !assignee} className={`${secondaryButtonClass} self-end`}>Assign</button>
          </form>
        </section>
      </div>

      <details
        className="mt-3"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) api<ProjectHistoryItem[]>(`${base}/history`).then(setHistory, (err) => setError(errorMessage(err)));
        }}
      >
        <summary className="cursor-pointer text-xs text-muted">Change history</summary>
        {!history && <p role="status" className="text-xs text-muted">Loading…</p>}
        <ol className="mt-1 text-xs">
          {history?.map((h, i) => (
            <li key={i}>{new Date(h.at).toLocaleString("en-GB")} · {h.by.email} · {h.action.toLowerCase().replaceAll("_", " ")}</li>
          ))}
        </ol>
      </details>
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        title={`Archive ${project.code} ${project.name}?`}
        tone="danger"
        confirmLabel="Archive project"
        description="Running timers keep their time, but nobody can start a new timer on this project. Nothing is deleted, and you can restore it later."
        onConfirm={() => confirmed(base, "PATCH", { status: "ARCHIVED" })}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "remove"}
        title={`Remove ${confirm?.kind === "remove" ? confirm.member.fullName : ""} from ${project.code}?`}
        tone="danger"
        confirmLabel="Remove from project"
        description="They can no longer start timers on this project. Time already logged is kept, and the change is recorded in the project history."
        onConfirm={() => (confirm?.kind === "remove" ? confirmed(`${base}/members/${confirm.member.id}`, "DELETE") : undefined)}
        onClose={() => setConfirm(null)}
      />
    </article>
  );
}

function Summary() {
  const [range, setRange] = useState<Range>(() => weekRange(0));
  const [data, setData] = useState<ProjectTimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ProjectTimeSummary>(`/projects/summary?from=${range.from}&to=${range.to}`).then(
      (d) => live && (setData(d), setError(null)),
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [range]);

  return (
    <Card title="Logged task time">
      <div className="flex flex-col gap-4">
        <RangePicker value={range} maxDays={92} onChange={(r) => (setData(null), setRange(r))} />
        <p className="text-xs text-muted">
          Completed timer entries, on the employee&apos;s local date of the start. Task time and attendance time are separate measures:
          task time is how long timers ran (idle time included); neither is a productivity score.
          {data && data.running > 0 && ` ${data.running} timer(s) running now are not included.`}
        </p>
        {error && <ErrorState message={error} />}
        {!data && !error && <SkeletonRows label="task time" />}
        {data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm" aria-label="Task time by project">
                <thead className="border-b border-border text-xs text-muted uppercase">
                  <tr><th scope="col" className={th}>Project / task</th><th scope="col" className={th}>Task time</th><th scope="col" className={th}>Entries</th></tr>
                </thead>
                <tbody>
                  {data.byProject.length === 0 && <tr><td colSpan={3} className={`${td} text-center text-muted`}>No task time in this range.</td></tr>}
                  {data.byProject.flatMap((p) => [
                    <tr key={p.project.id} className="border-b border-border">
                      <td className={`${td} font-medium`}>{p.project.code} · {p.project.name} {p.project.status === "ARCHIVED" && <Badge ok={false}>Archived</Badge>}</td>
                      <td className={`${td} tabular-nums`}>{formatDuration(p.taskMs)}</td>
                      <td className={`${td} tabular-nums`}>{p.entries}</td>
                    </tr>,
                    ...p.byTask.map((t) => (
                      <tr key={`${p.project.id}-${t.task.id}`} className="border-b border-border text-muted">
                        <td className={`${td} pl-8`}>{t.task.title}</td>
                        <td className={`${td} tabular-nums`}>{formatDuration(t.taskMs)}</td>
                        <td className={`${td} tabular-nums`}>{t.entries}</td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm" aria-label="Task time by employee">
                <thead className="border-b border-border text-xs text-muted uppercase">
                  <tr><th scope="col" className={th}>Employee</th><th scope="col" className={th}>Task time</th><th scope="col" className={th}>Attendance worked</th><th scope="col" className={th}>Entries</th></tr>
                </thead>
                <tbody>
                  {data.byEmployee.length === 0 && <tr><td colSpan={4} className={`${td} text-center text-muted`}>No task time in this range.</td></tr>}
                  {data.byEmployee.map((r) => (
                    <tr key={r.employee.id} className="border-b border-border last:border-0">
                      <td className={td}>{r.employee.fullName} <span className="font-mono text-xs text-muted">{r.employee.employeeCode}</span></td>
                      <td className={`${td} tabular-nums`}>{formatDuration(r.taskMs)}</td>
                      <td className={`${td} tabular-nums`}>{formatDuration(r.attendanceNetMs)}</td>
                      <td className={`${td} tabular-nums`}>{r.entries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", description: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects(await api<Project[]>("/projects"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api("/projects", { method: "POST", body: { code: form.code, name: form.name, ...(form.description.trim() ? { description: form.description } : {}) } });
      setForm({ code: "", name: "", description: "" });
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Projects"
        description="Create projects and tasks, and assign employees. Assigned employees start and stop task timers in the desktop app while clocked in. Timers never change attendance, and archived projects or closed tasks accept no new timers. Nothing is deleted: every change is kept in the project's history."
      />

      <Card title="New project">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Code</span>
            <input required value={form.code} maxLength={32} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputClass} placeholder="APOLLO" />
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span>
            <input required value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="font-medium">Description (optional)</span>
            <input value={form.description} maxLength={1000} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} />
          </label>
          {formError && <p role="alert" className="text-sm text-red-700 sm:col-span-2 dark:text-red-300">{formError}</p>}
          <div><button type="submit" className={buttonClass}>Create project</button></div>
        </form>
      </Card>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!projects && !error && <SkeletonRows label="projects" />}
      {projects?.length === 0 && <EmptyState title="No projects yet." hint="Create one above, then add tasks and assign employees." />}
      {projects?.map((p) => <ProjectCard key={p.id} project={p} onChanged={() => void load()} />)}

      <Summary />
    </div>
  );
}
