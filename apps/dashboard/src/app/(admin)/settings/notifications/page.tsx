"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  NOTIFICATION_RULE_MODES,
  type AttendanceNotificationType,
  type NotificationOverview,
  type NotificationRecipientCandidate,
  type NotificationRule,
  type NotificationRuleMode,
  type Team,
} from "@workfolio/shared";
import { Button, EmptyState, ErrorState, PageHeader, SkeletonRows, StatusBadge } from "@/components/kit";
import { Card, Field, inputClass, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { candidatesFor, groupRules, MODE_LABEL, ruleChanges, ruleSummary, teamsWithoutRule, TYPE_LABEL, type Candidate, type TeamLite } from "@/lib/notification-rules";

const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/** Settings → Email & notifications: attendance notification rules (docs/notifications.md §9). */
export default function NotificationRulesPage() {
  const [rules, setRules] = useState<NotificationRule[] | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [email, setEmail] = useState<NotificationOverview["email"] | null>(null);
  const [teams, setTeams] = useState<TeamLite[]>([]);
  // Eligible recipients per scope ("" = organisation-wide, else team id), from the API's own eligibility check.
  const [eligible, setEligible] = useState<Record<string, NotificationRecipientCandidate[]>>({});
  const [lookupError, setLookupError] = useState<string | null>(null);

  const loadRules = useCallback(() => {
    api<NotificationRule[]>("/notifications/rules").then((r) => (setRules(r), setRulesError(null)), (e) => setRulesError(errorMessage(e)));
  }, []);
  useEffect(loadRules, [loadRules]);
  useEffect(() => {
    api<NotificationOverview>("/notifications?show=critical").then((o) => setEmail(o.email), () => setEmail(null));
  }, []);
  const scopes = rules ? [...new Set(["", ...rules.map((r) => r.teamId ?? "")])].sort().join(",") : null;
  const loadLookups = useCallback(() => {
    if (scopes === null) return;
    const list = scopes.split(",");
    Promise.all([
      api<Team[]>("/teams"),
      ...list.map((id) => api<NotificationRecipientCandidate[]>(`/notifications/rules/recipient-candidates${id ? `?teamId=${id}` : ""}`)),
    ]).then(
      ([t, ...c]) => (setTeams(t as Team[]), setEligible(Object.fromEntries(list.map((id, i) => [id, c[i] as NotificationRecipientCandidate[]]))), setLookupError(null)),
      (e) => setLookupError(errorMessage(e)),
    );
  }, [scopes]);
  useEffect(loadLookups, [loadLookups]);

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "Unknown team";
  const replace = (r: NotificationRule) => setRules((all) => (all ? (all.some((x) => x.id === r.id) ? all.map((x) => (x.id === r.id ? r : x)) : [...all, r]) : all));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Email & notifications"
        description={<>Who is emailed about attendance events. Every email sent is in the <Link href="/notifications" className="text-brand underline">delivery log</Link>.</>}
        about={
          <>
            Every rule starts <strong>Off</strong>: nothing is recorded or emailed until you choose Immediate (one email per event) or Daily digest (one
            summary per recipient per day at the digest time, in the rule&apos;s time zone). The organisation-wide rule covers every employee; a team rule
            covers only that team&apos;s members. Recipients are accounts only: active Admins or Super Admins, and for a team rule the head of that team.
            Emails never contain screenshots, application names or leave reasons.
          </>
        }
      />
      {email && (email.problem || !email.delivers) && (
        <Notice tone={email.problem && email.provider !== "none" ? "error" : "warning"}>
          {email.provider === "none" ? "No email provider is configured: rules are saved but nothing is emailed." : email.provider === "mock" ? "Test mode (mock provider): rules are saved but nothing is emailed." : email.problem}
          {" "}See <Link href="/notifications" className="underline">Notifications</Link>.
        </Notice>
      )}
      <datalist id="iw-timezones">{TIMEZONES.map((z) => <option key={z} value={z} />)}</datalist>
      {lookupError && <ErrorState title="Could not load teams or admin accounts" message={lookupError} onRetry={loadLookups} />}
      {rulesError && <ErrorState title="Could not load notification rules" message={rulesError} onRetry={loadRules} />}
      {!rules && !rulesError && <SkeletonRows label="notification rules" />}
      {rules?.length === 0 && <EmptyState title="No notification rules." />}
      {rules &&
        groupRules(rules, teamName).map((g) => (
          <Card key={g.type} title={TYPE_LABEL[g.type]}>
            <div className="flex flex-col gap-4">
              {g.org && <RuleEditor rule={g.org} scope="All employees" candidates={candidatesFor(g.org, eligible[""] ?? [])} onSaved={replace} />}
              {g.teams.map((r) => (
                <RuleEditor key={r.id} rule={r} scope={`Team: ${teamName(r.teamId!)}`} candidates={candidatesFor(r, eligible[r.teamId!] ?? [])} onSaved={replace} />
              ))}
              <AddTeamRule type={g.type} teams={teamsWithoutRule(teams, [g.org, ...g.teams].filter((r) => r !== null))} onAdded={replace} />
            </div>
          </Card>
        ))}
    </div>
  );
}

