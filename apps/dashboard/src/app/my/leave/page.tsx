"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createLeaveSchema,
  DEFAULT_LEAVE_TYPE_ID,
  LEAVE_STATUSES,
  LEAVE_SUMMARY_MAX_DAYS,
  leaveWhen,
  type CreateLeaveInput,
  type LeaveBalanceMeResponse,
  type LeavePortion,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveSummaryMeResponse,
  type LeaveType,
  type Paginated,
} from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, SkeletonRows, StatCard, StatGrid, StatusBadge, SuccessNotice, type Tone } from "@/components/kit";
import { UpdatedAt, useApi, useMe, type Load } from "@/components/my-ui";
import { RangePicker, type Range } from "@/components/range-picker";
import { Card, Field, formatInZone, inputClass, Notice, secondaryButtonClass } from "@/components/ui";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { errorText } from "../_components/states";
import { LEAVE_STATUS_LABEL, monthRange, SUMMARY_ORDER, TallyCell } from "../../(admin)/_components/leave-summary";
import { BalanceText } from "../../(admin)/leave/leave-balances";

const PORTION: Record<LeavePortion, string> = { FULL_DAY: "Full day", FIRST_HALF: "First half", SECOND_HALF: "Second half", SHORT: "Short leave" };
const STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};
const failure = (err: unknown) => (err instanceof ApiRequestError ? errorText(err.message, err.status) : errorMessage(err));
// ponytail: one page of the 100 most recent; add paging if anyone has more.
const PAGE_SIZE = 100;

/** Own leave requests: `mine=true` makes the server scope the list to the caller's own profile (admins included). */
function useMyLeave() {
  const [load, setLoad] = useState<Load<{ items: LeaveRequest[]; truncated: boolean }>>({ state: "loading" });
  const reload = useCallback(async () => {
    try {
      const res = await api<Paginated<LeaveRequest>>(`/leave?mine=true&pageSize=${PAGE_SIZE}`);
      setLoad({ state: "ready", data: { items: res.items, truncated: res.items.length < res.total }, at: Date.now() });
    } catch (err) {
      setLoad({ state: "error", message: errorMessage(err), status: err instanceof ApiRequestError ? err.status : undefined });
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void reload();
  }, [reload]);
  return { load, reload };
}

function NewRequest({ today, onCreated }: { today: string; onCreated: () => void }) {
  const [form, setForm] = useState({ portion: "FULL_DAY" as LeavePortion, leaveTypeId: DEFAULT_LEAVE_TYPE_ID, startDate: today, endDate: today, startTime: "", endTime: "", reason: "" });
  const { load: types } = useApi<LeaveType[]>("/leave/types");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const single = form.portion !== "FULL_DAY";
  const set = (patch: Partial<typeof form>) => {
    setOk(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const body: CreateLeaveInput = {
      portion: form.portion,
      leaveTypeId: form.leaveTypeId,
      startDate: form.startDate,
      endDate: single ? form.startDate : form.endDate,
      ...(form.portion === "SHORT" ? { startTime: form.startTime, endTime: form.endTime } : {}),
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    };
    const parsed = createLeaveSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form.");
      setBusy(false);
      return;
    }
    try {
      const created = await api<LeaveRequest>("/leave", { method: "POST", body });
      setOk(`Requested: ${leaveWhen(created)}. An administrator will decide it.`);
      setForm((f) => ({ ...f, reason: "" }));
      onCreated();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="New leave request" onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Portion</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {(Object.keys(PORTION) as LeavePortion[]).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input type="radio" name="portion" value={p} checked={form.portion === p} onChange={() => set({ portion: p })} />
              {PORTION[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Leave type" hint="Approval is refused if it would exceed your balance for this type.">
          <select value={form.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })} className={inputClass}>
            {types.state === "ready"
              ? types.data.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.paid ? "paid" : "unpaid"})</option>)
              : <option value={DEFAULT_LEAVE_TYPE_ID}>General</option>}
          </select>
        </Field>
        <div className="hidden sm:block" />
        <Field label={single ? "Date" : "Start date"}>
          <input type="date" required value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} className={inputClass} />
        </Field>
        {!single && (
          <Field label="End date">
            <input type="date" required value={form.endDate} min={form.startDate} onChange={(e) => set({ endDate: e.target.value })} className={inputClass} />
          </Field>
        )}
        {form.portion === "SHORT" && (
          <>
            <Field label="Start time" hint="24-hour, your time zone">
              <input type="time" required value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} className={inputClass} />
            </Field>
            <Field label="End time" hint="24-hour, your time zone">
              <input type="time" required value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} className={inputClass} />
            </Field>
          </>
        )}
      </div>
      <Field label="Reason (optional)" hint="Up to 500 characters. Administrators can read it. Please do not include medical or other sensitive details.">
        <textarea value={form.reason} maxLength={500} rows={2} onChange={(e) => set({ reason: e.target.value })} className={inputClass} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <SuccessNotice message={ok} onDismiss={() => setOk(null)} timeoutMs={0} />
      <div>
        <Button type="submit" pending={busy} pendingLabel="Sending…">Request leave</Button>
      </div>
    </form>
  );
}

