/**
 * Explicit, idempotent bootstrap of an admin account. Never runs automatically.
 *
 *   pnpm --filter @workfolio/api admin:create --email you@company.com [--additional] [--super-admin]
 *
 * - No password is accepted or generated: the command prints a one-time setup link
 *   (valid 72 h) for the operator to open. Nothing is written to log files.
 * - Refuses when a different admin already exists unless --additional is passed.
 * - Re-running for an admin who has not set a password yet issues a fresh link.
 * - Audited (account_audit, actor = server): ACCOUNT_CREATED { via: "cli", identity } and SETUP_LINK_ISSUED,
 *   committed in the same transaction as the account and the link.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createDatabase, type InStatement } from "@workfolio/database";
import { emailSchema } from "@workfolio/shared";
import { accountAudit } from "../audit/account-audit.js";
import { setupLink } from "../auth/setup-token.js";
import { validateEnv } from "../config/env.js";
import { prepareDatabase, prepareOptionsFor } from "../database/prepare.js";
import { setupTokenStatements } from "../auth/setup-token.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

if (existsSync(".env")) process.loadEnvFile(".env");
const env = validateEnv(process.env);
const { values } = parseArgs({ options: { email: { type: "string" }, additional: { type: "boolean", default: false }, "super-admin": { type: "boolean", default: false } } });
const email = emailSchema.safeParse(values.email);
if (!email.success) {
  console.error("Usage: admin:create --email <address> [--additional] [--super-admin]");
  process.exit(2);
}

const db = createDatabase({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
try {
  // Same rule as API startup: migrates a local file outside production, but only verifies a hosted or
  // production database (refuses if migrations are pending; apply them with db:migrate first).
  await prepareDatabase(db, prepareOptionsFor(env.DATABASE_URL, env.NODE_ENV));
  const admins = (await db.execute("SELECT id, email, password_hash FROM users WHERE role = 'ADMIN'")).rows;
  const existing = admins.find((a) => a.email === email.data);
  let userId: string;
  const created: InStatement[] = [];

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
    // The server-side bootstrap is how the first Super Admin exists (a Super Admin title can otherwise only
    // be granted by another Super Admin). Creating an account is not a role change, so no history row.
    const title = values["super-admin"] ? "SUPER_ADMIN" : "ADMIN";
    created.push(
      { sql: "INSERT INTO users (id, email, role, admin_title) VALUES (?, ?, 'ADMIN', ?)", args: [userId, email.data, title] },
      accountAudit({ actorUserId: null, targetUserId: userId, action: "ACCOUNT_CREATED", resourceType: "ACCOUNT", resourceId: userId, metadata: { via: "cli", identity: title } }),
    );
  }

  const { setup, statements } = setupTokenStatements(userId, null);
  await db.batch([...created, ...statements], "write");
  if (created.length) out(`Created ${values["super-admin"] ? "Super Admin" : "Admin"} ${email.data}.`);
  out("");
  out("Open this one-time link to set the password (expires " + setup.expiresAt + "):");
  out(`  ${setupLink(env.DASHBOARD_URL, setup.token)}`);
  out("Do not paste it into chat, email or tickets.");
} finally {
  db.close();
}
