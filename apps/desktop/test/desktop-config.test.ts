import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error -- plain .mjs script without type declarations
import { environmentIdentity, releaseDashboardUrl, signingPlan, windowsSigningPlan } from "../scripts/desktop-config.mjs";

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

test("release dashboard URL: https and required, except the CI placeholder API on the reserved .invalid TLD", () => {
  assert.equal(releaseDashboardUrl("https://app.example.com/", "https://api.example.com"), "https://app.example.com");
  assert.throws(() => releaseDashboardUrl(undefined, "https://api.example.com"), /not set/);
  assert.throws(() => releaseDashboardUrl("  ", "https://api.example.com"), /not set/);
  assert.throws(() => releaseDashboardUrl("http://localhost:3000", "https://api.example.com"), /https/);
  assert.throws(() => releaseDashboardUrl("http://app.example.com", "https://api.example.com"), /https/);
  assert.equal(releaseDashboardUrl(undefined, "https://api.example.invalid"), "https://app.example.invalid", "CI test installer keeps building");
  assert.equal(releaseDashboardUrl("https://app.example.com", "https://api.example.invalid"), "https://app.example.com");
  assert.throws(() => releaseDashboardUrl(undefined, "https://invalid.example.com"), /not set/, "only the .invalid TLD is exempt");
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