function CancelCell({ request, onCancelled }: { request: LeaveRequest; onCancelled: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button type="button" className={`${secondaryButtonClass} px-3 py-1`} onClick={() => setConfirming(true)} aria-label={`Cancel request: ${leaveWhen(request)}`}>Cancel</button>
      <ConfirmDialog
        open={confirming}
        title="Cancel this leave request?"
        description={<>{leaveWhen(request)}. An administrator will no longer be asked to decide it. You can request it again later.</>}
        confirmLabel="Yes, cancel"
        cancelLabel="Keep"
        tone="danger"
        onConfirm={async () => {
          try {
            await api<LeaveRequest>(`/leave/${request.id}/cancel`, { method: "POST" });
          } catch (err) {
            throw new Error(failure(err));
          }
          onCancelled();
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** Own totals per status for a range (GET /leave/summary/me: the server takes the employee from the session). */
function MySummary({ timeZone, range, onRange }: { timeZone: string; range: Range; onRange: (r: Range) => void }) {
  const { load, reload } = useApi<LeaveSummaryMeResponse>(`/leave/summary/me?from=${range.from}&to=${range.to}`);
  return (
    <div className="flex flex-col gap-3">
      <RangePicker value={range} maxDays={LEAVE_SUMMARY_MAX_DAYS} timeZone={timeZone} onChange={onRange} />
      {load.state === "loading" && <SkeletonRows label="your leave summary" rows={1} />}
      {load.state === "error" && <ErrorState title="Could not load your leave summary" message={errorText(load.message, load.status)} onRetry={() => void reload()} />}
      {load.state === "ready" && (
        <>
          <DataTable label="My leave summary" caption={`${load.data.from} to ${load.data.to}`} head={SUMMARY_ORDER.map((s) => LEAVE_STATUS_LABEL[s])}>
            <tr className="align-top">{SUMMARY_ORDER.map((s) => <td key={s} data-status={s}><TallyCell t={load.data.row.byStatus[s]} /></td>)}</tr>
          </DataTable>
          <p className="text-xs text-muted">{load.data.meta.dayRule}</p>
        </>
      )}
    </div>
  );
}

/** Own balances per leave type (GET /leave/balances/me: the server takes the employee from the session). */
function MyBalances() {
  const { load, reload } = useApi<LeaveBalanceMeResponse>("/leave/balances/me");
  if (load.state === "loading") return <SkeletonRows label="your leave balances" rows={1} />;
  if (load.state === "error") return <ErrorState title="Could not load your leave balances" message={errorText(load.message, load.status)} onRetry={() => void reload()} />;
  return (
    <div className="flex flex-col gap-2">
      <DataTable label="My leave balances" caption={`${load.data.month.slice(0, 4)} (short leave: ${load.data.month})`} head={["Leave type", "Paid", "Balance"]}>
        {load.data.row.balances.map((b) => (
          <tr key={b.leaveType.id} className="align-top">
            <td className="font-medium">{b.leaveType.name}</td>
            <td>{b.leaveType.paid ? "Paid" : "Unpaid"}</td>
            <td><BalanceText b={b} /></td>
          </tr>
        ))}
      </DataTable>
      <p className="text-xs text-muted">{load.data.dayRule}</p>
    </div>
  );
}

/** The signed-in employee's own leave requests: overview, new request and history. */
export default function MyLeavePage() {
  const me = useMe();
  const { auth } = useAuth();
  const userId = auth.status === "authenticated" ? auth.me.user.id : null;
  const { load, reload } = useMyLeave();
  const [summaryRange, setSummaryRange] = useState<Range>(() => monthRange(me.timezone));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: me.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My leave" description="Request leave and follow the decisions. Only your own requests are shown." actions={load.state === "ready" ? <UpdatedAt at={load.at} /> : undefined} />
      <Notice tone="info">
        A request records what you asked for and the decision; it does not change your attendance records. Holidays use no leave balance. Dates and times
        are in your time zone ({me.timezone}).
      </Notice>

      {load.state === "loading" && <SkeletonRows label="leave requests" rows={2} />}
      {load.state === "error" && <ErrorState title="Could not load leave requests" message={errorText(load.message, load.status)} onRetry={() => void reload()} />}
      {load.state === "ready" && (
        <section aria-label="Overview">
          <StatGrid>
            {LEAVE_STATUSES.map((s) => <StatCard key={s} label={STATUS[s].label} value={load.data.items.filter((r) => r.status === s).length} hint={load.data.truncated ? "Most recent requests only" : undefined} />)}
          </StatGrid>
        </section>
      )}

      <Card title="Balances">
        <MyBalances key={load.state === "ready" ? load.at : 0} />
      </Card>

      <Card title="Summary for a period">
        {/* Remounted (refetched) whenever the request list reloads, e.g. after a new request or a cancel. */}
        <MySummary key={load.state === "ready" ? load.at : 0} timeZone={me.timezone} range={summaryRange} onRange={setSummaryRange} />
      </Card>

      <Card title="New leave request">
        <NewRequest today={today} onCreated={() => void reload()} />
      </Card>

      <Card title="History">
        {load.state === "ready" &&
          (load.data.items.length === 0 ? (
            <EmptyState title="You have not requested any leave yet." hint="Use the form above to send your first request." />
          ) : (
            <>
              {load.data.truncated && <p className="mb-2 text-xs text-muted">Showing the most recent requests only.</p>}
              <DataTable label="My leave requests" head={["Dates", "Type", "Portion", "Status", "Reason", "Decision", "Action"]}>
                {load.data.items.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap">{leaveWhen(r)}</td>
                    <td>{r.leaveType.name}</td>
                    <td className="whitespace-nowrap">{PORTION[r.portion]}{r.portion === "SHORT" ? ` (${r.startTime}–${r.endTime})` : ""}</td>
                    <td><StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge></td>
                    <td className="max-w-xs break-words">{r.reason ?? <span className="text-muted">None given</span>}</td>
                    <td className="max-w-xs text-xs">
                      {r.decisionNote && <p className="text-sm">{r.decisionNote}</p>}
                      {r.decidedAt ? (
                        <p className="text-muted">{STATUS[r.status].label} {formatInZone(r.decidedAt, me.timezone)}{r.decidedBy ? ` by ${r.decidedBy.email}` : ""}</p>
                      ) : (
                        <p className="text-muted">Requested {formatInZone(r.requestedAt, me.timezone)}</p>
                      )}
                    </td>
                    <td>{r.status === "PENDING" && r.requestedBy.id === userId && <CancelCell request={r} onCancelled={() => void reload()} />}</td>
                  </tr>
                ))}
              </DataTable>
            </>
          ))}
        {load.state !== "ready" && <p className="text-sm text-muted">The history appears once your requests have loaded.</p>}
      </Card>
    </div>
  );
}
