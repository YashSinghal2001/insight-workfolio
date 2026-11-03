import { apiBaseOf, originPatternOf } from "./tracker.js";

const $ = (s) => document.querySelector(s);
const tick = () => chrome.runtime.sendMessage({ type: "tick" });

async function render() {
  const { token, employee, lastState, lastUpload, queue = [] } = await chrome.storage.local.get(["token", "employee", "lastState", "lastUpload", "queue"]);
  $("#connect").hidden = !!token;
  $("#connected").hidden = !token;
  if (!token) {
    $("#status").textContent = "Not connected. Nothing is recorded.";
    return;
  }
  $("#who").textContent = employee ? `Connected as ${employee.fullName} (${employee.employeeCode}).` : "Connected.";
  $("#status").className = lastState?.collect ? "on" : "";
  $("#status").textContent = lastState?.collect ? "Recording website domain names." : "Not recording.";
  $("#reasons").textContent = lastState?.collect ? "" : (lastState?.reasons ?? ["Waiting for the server."]).join(" ");
  $("#queue").textContent = `${queue.length} interval(s) waiting to be sent.${lastUpload?.error ? ` ${lastUpload.error}` : ""}`;
}

$("#connect").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#error").textContent = "";
  const f = e.target;
  try {
    const apiBase = apiBaseOf(f.apiBase.value);
    // Ask for exactly this server's origin, nothing broader. The request must be the first await
    // (it needs the click's user gesture); the manifest's dev origin is already granted.
    const origins = [originPatternOf(apiBase)];
    if (!chrome.runtime.getManifest().host_permissions.includes(origins[0]) && !(await chrome.permissions.request({ origins }))) {
      throw new Error(`permission to reach ${new URL(apiBase).origin} was not granted. Click Connect again and choose Allow; nothing is recorded until then.`);
    }
    const res = await fetch(`${apiBase}/api/v1/websites/extension/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: f.code.value, label: f.label.value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
    await chrome.storage.local.set({ token: body.token, employee: body.employee, apiBase, queue: [], lastUpload: null });
    await tick();
  } catch (err) {
    $("#error").textContent = `Could not connect: ${err.message}`;
  }
  await render();
});
$("#send").addEventListener("click", async () => (await tick(), render()));
$("#disconnect").addEventListener("click", async () => {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  await fetch(`${apiBase}/api/v1/websites/extension/disconnect`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  await chrome.storage.local.remove(["token", "employee", "queue", "lastState", "lastUpload"]);
  if (apiBase) {
    const origins = [originPatternOf(apiBase)];
    if (!chrome.runtime.getManifest().host_permissions.includes(origins[0])) await chrome.permissions.remove({ origins }).catch(() => null);
  }
  await tick();
  await render();
});
chrome.storage.onChanged.addListener(() => void render());
void tick().then(render, render);
void render();
