import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DatabaseClient } from "@workfolio/database";
import { decodeJwt } from "jose";
import { accountAudit } from "../audit/account-audit.js";
import type { Env } from "../config/env.js";
import { MailError, type MailMessage, type MailTransport, MockMailTransport, NoMailTransport } from "../reports/mail.js";
import { ONEDRIVE_AUTH, StorageError } from "../screenshots/storage.js";
// Type only (injected by token): onedrive.ts imports the auth guard, whose AuthService reaches this module.
import type { OneDriveService } from "../storage/onedrive.js";

/** Employee invitation emails (docs/invitations.md). Separate from the report transport on purpose. */
export const INVITATION_TRANSPORT = Symbol("INVITATION_TRANSPORT");
export const INVITATION_SUBJECT = "Welcome to Insight Workfolio — Activate Your Account";
/** No second invitation to the same person while one is in flight or was accepted by the provider this recently. */
export const RESEND_COOLDOWN_MS = 60_000;
/**
 * Waits between attempts after a transient provider failure (3 attempts in all; tests set them to 0).
 * ponytail: retries happen inside the request because the raw link exists only in memory there (only its hash
 * is stored). After that the invitation is FAILED and the admin resends, which issues a fresh link. A background
 * retry would have to issue a fresh link per attempt; add it if FAILED invitations turn out to be common.
 */
export const INVITATION_RETRY = { delaysMs: [1_000, 4_000] };

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;

/**
 * Microsoft Graph sendMail, APP-ONLY (client credentials), as MAIL_SENDER. The right to send comes from Exchange
 * Online RBAC for Applications ("Application Mail.Send" scoped to that one mailbox, docs/invitations.md), not from
 * an Entra application permission: an Entra grant is tenant-wide and overrides the mailbox scope. So a token that
 * carries ANY application permission (a `roles` claim) is refused and nothing is sent.
 */
export type InvitationTransport = MailTransport<"none" | "mock" | "graph">;

export class GraphMailTransport implements InvitationTransport {
  readonly name = "graph" as const;
  readonly delivers = true;
  private access: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { tenantId: string; clientId: string; clientSecret: string; sender: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.value;
    const res = await this.call(`${LOGIN}/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!res.ok || typeof body?.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new MailError(`Microsoft token request failed (HTTP ${res.status}${typeof body?.error === "string" ? `, ${body.error}` : ""})`, !transient(res.status));
    }
    const roles = decodeJwt(body.access_token).roles;
    if (Array.isArray(roles) && roles.length) {
      throw new MailError(`The Microsoft app holds tenant-wide application permissions (${roles.join(", ")}); grant Mail.Send through Exchange RBAC scoped to the sender mailbox instead. Refusing to send`, true);
    }
    this.access = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.access.value;
  }

  async send(m: MailMessage): Promise<{ messageId: string }> {
    const res = await this.call(`${GRAPH}/users/${encodeURIComponent(this.cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: m.subject,
          body: m.html ? { contentType: "HTML", content: m.html } : { contentType: "Text", content: m.text },
          toRecipients: [{ emailAddress: { address: m.to } }],
        },
        // The message carries a live activation link: never leave a copy in the shared IT mailbox.
        saveToSentItems: false,
      }),
    });
    if (res.status === 202) return { messageId: res.headers.get("request-id") ?? "graph" };
    if (res.status === 401) this.access = null;
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    const code = typeof body?.error?.code === "string" ? `, ${body.error.code}` : "";
    throw new MailError(`Microsoft Graph sendMail failed (HTTP ${res.status}${code})`, !transient(res.status) && res.status !== 401);
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new MailError("Microsoft could not be reached", false);
    }
  }
}

const transient = (status: number) => status === 429 || status >= 500;

/**
 * Microsoft Graph sendMail, DELEGATED (INVITATION_MAIL_PROVIDER=graph-delegated): `POST /me/sendMail` with the
 * access token of the OneDrive connection (OneDriveService: same sign-in, encrypted token file and refresh; no
 * second OAuth flow, no second credential). A delegated Mail.Send token can send only as the signed-in account,
 * which OneDriveService pins to ONEDRIVE_ACCOUNT_EMAIL (= MAIL_SENDER, checked at boot). Needs delegated
 * Mail.Send on the app and a OneDrive connection made (or refreshed) after it was granted.
 * Recorded as provider "graph", like the app-only transport: it is Microsoft Graph either way.
 */
export class DelegatedGraphMailTransport implements InvitationTransport {
  readonly name = "graph" as const;
  readonly delivers = true;

