import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error -- plain .mjs script without type declarations
import { environmentIdentity, placeholderHost, releaseConfig, releaseDashboardUrl, signingPlan, tauriBuildArgs, updaterPlan, windowsSigningPlan } from "../scripts/desktop-config.mjs";

test("WORKFOLIO_ENV: production keeps tauri.conf.json's identity, staging gets its own identifier, name and keychain service", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const raw of [undefined, "", " production "]) {
    const prod = environmentIdentity(raw);
    assert.equal(prod.env, "production");
    assert.equal(prod.identifier, conf.identifier, "existing installs keep their identifier");
    assert.equal(prod.productName, conf.productName);
    assert.equal(prod.keychainService, conf.identifier);
    assert.ok(rust.includes(`None => "${prod.keychainService}"`), "the Rust default keychain service is the production identifier");
  }
  const staging = environmentIdentity("staging");
  assert.deepEqual(staging, {
    env: "staging",
    identifier: "com.insightworkfolio.desktop.staging",
    productName: "Insight Workfolio Staging",
    keychainService: "com.insightworkfolio.desktop.staging",
  });
  for (const bad of ["Staging", "dev", "prod", "toString", "__proto__"]) assert.throws(() => environmentIdentity(bad), /staging or production/, bad);
});

test("a placeholder (.invalid) API always builds the separate test identity, and a real API never does", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const placeholder = "https://api.example.invalid";
  const testIdentity = {
    env: "test",
    identifier: "com.insightworkfolio.desktop.test",
    productName: "Insight Workfolio Test",
    keychainService: "com.insightworkfolio.desktop.test",
  };
  for (const raw of [undefined, "", "test"]) assert.deepEqual(environmentIdentity(raw, placeholder), testIdentity, String(raw));
  for (const env of ["production", "staging"]) assert.throws(() => environmentIdentity(env, placeholder), /always gets the test identity/, env);
  // A real API: exactly as before, and "test" is refused.
  assert.equal(environmentIdentity(undefined, "https://api.example.com").identifier, conf.identifier);
  assert.equal(environmentIdentity("production", "https://api.example.com").productName, conf.productName);
  assert.equal(environmentIdentity("staging", "https://api.example.com").identifier, "com.insightworkfolio.desktop.staging");
  assert.throws(() => environmentIdentity("test", "https://api.example.com"), /placeholder API/);
  assert.throws(() => environmentIdentity("test"), /placeholder API/);
  assert.equal(environmentIdentity(undefined, "https://invalid.example.com").env, "production", "only the .invalid TLD is the placeholder");
  // Three identities, no shared identifier, name or keychain service.
  const all = [environmentIdentity("production"), environmentIdentity("staging"), testIdentity];
  for (const key of ["identifier", "productName", "keychainService"]) assert.equal(new Set(all.map((i) => i[key])).size, 3, key);
});

test("release dashboard URL: https and required, except the CI placeholder API on the reserved .invalid TLD", () => {
  assert.equal(releaseDashboardUrl("https://app.acme.test/", "https://api.acme.test"), "https://app.acme.test");
  assert.throws(() => releaseDashboardUrl(undefined, "https://api.example.com"), /not set/);
  assert.throws(() => releaseDashboardUrl("  ", "https://api.example.com"), /not set/);
  assert.throws(() => releaseDashboardUrl("http://localhost:3000", "https://api.example.com"), /https/);
  assert.throws(() => releaseDashboardUrl("http://app.example.com", "https://api.example.com"), /https/);
  assert.equal(releaseDashboardUrl(undefined, "https://api.example.invalid"), "https://app.example.invalid", "CI test installer keeps building");
  assert.equal(releaseDashboardUrl("https://app.example.com", "https://api.example.invalid"), "https://app.example.com");
  assert.throws(() => releaseDashboardUrl(undefined, "https://invalid.example.com"), /not set/, "only the .invalid TLD is exempt");
});

