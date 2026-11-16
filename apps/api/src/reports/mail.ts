import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import type { ReportMailProvider } from "@workfolio/shared";
import type { Env } from "../config/env.js";

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
 * Email delivery, separate from report generation. A real provider (e.g. Microsoft Graph sendMail
 * or SMTP) implements this once it is approved and configured; none is integrated yet.
 */
export interface MailTransport<Name extends string = ReportMailProvider> {
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
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): MailTransport =>
    config.get("REPORT_MAIL_PROVIDER", { infer: true }) === "mock" ? new MockMailTransport() : new NoMailTransport(),
};
