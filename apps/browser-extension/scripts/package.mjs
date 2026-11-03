// Zips the files Chrome loads (no tests, scripts or package.json) into dist/insight-workfolio-extension-<version>.zip.
// ponytail: shells out to the `zip` CLI (macOS/Linux); use a zip library or PowerShell Compress-Archive on Windows.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const files = ["manifest.json", "background.js", "popup.html", "popup.js", "tracker.js", "icons"];
const out = join(root, "dist", `insight-workfolio-extension-${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", "-q", out, ...files], { cwd: root, stdio: "inherit" });
console.log(out);
