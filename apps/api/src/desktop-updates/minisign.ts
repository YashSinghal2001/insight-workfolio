// Minisign verification of Tauri updater signatures, the same check the desktop updater makes before it
// installs anything. The API runs it before a release reaches anyone, so a wrong key, a mismatched file or
// a signature bound to another version is refused at publish time instead of failing on every desktop.
import { createHash, createPublicKey, verify } from "node:crypto";

const b64text = (b64: string) => Buffer.from(b64.trim(), "base64").toString("utf8");
const lines = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, ""));

export interface PublicKey {
  keyId: string;
  key: ReturnType<typeof createPublicKey>;
}

/** The base64 public key from tauri.conf.json (`plugins.updater.pubkey`), i.e. a base64 minisign .pub file. */
export function parsePublicKey(b64: string): PublicKey {
  const line = lines(b64text(b64)).find((l) => l && !l.startsWith("untrusted comment:"));
  const raw = Buffer.from(line ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("Not a minisign Ed25519 public key");
  const x = raw.subarray(10).toString("base64url");
  return { keyId: hexId(raw.subarray(2, 10)), key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }) };
}

/** Key ids print as minisign does: the 8 little-endian bytes as one hex number. */
const hexId = (b: Buffer) => Buffer.from(b).reverse().toString("hex").toUpperCase();

export interface Signature {
  keyId: string;
  prehashed: boolean;
  sig: Buffer;
  trustedComment: string;
  globalSig: Buffer;
}

/** The base64 `.sig` content written by the Tauri CLI. */
export function parseSignature(b64: string): Signature {
  const l = lines(b64text(b64));
  const raw = Buffer.from(l[1] ?? "", "base64");
  const alg = raw.subarray(0, 2).toString();
  if (raw.length !== 74 || (alg !== "ED" && alg !== "Ed")) throw new Error("Not a minisign signature");
  if (!l[2]?.startsWith("trusted comment: ")) throw new Error("The signature has no trusted comment");
  const globalSig = Buffer.from(l[3] ?? "", "base64");
  if (globalSig.length !== 64) throw new Error("The signature's trusted comment is not signed");
  return { keyId: hexId(raw.subarray(2, 10)), prehashed: alg === "ED", sig: raw.subarray(10), trustedComment: l[2].slice("trusted comment: ".length), globalSig };
}

/** `version:x.y.z` from the trusted comment (written by `tauri build` / `tauri signer sign --app-version`). */
export const signedVersion = (s: Signature) => s.trustedComment.split("\t").find((f) => f.startsWith("version:"))?.slice("version:".length) ?? null;

/**
 * Checks the signature over the file digest (`ED`: BLAKE2b-512 of the file, what Tauri writes) or the
 * file bytes (`Ed`, legacy), then the global signature over the trusted comment, and returns the signed
 * version. Throws with a reason an administrator can act on.
 */
export function verifySignature(pub: PublicKey, sigB64: string, file: { blake2b: Buffer; bytes?: Buffer }): string | null {
  const s = parseSignature(sigB64);
  if (s.keyId !== pub.keyId) throw new Error(`Signed with key ${s.keyId}, but this server expects key ${pub.keyId}`);
  const message = s.prehashed ? file.blake2b : file.bytes;
  if (!message) throw new Error("Legacy (non-prehashed) signatures are not supported");
  if (!verify(null, message, pub.key, s.sig)) throw new Error("The signature does not match the file");
  if (!verify(null, Buffer.concat([s.sig, Buffer.from(s.trustedComment, "utf8")]), pub.key, s.globalSig)) throw new Error("The signature's trusted comment was altered");
  return signedVersion(s);
}

export const blake2b = () => createHash("blake2b512");
