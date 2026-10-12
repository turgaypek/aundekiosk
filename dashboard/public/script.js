// script.js — wires the authenticated app view's URL list to /config.
// DOM-dependent, so (like i18n.js and auth.js) this is verified by manual
// QA in a real browser (spec §11), not a Deno unit test.

function renderUrlRow(entry) {
  const template = document.getElementById("template-url");
  const row = template.content.firstElementChild.cloneNode(true);
  const link = row.querySelector("a");
  link.href = entry.url;
  link.textContent = entry.url;
  row.dataset.duration = entry.duration;
  row.dataset.cycles = entry.cycles;
  row.querySelector(".remove-url").addEventListener("click", () => row.remove());
  return row;
}

async function loadConfig() {
  const list = document.querySelector("#urls ul");
  list.innerHTML = "";
  const res = await fetch("/config");
  if (!res.ok) return;
  const { urls } = await res.json();
  for (const entry of urls) {
    list.appendChild(renderUrlRow(entry));
  }
}

async function applyConfig() {
  const list = document.querySelector("#urls ul");
  const urls = [...list.children].map((row) => ({
    url: row.querySelector("a").href,
    duration: Number(row.dataset.duration) || 10,
    cycles: Number(row.dataset.cycles) || 0,
  }));
  const res = await fetch("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadConfig();
}

// AundeKiosk's own 4 systemd units — start/stop goes through
// /service-control, which requires re-entering the current dashboard
// password (step-up) even though the caller already holds a session,
// same as every other privileged action in this project.
const SERVICE_LABEL_KEYS = {
  "aundekiosk-dashboard": "service_name_dashboard",
  "aundekiosk-monitor": "service_name_monitor",
  "aundekiosk-runner": "service_name_runner",
  "aundekiosk-switcher": "service_name_switcher",
};

function serviceLabel(service) {
  const key = SERVICE_LABEL_KEYS[service];
  const translated = key && window.aundekiosk?.t ? window.aundekiosk.t(key) : null;
  return translated || service;
}

function renderServiceRow(service, status) {
  const template = document.getElementById("template-service");
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.service = service;
  row.querySelector(".service-name").textContent = serviceLabel(service);
  const badge = row.querySelector(".service-status");
  badge.textContent = status;
  badge.classList.add(status === "active" ? "bg-success" : "bg-secondary");
  row.querySelector(".service-start").addEventListener("click", () => toggleService(service, "start"));
  row.querySelector(".service-stop").addEventListener("click", () => toggleService(service, "stop"));
  return row;
}

async function loadServiceStatus() {
  const list = document.getElementById("services-list");
  if (!list) return;
  const res = await fetch("/service-status");
  if (!res.ok) return;
  const statuses = await res.json();
  list.innerHTML = "";
  for (const [service, status] of Object.entries(statuses)) {
    list.appendChild(renderServiceRow(service, status));
  }
}

async function toggleService(service, action) {
  // Stopping the dashboard cuts off the admin's own access immediately
  // — systemd's Restart=on-failure only fires on a crash, never on a
  // deliberate stop — so this needs an extra, explicit warning on top
  // of the step-up re-auth every other toggle already requires.
  if (service === "aundekiosk-dashboard" && action === "stop") {
    const warningKey = "service_stop_dashboard_warning";
    const warning = window.aundekiosk?.t ? window.aundekiosk.t(warningKey) : null;
    if (!confirm(warning || "Stopping the dashboard will cut off your own access until it is restarted via SSH or physical access. Continue?")) {
      return;
    }
  }
  const promptKey = "service_confirm_password_prompt";
  const promptText = window.aundekiosk?.t ? window.aundekiosk.t(promptKey) : null;
  const confirmPassword = prompt(promptText || "Re-enter your current password to confirm:");
  if (!confirmPassword) return;

  const res = await fetch("/service-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, action, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadServiceStatus();
}

if (typeof document !== "undefined") {
  document.getElementById("add-url")?.addEventListener("click", () => {
    const input = document.getElementById("new-url");
    const url = input.value.trim();
    if (!url) return;
    document.querySelector("#urls ul").appendChild(renderUrlRow({ url, duration: 10, cycles: 0 }));
    input.value = "";
  });

  document.getElementById("execute")?.addEventListener("click", applyConfig);

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.loadConfig = loadConfig;
  window.aundekiosk.loadServiceStatus = loadServiceStatus;
}
