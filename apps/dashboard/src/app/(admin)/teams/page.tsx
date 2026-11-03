"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  APPLICATION_CATEGORIES,
  APPLICATION_MATCH_KINDS,
  formatDuration,
  teamCreateSchema,
  type Employee,
  type Paginated,
  type Team,
  type TeamLabel,
  type TeamProductivityResponse,
} from "@workfolio/shared";
import { Button, DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge, SuccessNotice } from "@/components/kit";
import { Card, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const pct = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);
const CATEGORY_LABEL: Record<TeamLabel["category"], string> = { PRODUCTIVE: "Productive", NEUTRAL: "Neutral", UNPRODUCTIVE: "Unproductive" };
const MATCH_LABEL: Record<TeamLabel["matchKind"], string> = { IDENTIFIER: "Application ID", NAME: "Application name" };

/** Admin: teams (W40), their heads (W41) and members, and productivity per team (F05). */
export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [revision, setRevision] = useState(0); // bumps when team labels change, so productivity reloads

  const load = useCallback(() => {
    api<Team[]>("/teams").then((r) => (setTeams(r), setError(null)), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  // ponytail: first 100 employees only; add search when organisations outgrow it.
  useEffect(() => void api<Paginated<Employee>>("/employees?pageSize=100").then((r) => setEmployees(r.items), () => undefined), []);

  const done = (message: string) => (setOk(message), load());
  const current = teams?.find((t) => t.id === editing) ?? null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Teams"
        description="Group employees into teams. An employee can be in several teams. A team head sees only the members of the active teams they head: their employee records, attendance, activity, screenshots and timelapses. Deactivating a team ends its head's access at once."
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />

      <Card title="Create a team">
        <CreateTeam employees={employees} onCreated={(t) => done(`Created ${t.name}.`)} />
      </Card>

      <Card title="Teams">
        {error && <ErrorState message={error} onRetry={load} />}
        {!teams && !error && <SkeletonRows label="teams" />}
        {teams?.length === 0 && <EmptyState title="No teams yet." hint="Create one above. Employees without a team keep working as before." />}
        {teams && teams.length > 0 && (
          <DataTable label="Teams" head={["Name", "Head", "Members", "Status", "Action"]}>
            {teams.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">{t.name}</td>
                <td className="text-sm">{t.head ? (t.head.fullName ?? t.head.email) : <span className="text-muted">No head</span>}</td>
                <td className="tabular-nums">{t.members.length}</td>
                <td>{t.active ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge tone="neutral">Inactive</StatusBadge>}</td>
                <td>
                  <Button variant="secondary" className="px-3 py-1" onClick={() => setEditing(t.id)} aria-label={`Edit ${t.name}`}>Edit</Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      {current && <EditTeam key={current.id} team={current} employees={employees} onSaved={(m) => done(m)} onClose={() => setEditing(null)} />}
      {current && <TeamLabels key={`labels-${current.id}`} team={current} onChanged={(m) => (setOk(m), setRevision((n) => n + 1))} />}

      <TeamProductivity revision={revision} />
    </div>
  );
}

function HeadSelect({ id, value, employees, onChange }: { id?: string; value: string; employees: Employee[]; onChange: (v: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      <option value="">No head</option>
      {employees.filter((e) => e.accountStatus === "ACTIVE").map((e) => (
        <option key={e.userId} value={e.userId}>{e.fullName} ({e.employeeCode})</option>
      ))}
    </select>
  );
}

function CreateTeam({ employees, onCreated }: { employees: Employee[]; onCreated: (t: Team) => void }) {
  const [form, setForm] = useState({ name: "", head: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = teamCreateSchema.safeParse({ name: form.name, headUserId: form.head || null });
    if (!parsed.success) return setError("Give the team a name (up to 80 characters).");
    setBusy(true);
    setError(null);
    try {
      onCreated(await api<Team>("/teams", { method: "POST", body: parsed.data }));
      setForm({ name: "", head: "" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Create a team" onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input required maxLength={80} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputClass} placeholder="e.g. Support" />
        </Field>
        <Field label="Team head (optional)">
          <HeadSelect value={form.head} employees={employees} onChange={(head) => setForm((f) => ({ ...f, head }))} />
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" pending={busy} pendingLabel="Creating…">Create team</Button>
      </div>
    </form>
  );
}

function EditTeam({ team, employees, onSaved, onClose }: { team: Team; employees: Employee[]; onSaved: (message: string) => void; onClose: () => void }) {
  const [name, setName] = useState(team.name);
  const [head, setHead] = useState(team.head?.id ?? "");
  const [members, setMembers] = useState(() => new Set(team.members.map((m) => m.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: object) => api(`/teams/${team.id}`, { method: "PATCH", body });
  // Members outside the first page of employees stay selected (shown by name from the team).
  const choices = [...employees, ...team.members.filter((m) => !employees.some((e) => e.id === m.id))];

  return (
    <Card title={`Edit ${team.name}`} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        <form
          aria-label="Name and head"
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => (e.preventDefault(), void run(() => patch({ name, headUserId: head || null }), `Saved ${name.trim()}.`))}
        >
          <Field label="Name">
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Team head">
            <HeadSelect value={head} employees={employees} onChange={setHead} />
          </Field>
          <Button type="submit" pending={busy} pendingLabel="Saving…">Save</Button>
        </form>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Members ({members.size})</legend>
          <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
            {choices.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={members.has(e.id)}
                  onChange={(ev) => setMembers((s) => {
                    const next = new Set(s);
                    if (ev.target.checked) next.add(e.id);
                    else next.delete(e.id);
                    return next;
                  })}
                />
                {e.fullName} <span className="text-muted">({e.employeeCode})</span>
              </label>
            ))}
          </div>
          <div>
            <Button variant="secondary" pending={busy} pendingLabel="Saving…" onClick={() => void run(() => api(`/teams/${team.id}/members`, { method: "PUT", body: { employeeIds: [...members] } }), `Saved the members of ${team.name}.`)}>
              Save members
            </Button>
          </div>
        </fieldset>

        {error && <Notice tone="error">{error}</Notice>}
        <div>
          {team.active ? (
            <Button variant="danger" pending={busy} onClick={() => void run(() => patch({ active: false }), `Deactivated ${team.name}; its head no longer sees its members.`)}>Deactivate team</Button>
          ) : (
            <Button variant="secondary" pending={busy} onClick={() => void run(() => patch({ active: true }), `Reactivated ${team.name}.`)}>Reactivate team</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** F05 per team: labels that override the organisation's application labels for this team's members. */
function TeamLabels({ team, onChanged }: { team: Team; onChanged: (message: string) => void }) {
  const [labels, setLabels] = useState<TeamLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/teams/${team.id}/labels`;

  useEffect(() => void api<TeamLabel[]>(url).then(setLabels, (e) => setError(errorMessage(e))), [url]);

  async function run(fn: () => Promise<TeamLabel[]>, message: string) {
    setBusy(true);
    setError(null);
    try {
      setLabels(await fn());
      onChanged(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { matchKind: f.get("matchKind"), value: String(f.get("value")).trim(), category: f.get("category") };
    const form = e.currentTarget;
    void run(() => api<TeamLabel[]>(url, { method: "PUT", body }), `${body.value} is now ${CATEGORY_LABEL[body.category as TeamLabel["category"]]} for ${team.name}.`).then(() => form.reset());
  }

  return (
    <Card title={`Labels for ${team.name}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          These labels replace the organisation&apos;s application labels for this team&apos;s members (while the team is active). If an employee is in
          several teams whose labels for an app disagree, the organisation label applies. Like all labels they also apply to past activity.
        </p>
        {!labels && !error && <SkeletonRows label="team labels" />}
        {labels?.length === 0 && <EmptyState title="No team labels." hint="Members use the organisation's labels." />}
        {labels && labels.length > 0 && (
          <DataTable label={`Labels for ${team.name}`} head={["Matches", "Value", "Label", ""]}>
            {labels.map((l) => (
              <tr key={l.id}>
                <td>{MATCH_LABEL[l.matchKind]}</td>
                <td className="font-mono text-xs break-all">{l.value}</td>
                <td>{CATEGORY_LABEL[l.category]}</td>
                <td>
                  <Button variant="ghost" className="px-3 py-1" pending={busy} aria-label={`Remove the team label for ${l.value}`} onClick={() => void run(() => api<TeamLabel[]>(`${url}/${l.id}`, { method: "DELETE" }), `Removed the ${team.name} label for ${l.value}.`)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        <form aria-label="Set a team label" onSubmit={submit} className="grid gap-3 sm:grid-cols-[auto_1fr_auto_auto] sm:items-end">
          <Field label="Matches">
            <select name="matchKind" defaultValue="NAME" className={inputClass}>
              {APPLICATION_MATCH_KINDS.map((k) => <option key={k} value={k}>{MATCH_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Application">
            <input name="value" required maxLength={255} className={inputClass} placeholder="e.g. Slack or com.tinyspeck.slackmacgap" />
          </Field>
          <Field label="Label">
            <select name="category" defaultValue="PRODUCTIVE" className={inputClass}>
              {APPLICATION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </Field>
          <Button type="submit" pending={busy} pendingLabel="Saving…">Set label</Button>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}

function TeamProductivity({ revision }: { revision: number }) {
  const [range, setRange] = useState({ from: day(-6), to: day(0) });
  const [data, setData] = useState<TeamProductivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<TeamProductivityResponse>(`/teams/productivity?from=${range.from}&to=${range.to}`).then((r) => (setData(r), setError(null)), (e) => setError(errorMessage(e)));
  }, [range]);
  useEffect(load, [load, revision]);

  return (
    <Card
      title="Productivity by team"
      actions={
        <div className="flex items-center gap-2 text-sm">
          <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} className={inputClass} />
          <span className="text-muted">to</span>
          <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} className={inputClass} />
        </div>
      }
    >
      {error && <ErrorState message={error} onRetry={load} />}
      {!data && !error && <SkeletonRows label="team productivity" />}
      {data && !data.categoriesConfigured && <Notice tone="info">No application labels yet, so productive time is not scored. Add labels under App labels.</Notice>}
      {data?.items.length === 0 && <EmptyState title="No active teams." hint="Totals appear here once a team has members." />}
      {data && data.items.length > 0 && (
        <DataTable label="Productivity by team" caption="Members' totals for the range, each member in their own time zone. A member of two teams counts in both." head={["Team", "Members", "Clocked in", "Active", "Idle", "Productive", "Productive %"]}>
          {data.items.map((t) => (
            <tr key={t.team.id}>
              <td className="font-medium">{t.team.name}</td>
              <td className="tabular-nums">{t.memberCount}</td>
              <td className="tabular-nums">{formatDuration(t.clockedInMs)}</td>
              <td className="tabular-nums">{formatDuration(t.activeMs)}</td>
              <td className="tabular-nums">{formatDuration(t.idleMs)}</td>
              <td className="tabular-nums">{t.productiveMs === null ? "—" : formatDuration(t.productiveMs)}</td>
              <td className="tabular-nums">{pct(t.productiveShare)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </Card>
  );
}
