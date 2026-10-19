/**
 * Explicit, idempotent bootstrap of an admin account. Never runs automatically.
 *
 *   pnpm --filter @workfolio/api admin:create --email you@company.com [--additional]
 *
 * - No password is accepted or generated: the command prints a one-time setup link
 *   (valid 72 h) for the operator to open. Nothing is written to log files.
 * - Refuses when a different admin already exists unless --additional is passed.
 * - Re-running for an admin who has not set a password yet issues a fresh link.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createDatabase, migrate } from "@workfolio/database";
import { emailSchema } from "@workfolio/shared";
import { issueSetupToken, setupLink } from "../auth/setup-token.js";
import { validateEnv } from "../config/env.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

if (existsSync(".env")) process.loadEnvFile(".env");
const env = validateEnv(process.env);
const { values } = parseArgs({ options: { email: { type: "string" }, additional: { type: "boolean", default: false } } });
const email = emailSchema.safeParse(values.email);
if (!email.success) {
  console.error("Usage: admin:create --email <address> [--additional]");
  process.exit(2);
}

const db = createDatabase({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
try {
  await migrate(db);
  const admins = (await db.execute("SELECT id, email, password_hash FROM users WHERE role = 'ADMIN'")).rows;
  const existing = admins.find((a) => a.email === email.data);
  let userId: string;

  if (existing?.password_hash) {
    out(`Admin ${email.data} already exists and is set up. Nothing to do.`);
    process.exit(0);
  } else if (existing) {
    userId = String(existing.id);
    out(`Admin ${email.data} exists but has not set a password; issuing a new setup link.`);
  } else if (admins.length > 0 && !values.additional) {
    console.error(`${admins.length} admin account(s) already exist. Re-run with --additional to add another.`);
    process.exit(1);
  } else {
    const user = (
      await db.execute({ sql: "SELECT role FROM users WHERE email = ?", args: [email.data] })
    ).rows[0];
    if (user) {
      console.error(`${email.data} already belongs to a non-admin account. Refusing to change its role.`);
      process.exit(1);
    }
    userId = randomUUID();
    await db.execute({ sql: "INSERT INTO users (id, email, role) VALUES (?, ?, 'ADMIN')", args: [userId, email.data] });
    out(`Created admin ${email.data}.`);
  }

  const setup = await issueSetupToken(db, userId);
  out("");
  out("Open this one-time link to set the password (expires " + setup.expiresAt + "):");
  out(`  ${setupLink(env.DASHBOARD_URL, setup.token)}`);
  out("Do not paste it into chat, email or tickets.");
} finally {
  db.close();
}
