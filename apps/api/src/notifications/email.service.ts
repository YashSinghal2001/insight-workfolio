import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { emailSchema, type EmailServiceStatus } from "@workfolio/shared";
import type { Env } from "../config/env.js";
import { INVITATION_TRANSPORT, type InvitationTransport } from "../employees/invitations.js";
import { MailError, type MailMessage } from "../reports/mail.js";
import { ONEDRIVE_AUTH } from "../screenshots/storage.js";
// Type only: onedrive.ts imports the auth guard, which (through AuthService) imports this module.
import type { OneDriveService } from "../storage/onedrive.js";

/**
 * The one way notification email leaves the API: the configured transport (INVITATION_MAIL_PROVIDER, the same
 * instance invitations use), so everything is sent from MAIL_SENDER. With `graph-delegated` that is
 * `POST /me/sendMail` with the OneDrive connection's token (one fresh token and one retry on a 401, inside the
 * transport). Retries across time are the caller's (NotificationsService: bounded, with backoff).
 */
@Injectable()
export class EmailService {
  constructor(
    @Inject(INVITATION_TRANSPORT) private readonly transport: InvitationTransport,
    private readonly config: ConfigService<Env, true>,
    @Inject(ONEDRIVE_AUTH) private readonly onedrive: OneDriveService,
  ) {}

  get sender(): string | null {
    return this.config.get("MAIL_SENDER", { infer: true }) ?? null;
  }

  /** One recipient, a single-line subject: nothing a caller passes can add a recipient or a header. */
  async send(m: MailMessage): Promise<{ messageId: string }> {
    const to = emailSchema.safeParse(m.to);
    if (!to.success || /[\r\n,;<>\s]/.test(m.to)) throw new MailError("The recipient address is not valid", true);
    if (!m.subject || m.subject.length > 255 || /[\r\n]/.test(m.subject)) throw new MailError("The subject is not valid", true);
    return this.transport.send({ ...m, to: to.data });
  }

  async status(): Promise<EmailServiceStatus> {
    const provider = this.config.get("INVITATION_MAIL_PROVIDER", { infer: true });
    const base = { provider, sender: this.sender, delivers: this.transport.delivers, connected: null, mailSendGranted: null, problem: null };
    if (provider === "none") return { ...base, problem: "No email provider is configured: notifications are recorded but not emailed" };
    if (provider !== "graph-delegated") return base;
    const health = await this.onedrive.check();
    const granted = this.onedrive.mailSendGranted;
    return {
      ...base,
      connected: health.connected && health.lastCheckOk === true,
      mailSendGranted: granted,
      problem: health.lastError ?? (granted === false ? "The OneDrive connection's token does not carry Mail.Send: grant it to the app, then reconnect OneDrive" : null),
    };
  }
}
