#!/usr/bin/env node
// Check in-app updater packages the way the API does before a release reaches anyone, and the desktop updater
// does before it installs anything: the minisign signature next to each package (<package>.sig) must be made
// by the key whose PUBLIC half is in WORKFOLIO_UPDATER_PUBKEY, cover exactly these bytes, and be bound to the
// expected version. Same verifier as the API (apps/api/src/desktop-updates/minisign.ts). No private key here.
//
//   WORKFOLIO_UPDATER_PUBKEY=<base64 .pub> node verify-updater-signature.mjs <version> <package>...
import { readFileSync } from "node:fs";
import { blake2b, parsePublicKey, verifySignature } from "../../apps/api/src/desktop-updates/minisign.ts";

const [version, ...packages] = process.argv.slice(2);
if (!version || !packages.length || !process.env.WORKFOLIO_UPDATER_PUBKEY) {
  console.error("usage: WORKFOLIO_UPDATER_PUBKEY=<base64 .pub> verify-updater-signature.mjs <version> <package>...");
  process.exit(2);
}
const pub = parsePublicKey(process.env.WORKFOLIO_UPDATER_PUBKEY);
for (const file of packages) {
  const bytes = readFileSync(file);
  const signed = verifySignature(pub, readFileSync(`${file}.sig`, "utf8"), { blake2b: blake2b().update(bytes).digest(), bytes });
  if (signed !== version) throw new Error(`${file}: signed for version ${signed}, expected ${version}`);
  console.log(`${file}: signature valid (key ${pub.keyId}), bound to version ${signed}`);
}
