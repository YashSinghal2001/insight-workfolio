import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env.js";
// Runtime use only inside the factory (invitations.ts imports this module too; the cycle is safe).
import { DelegatedGraphMailTransport } from "../employees/invitations.js";
import { ONEDRIVE_AUTH } from "../screenshots/storage.js";
import type { OneDriveService } from "../storage/onedrive.js";

export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Sent instead of `text` by providers that take one body (Graph). */
  html?: string;
}

/** A provider failure. Permanent ones (e.g. a rejected address) are not retried. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/**
 * Email delivery, separate from report generation. Reports: none, mock, or Microsoft Graph delegated
 * (REPORT_MAIL_PROVIDER=graph-delegated, the same transport invitations and notifications use).
 */
export interface MailTransport<Name extends string = "none" | "mock" | "graph"> {
  readonly name: Name;
  /** False for "none" and "mock": nothing reaches anyone's inbox. */
  readonly delivers: boolean;
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/** No provider configured: callers record NOT_CONFIGURED and never call send. */
export class NoMailTransport implements MailTransport {
  readonly name = "none" as const;
  readonly delivers = false;
  send(): Promise<{ messageId: string }> {
    return Promise.reject(new MailError("No email provider is configured", true));
  }
}

/**
 * Development and tests only (refused in production): keeps messages in this process's memory.
 * Nothing is emailed. Failures can be scripted to exercise retries.
 */
export class MockMailTransport implements MailTransport {
  readonly name = "mock" as const;
  readonly delivers = false;
  readonly outbox: (MailMessage & { messageId: string })[] = [];
  private failures: ("transient" | "permanent")[] = [];

  failNext(kind: "transient" | "permanent", times = 1) {
    this.failures.push(...Array<"transient" | "permanent">(times).fill(kind));
  }

  async send(message: MailMessage) {
    const failure = this.failures.shift();
    if (failure) throw new MailError(failure === "permanent" ? "Mock provider rejected the recipient" : "Mock provider temporarily unavailable", failure === "permanent");
    const messageId = `mock-${randomUUID()}`;
    this.outbox.push({ ...message, messageId });
    return { messageId };
  }
}

export const mailTransportProvider = {
  provide: MAIL_TRANSPORT,
  inject: [ConfigService, ONEDRIVE_AUTH],
  useFactory: (config: ConfigService<Env, true>, onedrive: OneDriveService): MailTransport => {
    const provider = config.get("REPORT_MAIL_PROVIDER", { infer: true });
    if (provider === "mock") return new MockMailTransport();
    // Sends as the connected OneDrive account (= MAIL_SENDER, checked at boot). Only when the owner configures it.
    if (provider === "graph-delegated") return new DelegatedGraphMailTransport(onedrive);
    return new NoMailTransport();
  },
};
