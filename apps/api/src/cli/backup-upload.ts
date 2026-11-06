/**
 * Off-site copy of a database backup into the connected OneDrive (the IT storage account), run by
 * deploy/scripts/backup-db.sh through BACKUP_UPLOAD_CMD after each nightly backup:
 *
 *   node --env-file=/etc/workfolio/api.env dist/cli/backup-upload.js upload <file.db.gz.gpg>
 *   node --env-file=/etc/workfolio/api.env dist/cli/backup-upload.js check     connection + folder only
 *   node --env-file=/etc/workfolio/api.env dist/cli/backup-upload.js list      what is off-site
 *
 * - Reuses the API's OneDrive connection (same encrypted ONEDRIVE_TOKEN_FILE, delegated Files.ReadWrite on
 *   that account's own OneDrive, docs/onedrive.md): no second app registration, no second credential.
 *   Both processes re-read the file before refreshing, so the token Microsoft rotates for one is followed
 *   by the other.
 * - Destination: <ONEDRIVE_ROOT_FOLDER>/<ONEDRIVE_BACKUP_FOLDER> (default InsightWorkfolio/db-backups), created
 *   when missing. A dedicated folder beside screenshots/ and timelapses/, never inside them; nothing else in
 *   the OneDrive is listed, read or written.
 * - Refuses anything that is not a gpg-encrypted backup (name workfolio-<ts>.db.gz.gpg and an OpenPGP
 *   symmetric-key packet as the first byte): the database holds personal data and never leaves the VPS in
 *   the clear.
 * - The size Graph confirms must equal the local size, else the remote item is deleted and the command fails
 *   (backup-db.sh then fails the run: visible in `systemctl status workfolio-backup` and to monitor.sh).
 * - Off-site retention only when ONEDRIVE_BACKUP_KEEP_DAYS is set: older workfolio-*.db.gz.gpg items in that
 *   folder are moved to the OneDrive recycle bin after a successful upload. Unset: nothing is ever deleted.
 * Exit codes: 0 done, 1 failed, 2 refused (not configured, not connected, not an encrypted backup).
 * Output never contains a token, the client secret or the key file's content.
 */
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigService } from "@nestjs/config";
import { type Env, validateEnv } from "../config/env.js";
import { GraphStorage, StorageError } from "../screenshots/storage.js";
import { OneDriveService } from "../storage/onedrive.js";

const BACKUP_NAME = /^workfolio-(\d{4})(\d{2})(\d{2})T\d{6}Z\.db\.gz\.gpg$/;
const DAY_MS = 86_400_000;

/** OpenPGP packet tag 3 (symmetric-key encrypted session key): old format 0x8c–0x8f, new format 0xc3. */
async function looksEncrypted(file: string): Promise<boolean> {
  const fh = await open(file);
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(1), 0, 1, 0);
    return bytesRead === 1 && ((buffer[0]! & 0xfc) === 0x8c || buffer[0] === 0xc3);
  } finally {
    await fh.close();
  }
}

/** The backup's own timestamp (from its name), as a UTC date. */
const backupDate = (name: string) => {
  const m = BACKUP_NAME.exec(name);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

export async function run(argv: string[], rawEnv: NodeJS.ProcessEnv, out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [command, file] = argv;
  if (!["upload", "check", "list"].includes(command ?? "")) {
    out("usage: backup-upload.js upload <file.db.gz.gpg> | check | list");
    return 2;
  }
  const env = validateEnv(rawEnv);
  if (!env.ONEDRIVE_CLIENT_ID) {
    out("REFUSED: OneDrive is not configured (ONEDRIVE_* in the API environment)");
    return 2;
  }
  const folder = `${env.ONEDRIVE_ROOT_FOLDER}/${env.ONEDRIVE_BACKUP_FOLDER}`;
  let size = 0;
  if (command === "upload") {
    if (!file || !existsSync(file)) {
      out("REFUSED: no such file");
      return 2;
    }
    if (!BACKUP_NAME.test(basename(file)) || !(await looksEncrypted(file))) {
      out(`REFUSED: ${basename(file)} is not a gpg-encrypted backup (workfolio-<ts>.db.gz.gpg from backup-db.sh with BACKUP_GPG_PASSPHRASE_FILE set); unencrypted backups never leave the VPS`);
      return 2;
    }
    size = (await stat(file)).size;
  }

  // The API's own OneDrive connection, from the same env and token file; no Nest container needed.
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  const onedrive = new OneDriveService(config);
  const target = await onedrive.ensureSubfolder(env.ONEDRIVE_BACKUP_FOLDER);
  const { tenantId, clientId } = onedrive.cfg!;
  const storage = new GraphStorage({ tenantId, clientId, driveId: target.driveId, folderId: target.folderId, folder, permanentDelete: false }, undefined, undefined, undefined, {
    token: (fresh) => onedrive.token(fresh),
    target: async () => target,
  });
  out(`OneDrive: ${onedrive.cfg!.account}, folder ${folder}`);
  if (command === "check") return 0;

  const items = await listBackups(storage, target);
  if (command === "list") {
    for (const i of items) out(`${i.name}  ${i.size} bytes`);
    out(`${items.length} off-site backup(s)`);
    return 0;
  }

  const name = basename(file!);
  const stored = await storage.putFile(name, file!);
  if (stored.size !== size) {
    await storage.delete(name).catch(() => {});
    out(`FAILED: OneDrive confirmed ${stored.size} bytes for ${name}, local file is ${size}; remote copy removed`);
    return 1;
  }
  out(`uploaded ${name} (${size} bytes) to ${folder}`);

  const keep = env.ONEDRIVE_BACKUP_KEEP_DAYS;
  if (keep) {
    const cutoff = Date.now() - keep * DAY_MS;
    for (const i of items) {
      const at = backupDate(i.name);
      if (at === null || at >= cutoff || i.name === name) continue;
      await storage.delete(i.name);
      out(`removed off-site backup older than ${keep} days: ${i.name} (OneDrive recycle bin)`);
    }
  }
  return 0;
}

/** Children of the backup folder named like a backup (paged); nothing outside that folder is listed. */
async function listBackups(storage: GraphStorage, target: { driveId: string; folderId: string }): Promise<{ name: string; size: number }[]> {
  const found: { name: string; size: number }[] = [];
  let url: string | undefined = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.folderId)}/children?$select=name,size,folder&$top=200`;
  while (url) {
    const res = await storage.call("list", url);
    const page = (await res.json().catch(() => null)) as { value?: { name?: unknown; size?: unknown; folder?: unknown }[]; "@odata.nextLink"?: unknown } | null;
    if (!page || !Array.isArray(page.value)) throw new StorageError("Microsoft Graph list failed (invalid response)");
    for (const v of page.value) if (typeof v.name === "string" && BACKUP_NAME.test(v.name) && !v.folder) found.push({ name: v.name, size: typeof v.size === "number" ? v.size : 0 });
    url = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  try {
    process.exitCode = await run(process.argv.slice(2), process.env);
  } catch (err) {
    // StorageError messages carry Microsoft's error code only; anything else is reduced to its message.
    console.error(`Backup upload failed: ${String((err as Error).message ?? err)}`);
    process.exitCode = 1;
  }
}
