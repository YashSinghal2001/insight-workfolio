"use client";

import Link from "next/link";
import { PLATFORM_ROLE_LABEL, type ActivityStatusResponse, type Device, type Employee, type ScreenshotStatusResponse, type WebsiteStatus } from "@workfolio/shared";
import { useAuth } from "@/components/auth-provider";
import { EmptyState, PageHeader, StatusBadge } from "@/components/kit";
import { useApi, useMe } from "@/components/my-ui";
import { SessionsCard } from "@/components/sessions-card";
import { activeDevice, MyDeviceTable, OS_LABEL } from "@/components/devices";
import { Card, formatInZone } from "@/components/ui";
import { Loaded } from "../_components/states";

const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

function NoticeStatus({ label, version, draft, text, acknowledgedAt, enabled, tz, where, todo }: { label: string; version: string; draft?: boolean; text?: { title: string; points: string[] } | null; acknowledgedAt: string | null; enabled: boolean; tz: string; where: React.ReactNode; todo: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{label}</span>
        <StatusBadge tone={acknowledgedAt ? "success" : "warning"}>{acknowledgedAt ? "Acknowledged" : "Not acknowledged"}</StatusBadge>
        {!enabled && <StatusBadge tone="neutral">Off for your organization</StatusBadge>}
      </div>
      <p className="text-xs text-muted">
        Notice {version}{draft ? " (draft)" : ""}{acknowledgedAt ? ` · acknowledged ${formatInZone(acknowledgedAt, tz)}` : ""} · {where}
      </p>
      {enabled && !acknowledgedAt && <p className="text-xs">{todo}</p>}
      {text && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-brand">Read the notice: {text.title}</summary>
          <ul className="mt-1 list-disc pl-5">{text.points.map((p) => <li key={p}>{p}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Account, devices and monitoring notice status (read-only) and own sessions for the signed-in employee. */
export default function MyProfilePage() {
  const me = useMe();
  const { auth } = useAuth();
  const user = auth.status === "authenticated" ? auth.me.user : null;
  const profile = useApi<Employee>(`/employees/${me.id}`);
  const devices = useApi<Device[]>(`/employees/${me.id}/devices`);
  const activity = useApi<ActivityStatusResponse>("/activity/me");
  const screenshots = useApi<ScreenshotStatusResponse>("/screenshots/me");
  const websites = useApi<WebsiteStatus>("/websites/me");
  const tz = me.timezone;
  const desktop = "acknowledged in the desktop app";
  const inDesktop = "Nothing is recorded for this until you acknowledge it: open the Insight Workfolio desktop app to read and acknowledge the notice.";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My profile" description="Your account details, devices, monitoring notices and sign-in sessions." />

      <Card title="Account">
        <Loaded load={profile.load} reload={profile.reload} label="your profile">
          {(p) => (
            <div className="flex flex-col gap-3 text-sm">
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
                <Row label="Name">{p.fullName}</Row>
                <Row label="Email">{p.email}</Row>
                <Row label="Employee code"><span className="font-mono">{p.employeeCode}</span></Row>
                <Row label="Time zone">{p.timezone}</Row>
                <Row label="Employment status">{words(p.employmentStatus)}</Row>
                <Row label="Account status">{words(p.accountStatus)}</Row>
                <Row label="Role">{user ? PLATFORM_ROLE_LABEL[user.platformRole] : "—"}</Row>
                <Row label="Profile created">{formatInZone(p.createdAt, p.timezone)}</Row>
              </dl>
              <p className="text-xs text-muted">These details are managed by an administrator. Ask an administrator if something needs to change.</p>
            </div>
          )}
        </Loaded>
      </Card>

      <Card title="My devices">
        <Loaded load={devices.load} reload={devices.reload} label="your devices">
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No desktop app registered to your profile yet." hint="Sign in to the Insight Workfolio desktop app to register this computer." />
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  {(() => {
                    const active = activeDevice(list);
                    return active ? <>You are signed in on <span className="font-medium">{active.deviceName}</span> ({OS_LABEL[active.platform] ?? active.platform}). Sign out there before signing in on another device.</> : "You are not signed in on any device. Sign in on any registered device.";
                  })()}
                </p>
                <MyDeviceTable devices={list} timeZone={tz} onChanged={devices.reload} />
              </div>
            )
          }
        </Loaded>
        <p className="mt-3 text-xs text-muted">Register a device by signing in to the desktop app on it. You can register several devices; your account is signed in on one at a time. Only an administrator can revoke a device.</p>
      </Card>

      <Card title="Monitoring notices">
        <div className="flex flex-col text-sm">
          <Loaded load={activity.load} reload={activity.reload} label="the activity notice">
            {(a) => <NoticeStatus label="Activity" version={a.consent.noticeVersion} draft={a.notice.draft} text={a.notice} acknowledgedAt={a.consent.acknowledgedAt} enabled={a.policy.enabled} tz={tz} where={desktop} todo={inDesktop} />}
          </Loaded>
          <Loaded load={screenshots.load} reload={screenshots.reload} label="the screenshot notice">
            {(s) => <NoticeStatus label="Screenshots" version={s.consent.noticeVersion} draft={s.notice.draft} text={s.notice} acknowledgedAt={s.consent.acknowledgedAt} enabled={s.policy.enabled} tz={tz} where={desktop} todo={inDesktop} />}
          </Loaded>
          <Loaded load={websites.load} reload={websites.reload} label="the website notice">
            {(w) => (
              <NoticeStatus
                label="Websites"
                version={w.policy.noticeVersion}
                draft={w.notice?.draft}
                text={w.notice}
                acknowledgedAt={w.acknowledgedAt}
                enabled={w.policy.enabled}
                tz={tz}
                where={<>acknowledged on the <Link href="/my/websites" className="text-brand hover:underline">Websites page</Link></>}
                todo={<>Read and acknowledge it on the <Link href="/my/websites" className="text-brand hover:underline">Websites page</Link>.</>}
              />
            )}
          </Loaded>
        </div>
      </Card>

      <SessionsCard timeZone={tz} />
    </div>
  );
}
