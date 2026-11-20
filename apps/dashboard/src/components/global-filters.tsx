"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Team } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { parseGlobalFilters, serialiseGlobalFilters, todayLocal, type GlobalFilterValues } from "@/lib/global-filters";

/** The top-bar element AppShell renders; <GlobalFilters /> portals into it. */
export const FiltersSlot = createContext<HTMLElement | null>(null);

/**
 * Global date/team filters from the URL (`?date=YYYY-MM-DD&team=<uuid>`). Date defaults to today in the
 * viewer's zone; invalid values are ignored. Setters replace the URL (no history entry) and keep other params.
 * Uses useSearchParams: render inside the admin / my layouts (they gate children client-side) or a Suspense.
 */
export function useGlobalFilters(): GlobalFilterValues & { setDate(date: string): void; setTeamId(id: string | null): void } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const today = todayLocal();
  const value = useMemo(() => parseGlobalFilters(new URLSearchParams(params.toString()), today), [params, today]);
  const update = useCallback(
    (next: GlobalFilterValues) => router.replace(`${pathname}${serialiseGlobalFilters(new URLSearchParams(params.toString()), next, today)}`, { scroll: false }),
    [router, pathname, params, today],
  );
  return {
    ...value,
    setDate: (date) => update({ ...value, date }),
    setTeamId: (teamId) => update({ ...value, teamId }),
  };
}

type TeamsState = { state: "loading" } | { state: "error" } | { state: "ready"; teams: Team[] };

function Controls({ date: showDate, team: showTeam }: { date: boolean; team: boolean }) {
  const { auth } = useAuth();
  const admin = auth.status === "authenticated" && auth.me.user.role === "ADMIN";
  const f = useGlobalFilters();
  const today = todayLocal();
  const [teams, setTeams] = useState<TeamsState>({ state: "loading" });
  const wantTeams = showTeam && admin;

  useEffect(() => {
    if (!wantTeams) return;
    let live = true;
    api<Team[]>("/teams").then(
      (t) => live && setTeams({ state: "ready", teams: t.filter((x) => x.active) }),
      () => live && setTeams({ state: "error" }),
    );
    return () => void (live = false);
  }, [wantTeams]);

  // A team that is not (or no longer) offered falls back to All teams.
  const { teamId, setTeamId } = f;
  useEffect(() => {
    if (teams.state === "ready" && teamId && !teams.teams.some((t) => t.id === teamId)) setTeamId(null);
  }, [teams, teamId, setTeamId]);

  return (
    <div role="group" aria-label="Page filters" className="flex flex-wrap items-center gap-2">
      {showDate && (
        <>
          <input
            type="date"
            aria-label="Date"
            value={f.date}
            onChange={(e) => e.target.value && f.setDate(e.target.value)}
            className={`${inputClass} w-auto py-1`}
          />
          <button
            type="button"
            onClick={() => f.setDate(today)}
            disabled={f.date === today}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            Today
          </button>
        </>
      )}
      {wantTeams && (
        <select
          aria-label="Team"
          value={teams.state === "ready" ? (f.teamId ?? "") : ""}
          disabled={teams.state !== "ready"}
          onChange={(e) => f.setTeamId(e.target.value || null)}
          className={`${inputClass} w-auto max-w-48 py-1`}
        >
          <option value="">{teams.state === "loading" ? "Loading teams…" : teams.state === "error" ? "Teams unavailable" : "All teams"}</option>
          {teams.state === "ready" && teams.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** Renders the date (and, for admins, team) filters into the top bar. A page opts in with `<GlobalFilters />`. */
export function GlobalFilters({ date = true, team = true }: { date?: boolean; team?: boolean }) {
  const slot = useContext(FiltersSlot);
  if (!slot) return null;
  return createPortal(
    <Suspense fallback={null}>
      <Controls date={date} team={team} />
    </Suspense>,
    slot,
  );
}
