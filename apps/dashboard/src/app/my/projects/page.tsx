"use client";

import type { Project } from "@workfolio/shared";
import { EmptyState, PageHeader, StatusBadge } from "@/components/kit";
import { UpdatedAt, useApi, useMe } from "@/components/my-ui";
import { Loaded } from "../_components/states";

const dateIn = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone }).format(new Date(iso));

/** Projects the signed-in employee is assigned to (the API returns active projects with their open tasks). */
export default function MyProjectsPage() {
  const me = useMe();
  const { load, reload } = useApi<Project[]>("/task-time/assignments");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My projects"
        description="Active projects you are assigned to and their open tasks. Projects and tasks are managed by your administrators."
        actions={load.state === "ready" ? <UpdatedAt at={load.at} /> : undefined}
      />
      <Loaded load={load} reload={reload} label="your projects">
        {(projects) =>
          projects.length === 0 ? (
            <EmptyState title="You are not assigned to any active project." hint="An administrator adds you to projects." />
          ) : (
            <ul aria-label="My projects" className="flex flex-col gap-4">
              {projects.map((p) => (
                <li key={p.id} className="rounded-lg border border-border bg-surface px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="min-w-0 break-words font-medium">{p.name} <span className="font-mono text-xs text-muted">{p.code}</span></h2>
                    <StatusBadge tone={p.status === "ACTIVE" ? "success" : "neutral"}>{p.status === "ACTIVE" ? "Active" : "Archived"}</StatusBadge>
                  </div>
                  {p.description && <p className="mt-1 text-sm whitespace-pre-line text-muted">{p.description}</p>}
                  <p className="mt-1 text-xs text-muted">Created {dateIn(p.createdAt, me.timezone)}</p>
                  <h3 className="mt-3 text-xs font-medium text-muted uppercase">Open tasks ({p.tasks.length})</h3>
                  {p.tasks.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">No open tasks.</p>
                  ) : (
                    <ul aria-label={`Tasks of ${p.name}`} className="mt-1 list-disc pl-5 text-sm">
                      {p.tasks.map((t) => <li key={t.id}>{t.title}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}