function RuleEditor({ rule, scope, candidates, onSaved }: { rule: NotificationRule; scope: string; candidates: Candidate[]; onSaved: (r: NotificationRule) => void }) {
  const [draft, setDraft] = useState({ mode: rule.mode, digestLocalTime: rule.digestLocalTime ?? "18:00", timezone: rule.timezone });
  const [picked, setPicked] = useState(() => new Set(rule.recipients.map((r) => r.userId)));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const changes = ruleChanges(rule, draft);
  const current = rule.recipients.map((r) => r.userId);
  const recipientsChanged = current.length !== picked.size || current.some((id) => !picked.has(id));
  const legend = `${scope}: ${ruleSummary(rule)}`;

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      let saved = rule;
      if (changes) saved = await api<NotificationRule>(`/notifications/rules/${rule.id}`, { method: "PATCH", body: changes });
      if (recipientsChanged) saved = await api<NotificationRule>(`/notifications/rules/${rule.id}/recipients`, { method: "PUT", body: { userIds: [...picked] } });
      onSaved(saved);
      setStatus({ tone: "success", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="min-w-0 rounded-md border border-border p-3" aria-label={legend}>
      <legend className="flex flex-wrap items-center gap-2 px-1 text-sm font-medium">
        {scope}
        <StatusBadge tone={rule.mode === "OFF" ? "neutral" : "success"}>{ruleSummary(rule)}</StatusBadge>
      </legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Mode">
          <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as NotificationRuleMode })} className={inputClass}>
            {NOTIFICATION_RULE_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Digest time" hint="Used by Daily digest.">
          <input type="time" required value={draft.digestLocalTime} onChange={(e) => setDraft({ ...draft, digestLocalTime: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Time zone" hint="IANA name, e.g. Asia/Kolkata.">
          <input list="iw-timezones" required value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} className={inputClass} />
        </Field>
      </div>
      <div className="mt-3">
        <p className="text-sm font-medium">Recipients</p>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted">No eligible accounts found.</p>
        ) : (
          <ul className="mt-1 grid gap-1 sm:grid-cols-2">
            {candidates.map((c) => (
              <li key={c.userId}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.has(c.userId)}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.userId); else n.delete(c.userId); return n; })}
                  />
                  <span className="min-w-0">
                    {c.label}
                    <span className="block text-xs break-all text-muted">{c.email}{c.kind === "head" ? " · team head" : c.kind === "current" ? " · current recipient" : ""}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {draft.mode !== "OFF" && picked.size === 0 && <p className="mt-1 text-xs text-muted">No recipients: nobody is emailed even though the rule is on.</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} pending={busy} pendingLabel="Saving…" disabled={!changes && !recipientsChanged}>Save rule</Button>
        {status && <div className="min-w-0 flex-1"><Notice tone={status.tone}>{status.text}</Notice></div>}
      </div>
    </fieldset>
  );
}

function AddTeamRule({ type, teams, onAdded }: { type: AttendanceNotificationType; teams: TeamLite[]; onAdded: (r: NotificationRule) => void }) {
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!teams.length) return null;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      onAdded(await api<NotificationRule>("/notifications/rules", { method: "POST", body: { type, teamId } }));
      setTeamId("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Add a rule for one team">
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={inputClass} aria-label={`Team for a ${TYPE_LABEL[type]} rule`}>
          <option value="">Choose a team…</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <Button variant="secondary" onClick={() => void add()} pending={busy} pendingLabel="Adding…" disabled={!teamId}>Add team rule (starts Off)</Button>
      {error && <div className="w-full"><Notice tone="error">{error}</Notice></div>}
    </div>
  );
}