test("release builds refuse documentation placeholders; CI's .invalid test build still builds", () => {
  const csp = "default-src 'self'; connect-src 'self' ipc: http://localhost:4000";
  for (const url of [
    "https://api.example.com", "https://api.example.net", "https://api.example.org", "https://example.com",
    "https://API.Example.COM/", "https://deep.api.example.org:8443/v1", "https://api.example.com.",
  ]) {
    assert.throws(() => releaseConfig(url, csp), /documentation example domain/, url);
    assert.throws(() => releaseDashboardUrl(url, "https://api.acme.test"), /documentation example domain/, url);
  }
  // Empty and malformed values are refused before the placeholder check.
  for (const url of [undefined, "", "  ", "not a url", "http://api.acme.test", "ftp://api.acme.test"]) {
    assert.throws(() => releaseConfig(url, csp), /URL/, String(url));
  }
  // .invalid: a real API may not point administrators at a placeholder dashboard...
  assert.throws(() => releaseDashboardUrl("https://app.example.invalid", "https://api.acme.test"), /\.invalid test placeholder/);
  // ...but CI's test installer (separate test identity, see environmentIdentity) keeps building.
  assert.equal(releaseConfig("https://api.example.invalid", csp).origin, "https://api.example.invalid");
  assert.equal(environmentIdentity(undefined, "https://api.example.invalid").env, "test");
  // Real hosts, including look-alikes and bare IPs, are accepted.
  for (const url of ["https://189.72.144.117", "https://api.acme.test", "https://notexample.com", "https://example.com.au", "https://example.co"]) {
    assert.equal(placeholderHost(url), null, url);
    assert.equal(releaseConfig(url, csp).apiUrl, url);
  }
  assert.match(releaseConfig("https://189.72.144.117", csp).config.app.security.csp, /connect-src 'self' ipc: https:\/\/189\.72\.144\.117$/);
});

test("signing is optional, and a half-configured signing/notarization setup is refused", () => {
  assert.deepEqual(signingPlan({}), { identity: null, notarize: false }, "unsigned by default");
  const id = "Developer ID Application: Example Ltd (ABCDE12345)";
  assert.deepEqual(signingPlan({ APPLE_SIGNING_IDENTITY: id }), { identity: id, notarize: false });
  assert.deepEqual(signingPlan({ APPLE_SIGNING_IDENTITY: "-" }), { identity: "-", notarize: false }, "ad-hoc");
  const apiKey = { APPLE_API_KEY: "K", APPLE_API_ISSUER: "I", APPLE_API_KEY_PATH: "/k.p8" };
  assert.deepEqual(signingPlan({ APPLE_SIGNING_IDENTITY: id, ...apiKey }), { identity: id, notarize: true });
  assert.deepEqual(signingPlan({ APPLE_SIGNING_IDENTITY: id, APPLE_ID: "a@b.c", APPLE_PASSWORD: "p", APPLE_TEAM_ID: "T" }).notarize, true);

  assert.throws(() => signingPlan(apiKey), /APPLE_SIGNING_IDENTITY/, "cannot notarize an unsigned build");
  assert.throws(() => signingPlan({ APPLE_SIGNING_IDENTITY: id, APPLE_ID: "a@b.c" }), /missing APPLE_PASSWORD, APPLE_TEAM_ID/);
  assert.throws(() => signingPlan({ APPLE_SIGNING_IDENTITY: id, APPLE_API_KEY: "K" }), /APPLE_API_ISSUER/);
  assert.throws(() => signingPlan({ APPLE_SIGNING_IDENTITY: "Apple Development: x" }), /Developer ID Application/);
  assert.throws(() => signingPlan({ APPLE_SIGNING_IDENTITY: id, APPLE_CERTIFICATE: "base64" }), /PASSWORD/);
  assert.throws(() => signingPlan({ APPLE_CERTIFICATE: "b", APPLE_CERTIFICATE_PASSWORD: "p" }), /needs APPLE_SIGNING_IDENTITY/);
});

test("Windows signing: unsigned by default, a certificate thumbprint or Azure Trusted Signing, never half-configured", () => {
  assert.equal(windowsSigningPlan({}), null, "unsigned by default");
  const thumb = "ab12".repeat(10);
  const ts = "http://timestamp.digicert.com";
  assert.deepEqual(windowsSigningPlan({ WINDOWS_CERTIFICATE_THUMBPRINT: thumb, WINDOWS_TIMESTAMP_URL: ts }), {
    method: "certificate",
    config: { certificateThumbprint: thumb.toUpperCase(), digestAlgorithm: "sha256", timestampUrl: ts, tsp: false },
  });
  assert.equal(windowsSigningPlan({ WINDOWS_CERTIFICATE_THUMBPRINT: `${thumb.slice(0, 20)} ${thumb.slice(20)}`, WINDOWS_TIMESTAMP_URL: ts, WINDOWS_TIMESTAMP_TSP: "1" }).config.tsp, true);
  assert.throws(() => windowsSigningPlan({ WINDOWS_CERTIFICATE_THUMBPRINT: thumb }), /go together/, "no timestamp");
  assert.throws(() => windowsSigningPlan({ WINDOWS_TIMESTAMP_URL: ts }), /go together/);
  assert.throws(() => windowsSigningPlan({ WINDOWS_CERTIFICATE_THUMBPRINT: "abc", WINDOWS_TIMESTAMP_URL: ts }), /40 hex/);
  assert.throws(() => windowsSigningPlan({ WINDOWS_CERTIFICATE_THUMBPRINT: thumb, WINDOWS_TIMESTAMP_URL: "digicert" }), /timestamp server/);

  const azure = {
    AZURE_TRUSTED_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
    AZURE_TRUSTED_SIGNING_ACCOUNT: "acct",
    AZURE_TRUSTED_SIGNING_PROFILE: "prof",
    AZURE_CLIENT_ID: "c",
    AZURE_CLIENT_SECRET: "secret-value-123",
    AZURE_TENANT_ID: "t",
  };
  const plan = windowsSigningPlan(azure);
  assert.equal(plan.method, "azure-trusted-signing");
  assert.equal(plan.config.signCommand.cmd, "trusted-signing-cli");
  assert.ok(plan.config.signCommand.args.includes("%1"));
  assert.ok(!JSON.stringify(plan).includes("secret-value-123"), "the client secret is never written to the config");
  assert.throws(() => windowsSigningPlan({ ...azure, AZURE_CLIENT_SECRET: "" }), /missing AZURE_CLIENT_SECRET/);
  assert.throws(() => windowsSigningPlan({ AZURE_TRUSTED_SIGNING_ENDPOINT: "x" }), /must all be set/);
  assert.throws(() => windowsSigningPlan({ ...azure, WINDOWS_CERTIFICATE_THUMBPRINT: thumb, WINDOWS_TIMESTAMP_URL: ts }), /choose one/);
});

