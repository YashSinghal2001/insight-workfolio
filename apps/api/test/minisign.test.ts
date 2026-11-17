// The API's minisign check must accept exactly what the Tauri CLI writes. The fixture below was produced by
// `tauri signer sign --app-version 1.2.3` (CLI 2.12.2) with a throwaway key; only its PUBLIC half is here.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

const { parsePublicKey, verifySignature } = await import("../dist/desktop-updates/minisign.js");

const PUB =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY5RjIwQTMzMzJBRTJGMDEKUldRQkw2NHlNd3J5YWNHV3JFNTQ3UFhpamhMRC9DSlBUNXJ5RXRnZ0RCQjluRFl2d2F3MHFrcmcK";
const SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRQkw2NHlNd3J5YWFnRTQ5UkZXdXRPcmVDMStpZmc1YnFXU0VzOFJYU3NsSDJPRlp3MTVUSTRPOHM3Tks3Uk45U3RxdnNaWFhiQnh3UVEwV3FGSG5wbGhEWDZSVGl4RkFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0ODkxODY5CWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoxLjIuMwpMRXhXR1I2a3dOYkE5VEVldHdueU4zbUNpSjIrSnlWWG9qblBvMXlOOHJBNitLWGNMczNYcVZJRytQNGgra2pXb3Q3SUM3RHh5WTdlbVQ2R1AvOUVDZz09Cg==";
const PAYLOAD = Buffer.from("hello updater fixture\n");
const digest = (b: Buffer) => ({ blake2b: createHash("blake2b512").update(b).digest(), bytes: b });

test("accepts a real Tauri CLI signature and returns the version it is bound to", () => {
  const pub = parsePublicKey(PUB);
  assert.equal(pub.keyId, "69F20A3332AE2F01");
  assert.equal(verifySignature(pub, SIG, digest(PAYLOAD)), "1.2.3");
});

test("refuses a modified file, an altered trusted comment and another key", () => {
  const pub = parsePublicKey(PUB);
  assert.throws(() => verifySignature(pub, SIG, digest(Buffer.from("hello updater fixturE\n"))), /does not match the file/);
  // Same signature, trusted comment rewritten to claim another version: the global signature fails.
  const text = Buffer.from(SIG, "base64").toString("utf8").replace("version:1.2.3", "version:9.9.9");
  assert.throws(() => verifySignature(pub, Buffer.from(text).toString("base64"), digest(PAYLOAD)), /trusted comment was altered/);
  // A different key (QA vs production): refused by key id before any crypto.
  const { publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const other = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 7), x]);
  const otherPub = Buffer.from(`untrusted comment: minisign public key\n${other.toString("base64")}\n`).toString("base64");
  assert.throws(() => verifySignature(parsePublicKey(otherPub), SIG, digest(PAYLOAD)), /Signed with key 69F20A3332AE2F01, but this server expects key 0707070707070707/);
  assert.throws(() => parsePublicKey(Buffer.from("not a key").toString("base64")), /Not a minisign/);
});

/** A Tauri-format (prehashed) signature made in-process, for tests that need their own keys. */
export function signLikeTauri(privateKey: Parameters<typeof sign>[2], keyIdLE: Buffer, file: Buffer, version: string) {
  const sig = sign(null, createHash("blake2b512").update(file).digest(), privateKey);
  const trusted = `timestamp:1\tfile:app.tar.gz\tversion:${version}`;
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
  const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), keyIdLE, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
  return Buffer.from(text).toString("base64");
}

test("an in-process signature in the Tauri format verifies the same way", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const raw = Buffer.concat([Buffer.from("Ed"), id, Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")]);
  const pub = parsePublicKey(Buffer.from(`untrusted comment: k\n${raw.toString("base64")}\n`).toString("base64"));
  const file = Buffer.from("package");
  assert.equal(verifySignature(pub, signLikeTauri(privateKey, id, file, "0.3.0"), digest(file)), "0.3.0");
});
