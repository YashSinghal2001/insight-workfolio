"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  APPLICATION_CATEGORIES,
  APPLICATION_MATCH_KINDS,
  type ApplicationCategoryRule,
  type ApplicationMatchKind,
} from "@workfolio/shared";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, FormField, PageHeader, SkeletonRows, SuccessNotice } from "@/components/kit";
import { Card, inputClass, Notice } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";

type Category = ApplicationCategoryRule["category"];
const CATEGORY_LABEL: Record<Category, string> = { PRODUCTIVE: "Productive", NEUTRAL: "Neutral", UNPRODUCTIVE: "Unproductive" };
const MATCH_LABEL: Record<ApplicationMatchKind, string> = { IDENTIFIER: "Application ID", NAME: "Application name" };

/** Admin rules that label applications; applied when activity is read (so also to past activity). */
export default function ApplicationLabelsPage() {
  const [rules, setRules] = useState<ApplicationCategoryRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ApplicationCategoryRule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ApplicationCategoryRule[]>("/activity/categories").then((r) => (setRules(r), setError(null)), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function change(rule: ApplicationCategoryRule, category: Category) {
    setBusy(rule.id);
    setRowError(null);
    try {
      setRules(await api<ApplicationCategoryRule[]>(`/activity/categories/${rule.id}`, { method: "PATCH", body: { category } }));
      setOk(`${rule.value} is now ${CATEGORY_LABEL[category]}.`);
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Application labels"
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Application labels" }]}
        about={
          <>
            Your own labels for applications, used for the productive, neutral and unproductive totals on{" "}
            <Link href="/activity" className="underline">Activity</Link>. They are applied whenever activity is read, so adding, changing or removing a
            rule also relabels past activity. Applications without a rule stay Unclassified; nothing is labelled automatically, and idle time is never
            productive. Labels describe applications, not people&apos;s performance.
          </>
        }
      />
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} />
      {error && <ErrorState message={error} onRetry={load} />}
      {!rules && !error && <SkeletonRows label="application labels" />}
      {rules && <AddRule onAdded={(r, value) => (setRules(r), setOk(`Rule added for ${value}.`))} />}
      {rules && (
        <Card title={`Rules (${rules.length})`}>
          {rowError && <div className="mb-3"><Notice tone="error">{rowError}</Notice></div>}
          {rules.length === 0 ? (
            <EmptyState title="No rules yet" hint="Every application is Unclassified until you add a rule." />
          ) : (
            <DataTable label="Application label rules" head={["Matches", "Value", "Label", ""]} minWidth={560}>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{MATCH_LABEL[r.matchKind]}</td>
                  <td className="font-mono text-xs break-all">{r.value}</td>
                  <td>
                    <select
                      aria-label={`Label for ${r.value}`}
                      value={r.category}
                      disabled={busy === r.id}
                      onChange={(e) => void change(r, e.target.value as Category)}
                      className={`${inputClass} w-auto`}
                    >
                      {APPLICATION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                    </select>
                  </td>
                  <td className="text-right">
                    <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={() => setRemoving(r)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={!!removing}
        title={`Remove the rule for ${removing?.value ?? ""}?`}
        tone="danger"
        confirmLabel="Remove rule"
        description="The application becomes Unclassified again, also in past activity. The rule's history is kept in the audit log."
        onConfirm={async () => {
          const r = removing!;
          setRules(await api<ApplicationCategoryRule[]>(`/activity/categories/${r.id}`, { method: "DELETE" }));
          setOk(`Rule for ${r.value} removed.`);
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

function AddRule({ onAdded }: { onAdded: (rules: ApplicationCategoryRule[], value: string) => void }) {
  const [matchKind, setMatchKind] = useState<ApplicationMatchKind>("NAME");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const value = String(f.get("value")).trim();
    setPending(true);
    setError(null);
    try {
      onAdded(await api<ApplicationCategoryRule[]>("/activity/categories", { method: "POST", body: { matchKind, value, category: f.get("category") } }), value);
      form.reset();
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status === 409 ? `A rule for this ${MATCH_LABEL[matchKind].toLowerCase()} already exists: change its label in the list instead.` : errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title="Add a rule">
      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[12rem_1fr_10rem_auto] lg:items-end">
        <FormField label="Match by">
          {(p) => (
            <select {...p} value={matchKind} onChange={(e) => setMatchKind(e.target.value as ApplicationMatchKind)} className={inputClass}>
              {APPLICATION_MATCH_KINDS.map((k) => <option key={k} value={k}>{MATCH_LABEL[k]}</option>)}
            </select>
          )}
        </FormField>
        <FormField label={MATCH_LABEL[matchKind]} required>
          {(p) => <input {...p} name="value" maxLength={255} placeholder={matchKind === "NAME" ? "e.g. Slack" : "e.g. com.tinyspeck.slackmacgap"} className={inputClass} />}
        </FormField>
        <FormField label="Label">
          {(p) => (
            <select {...p} name="category" defaultValue="PRODUCTIVE" className={inputClass}>
              {APPLICATION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          )}
        </FormField>
        <Button type="submit" pending={pending} pendingLabel="Adding…">Add rule</Button>
      </form>
      <p className="mt-2 text-xs text-muted">
        Exact match, ignoring case. An application ID rule wins over a name rule. Names and IDs appear on the Activity page for each application.
      </p>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
    </Card>
  );
}