test("tauriBuildArgs: pnpm's leading `--` is dropped so --bundles reaches tauri build, not cargo", () => {
  const base = ["exec", "tauri", "build", "--config", "f.json"];
  // CI: `pnpm --filter @workfolio/desktop package -- --bundles nsis` arrives as ["--", "--bundles", "nsis"].
  assert.deepEqual(tauriBuildArgs("f.json", ["--", "--bundles", "nsis"]), [...base, "--bundles", "nsis"]);
  // macOS docs form, no separator: unchanged.
  assert.deepEqual(tauriBuildArgs("f.json", ["--bundles", "app,dmg"]), [...base, "--bundles", "app,dmg"]);
  assert.deepEqual(tauriBuildArgs("f.json", []), base);
  // A deliberate second `--` still forwards Cargo args.
  assert.deepEqual(tauriBuildArgs("f.json", ["--", "--bundles", "nsis", "--", "--features", "x"]), [...base, "--bundles", "nsis", "--", "--features", "x"]);
  assert.ok(!tauriBuildArgs("f.json", ["--", "--bundles", "nsis"]).slice(base.length).includes("--"), "no `--` before --bundles");
});

test("updater: off without a public key; with one it needs the private signing key, requires signed versions and points at the API", () => {
  // A throwaway public key (key id 69F20A3332AE2F01); public keys are not secret.
  const PUB = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY5RjIwQTMzMzJBRTJGMDEKUldRQkw2NHlNd3J5YWNHV3JFNTQ3UFhpamhMRC9DSlBUNXJ5RXRnZ0RCQjluRFl2d2F3MHFrcmcK";
  assert.equal(updaterPlan({}, "https://api.example.com"), null);
  assert.throws(() => updaterPlan({ WORKFOLIO_UPDATER_PUBKEY: PUB }, "https://api.example.com"), /TAURI_SIGNING_PRIVATE_KEY/);
  assert.throws(() => updaterPlan({ WORKFOLIO_UPDATER_PUBKEY: "bm90IGEga2V5", TAURI_SIGNING_PRIVATE_KEY: "x" }, "https://api.example.com"), /base64 content of the .pub file/);
  assert.throws(() => updaterPlan({ WORKFOLIO_UPDATER_PUBKEY: PUB, TAURI_SIGNING_PRIVATE_KEY_PATH: "/k" }, "https://api.example.com"), /TAURI_SIGNING_PRIVATE_KEY/, "tauri build ignores _PATH");
  const plan = updaterPlan({ WORKFOLIO_UPDATER_PUBKEY: PUB, TAURI_SIGNING_PRIVATE_KEY: "/k" }, "https://api.example.com");
  assert.equal(plan.keyId, "69F20A3332AE2F01");
  assert.deepEqual(plan.config, {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: PUB,
        endpoints: ["https://api.example.com/api/v1/desktop-updates/manifest/{{target}}/{{arch}}/{{current_version}}"],
        requireSignedVersion: true,
        windows: { installMode: "passive" },
      },
    },
  });
  // The committed config has no updater: dev builds and CI test installers never check for updates.
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(conf.plugins?.updater, undefined);
  assert.equal(conf.bundle.createUpdaterArtifacts, undefined);
});
