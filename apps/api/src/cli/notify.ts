/**
 * Records an operational failure seen OUTSIDE the API process (the backup timer, the monitor script), so the
 * running API emails it to IT and the Super Admin and shows it in the dashboard (docs/notifications.md):
 *
 *   node --env-file=/etc/workfolio/api.env dist/cli/notify.js backup-failure "<what failed>"
 *   node --env-file=/etc/workfolio/api.env dist/cli/notify.js critical-failure "<what failed>"
 *
 * - Only writes the event and its delivery rows to the database; the API's queue sends the emails within a
 *   minute (or when it is next up). No Microsoft token is touched here, and no recipient can be named.
 * - At most one event of a kind per UTC day (dedupe key), however often the caller fails.
 * - The description is sanitized (one line, 500 characters, token-like strings removed). Never pass a secret.
 * Exit codes: 0 recorded (or already recorded today), 1 failed, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { createDatabase } from "@workfolio/database";
import type { NotificationType } from "@workfolio/shared";
import { validateEnv } from "../config/env.js";
import { prepareDatabase, prepareOptionsFor } from "../database/prepare.js";
import { recordNotification } from "../notifications/notifications.service.js";

const KINDS: Record<string, NotificationType> = { "backup-failure": "BACKUP_FAILURE", "critical-failure": "CRITICAL_FAILURE" };

export async function run(argv: string[], rawEnv: NodeJS.ProcessEnv, out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [kind, ...words] = argv;
  const type = KINDS[kind ?? ""];
  const description = words.join(" ").trim();
  if (!type || !description) {
    out('usage: notify.js backup-failure|critical-failure "<short description>"');
    return 2;
  }
  const env = validateEnv(rawEnv);
  const db = createDatabase({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
  try {
    await prepareDatabase(db, prepareOptionsFor(env.DATABASE_URL, env.NODE_ENV));
    const id = await recordNotification(db, { type, description, dedupeKey: `cli:${kind}:${new Date().toISOString().slice(0, 10)}` });
    out(id ? `recorded ${type} ${id}` : `already recorded today: ${type}`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`FAILED: ${err.message}`);
      process.exit(1);
    },
  );
}