  constructor(
    private readonly auth: Pick<OneDriveService, "token">,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(m: MailMessage): Promise<{ messageId: string }> {
    let res = await this.post(m, false);
    // The cached token may have been revoked or rotated away: one fresh token, one more try, never a loop.
    if (res.status === 401) res = await this.post(m, true);
    if (res.status === 202) return { messageId: res.headers.get("request-id") ?? "graph" };
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    const code = typeof body?.error?.code === "string" && /^\w{1,64}$/.test(body.error.code) ? `, ${body.error.code}` : "";
    if (res.status === 401 || res.status === 403) {
      throw new MailError(`Microsoft Graph refused to send as the connected account (HTTP ${res.status}${code}); grant delegated Mail.Send to the app, then reconnect OneDrive in Settings › Storage`, true);
    }
    throw new MailError(`Microsoft Graph sendMail failed (HTTP ${res.status}${code})`, !transient(res.status));
  }

  private async post(m: MailMessage, fresh: boolean): Promise<Response> {
    let token: string;
    try {
      token = await this.auth.token(fresh);
    } catch (err) {
      // StorageError messages are written to be shown (no token, secret or response body in them).
      const why = err instanceof StorageError ? err.message : "unexpected error";
      throw new MailError(`No Microsoft token from the OneDrive connection: ${why}`, !/timed out|unreachable/.test(why));
    }
    if (typeof token !== "string" || !token) throw new MailError("No Microsoft token from the OneDrive connection", true);
    try {
      return await this.fetchFn(`${GRAPH}/me/sendMail`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: m.subject,
            body: m.html ? { contentType: "HTML", content: m.html } : { contentType: "Text", content: m.text },
            toRecipients: [{ emailAddress: { address: m.to } }],
          },
          // The message carries a live activation link: never leave a copy in the shared IT mailbox.
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MailError("Microsoft could not be reached", false);
    }
  }
}

export const invitationTransportProvider = {
  provide: INVITATION_TRANSPORT,
  inject: [ConfigService, ONEDRIVE_AUTH],
  useFactory: (config: ConfigService<Env, true>, onedrive: OneDriveService): InvitationTransport => {
    const provider = config.get("INVITATION_MAIL_PROVIDER", { infer: true });
    if (provider === "mock") return new MockMailTransport();
    if (provider === "none") return new NoMailTransport();
    if (provider === "graph-delegated") return new DelegatedGraphMailTransport(onedrive);
    return new GraphMailTransport({
      tenantId: config.get("MAIL_GRAPH_TENANT_ID", { infer: true })!,
      clientId: config.get("MAIL_GRAPH_CLIENT_ID", { infer: true })!,
      clientSecret: config.get("MAIL_GRAPH_CLIENT_SECRET", { infer: true })!,
      sender: config.get("MAIL_SENDER", { infer: true })!,
    });
  },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The welcome email. The employee's name is escaped (it is admin input); the link carries the token in its fragment. */
export function invitationEmail(p: { to: string; fullName: string; link: string; expiresAt: string; timeZone: string; support: string }): MailMessage {
  const expires = `${new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: p.timeZone }).format(new Date(p.expiresAt))} (${p.timeZone})`;
  const text = [
    `Hello ${p.fullName},`,
    "",
    "Welcome! An Insight Workfolio account has been created for you. Insight Workfolio is where you record your working time and see your own attendance and activity.",
    "",
    "To activate your account, open this link to choose your password.",
    p.link,
    "",
    `The link works once and expires on ${expires}. If it has expired, ask IT for a new invitation.`,
    "Nobody from IT will ever ask you for your password.",
    "",
    `Questions? Contact IT at ${p.support}.`,
  ].join("\n");
  const [name, link, support] = [escapeHtml(p.fullName), escapeHtml(p.link), escapeHtml(p.support)];
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f4f6fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#2f5bea;padding:20px 32px;color:#ffffff;font-size:20px;font-weight:600">Insight Workfolio</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6">
<p style="margin:0 0 16px">Hello ${name},</p>
<p style="margin:0 0 16px">Welcome! An Insight Workfolio account has been created for you. Insight Workfolio is where you record your working time and see your own attendance and activity.</p>
<p style="margin:0 0 24px">To activate your account, choose your password:</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px">Activate your account</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#4b5563">The link works once and expires on ${escapeHtml(expires)}. If it has expired, ask IT for a new invitation. Nobody from IT will ever ask you for your password.</p>
<p style="margin:0 0 16px;font-size:13px;color:#4b5563">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${link}</span></p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">Questions? Contact IT at <a href="mailto:${support}" style="color:#2f5bea">${support}</a>.</td></tr>
</table></td></tr></table></body></html>`;
  return { to: p.to, subject: INVITATION_SUBJECT, text, html };
}

const log = new Logger("Invitations");

/**
 * Sends one invitation (row already PENDING), retrying transient failures, and records the outcome with its
 * audit row. Returns whether the provider accepted it. Never logs or stores the message (it holds the link).
 */
export async function deliverInvitation(
  db: DatabaseClient,
  mail: InvitationTransport,
  inv: { id: string; userId: string; setupTokenId: string; actorUserId: string; message: MailMessage },
): Promise<boolean> {
  const audit = (action: "INVITATION_SENT" | "INVITATION_FAILED", metadata: Record<string, string | number | boolean>) =>
    accountAudit({ actorUserId: inv.actorUserId, targetUserId: inv.userId, action, resourceType: "SETUP_LINK", resourceId: inv.setupTokenId, metadata: { invitationId: inv.id, provider: mail.name, ...metadata } });
  let error = "";
  let permanent = false;
  let attempt = 0;
  for (;;) {
    attempt++;
    await db.execute({ sql: "UPDATE account_invitations SET attempts = ?, updated_at = ? WHERE id = ?", args: [attempt, new Date().toISOString(), inv.id] });
    try {
      await mail.send(inv.message);
      const now = new Date().toISOString();
      await db.batch(
        [
          { sql: "UPDATE account_invitations SET status = 'SENT', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?", args: [now, now, inv.id] },
          audit("INVITATION_SENT", { attempts: attempt }),
        ],
        "write",
      );
      return true;
    } catch (err) {
      permanent = !(err instanceof MailError) || err.permanent;
      error = (err instanceof MailError ? err.message : "Unexpected error while sending").slice(0, 300);
      const delay = INVITATION_RETRY.delaysMs[attempt - 1];
      if (permanent || delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  log.warn(`Invitation ${inv.id} not sent after ${attempt} attempt(s): ${error}`);
  await db.batch(
    [
      { sql: "UPDATE account_invitations SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?", args: [error, new Date().toISOString(), inv.id] },
      audit("INVITATION_FAILED", { attempts: attempt, permanent }),
    ],
    "write",
  );
  return false;
}
