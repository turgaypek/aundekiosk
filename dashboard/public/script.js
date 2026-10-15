// script.js — wires the authenticated app view's URL list to /config.
// DOM-dependent, so (like i18n.js and auth.js) this is verified by manual
// QA in a real browser (spec §11), not a Deno unit test.

let _urlDragSrc = null;

function renderUrlRow(entry) {
  const template = document.getElementById("template-url");
  const row = template.content.firstElementChild.cloneNode(true);
  const link = row.querySelector("a");
  link.href = entry.url;
  link.textContent = entry.url;
  row.querySelector(".url-duration").value = entry.duration;
  row.dataset.cycles = entry.cycles;
  // Translates this row's own data-i18n elements (the Remove button) —
  // i18n.js's one-time page-load scan never reaches content cloned out
  // of a <template> well after that scan already ran.
  window.aundekiosk?.translateSubtree?.(row);
  row.querySelector(".remove-url").addEventListener("click", () => row.remove());

  row.addEventListener("dragstart", (e) => {
    _urlDragSrc = row;
    e.dataTransfer.effectAllowed = "move";
    // Defer the opacity change so the drag ghost image is captured first.
    setTimeout(() => row.classList.add("opacity-50"), 0);
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("opacity-50");
    document.querySelectorAll("#urls ul li.url-drag-over")
      .forEach((r) => r.classList.remove("url-drag-over"));
    _urlDragSrc = null;
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (_urlDragSrc && _urlDragSrc !== row) row.classList.add("url-drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("url-drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("url-drag-over");
    if (!_urlDragSrc || _urlDragSrc === row) return;
    const list = row.parentNode;
    const srcIdx = [...list.children].indexOf(_urlDragSrc);
    const dstIdx = [...list.children].indexOf(row);
    list.insertBefore(_urlDragSrc, srcIdx < dstIdx ? row.nextSibling : row);
  });

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
    duration: Number(row.querySelector(".url-duration").value) || 10,
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
  window.aundekiosk?.translateSubtree?.(row);
  // Overwrites the just-translated placeholder text with the real
  // (non-i18n — it's an opaque service identifier, not UI copy) name.
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
  // deliberate stop — so this still needs an explicit warning, even
  // though toggling no longer requires re-entering a password.
  if (service === "aundekiosk-dashboard" && action === "stop") {
    const warning = window.aundekiosk?.t?.("service_stop_dashboard_warning");
    if (!confirm(warning || "Stopping the dashboard will cut off your own access until it is restarted via SSH or physical access. Continue?")) {
      return;
    }
  }

  const res = await fetch("/service-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, action }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadServiceStatus();
}

function renderTierRow(tier) {
  const template = document.getElementById("template-tier");
  const row = template.content.firstElementChild.cloneNode(true);
  // Translates the Remove button and the <option> labels (the template's
  // own data-i18n attributes) — see renderUrlRow's comment on why a
  // cloned template's content needs this instead of the page-load scan.
  window.aundekiosk?.translateSubtree?.(row);
  row.querySelector(".tier-threshold").value = tier.threshold;
  row.querySelector(".tier-samples").value = tier.sustainedSamples;
  row.querySelector(".tier-action").value = tier.action;
  row.querySelector(".tier-cooldown").value = tier.cooldownSeconds;
  row.querySelector(".remove-tier").addEventListener("click", () => row.remove());
  return row;
}

async function loadMonitorConfig() {
  const intervalInput = document.getElementById("monitor-interval");
  if (!intervalInput) return;
  const res = await fetch("/monitor-config");
  if (!res.ok) return;
  const cfg = await res.json();
  intervalInput.value = cfg.sampleIntervalSeconds;
  document.getElementById("monitor-window-start").value = cfg.activeWindow?.start ?? "";
  document.getElementById("monitor-window-end").value = cfg.activeWindow?.end ?? "";
  const list = document.getElementById("monitor-tiers");
  list.innerHTML = "";
  for (const tier of cfg.tiers) {
    list.appendChild(renderTierRow(tier));
  }
}

async function saveMonitorConfig() {
  const sampleIntervalSeconds = Number(document.getElementById("monitor-interval").value) || 10;
  const start = document.getElementById("monitor-window-start").value;
  const end = document.getElementById("monitor-window-end").value;
  const activeWindow = start && end ? { start, end } : null;
  const tiers = [...document.querySelectorAll("#monitor-tiers > li")].map((row) => ({
    threshold: Number(row.querySelector(".tier-threshold").value),
    sustainedSamples: Number(row.querySelector(".tier-samples").value),
    action: row.querySelector(".tier-action").value,
    cooldownSeconds: Number(row.querySelector(".tier-cooldown").value),
  }));
  const res = await fetch("/monitor-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sampleIntervalSeconds, activeWindow, tiers }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadMonitorConfig();
}

const MONITOR_EVENT_LOCALE_BY_LANG = { tr: "tr-TR", en: "en-US", de: "de-DE" };

// Each tier's threshold applies to CPU and RAM independently (same
// number, two separate checks — see monitor/resource-monitor.sh) with
// no other way for an admin to tell which one actually fired, since the
// dashboard's tier rows only ever show the configured threshold, never
// a live reading. This renders monitor/resource-monitor.sh's own audit
// trail (via GET /monitor-events) into a plain sentence per event.
function formatMonitorEvent(event) {
  const lang = document.getElementById("lang-switch")?.value || "tr";
  const locale = MONITOR_EVENT_LOCALE_BY_LANG[lang] || lang;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(event.timestamp));
  const action = window.aundekiosk?.t?.(`monitor_action_${event.action}`) ?? event.action;

  if (event.event === "threshold_triggered") {
    const metric = event.metric === "cpu" ? "CPU" : event.metric === "ram" ? "RAM" : event.metric;
    return window.aundekiosk?.t?.("monitor_event_threshold_triggered", { time, metric, value: event.value, threshold: event.threshold, action });
  }
  if (event.event === "action_executed") {
    return window.aundekiosk?.t?.("monitor_event_action_executed", { time, action });
  }
  if (event.event === "action_suppressed_startup_grace") {
    return window.aundekiosk?.t?.("monitor_event_action_suppressed", { time, action });
  }
  return `${time} — ${event.event}`;
}

async function loadMonitorEvents() {
  const list = document.getElementById("monitor-events-list");
  if (!list) return;
  const res = await fetch("/monitor-events");
  if (!res.ok) return;
  const events = await res.json();
  list.innerHTML = "";
  document.getElementById("monitor-events-empty").hidden = events.length > 0;
  for (const event of events) {
    const li = document.createElement("li");
    li.className = "list-group-item";
    li.textContent = formatMonitorEvent(event);
    list.appendChild(li);
  }
}

// --- System / Remote Access -------------------------------------------
// SSH/VNC toggles, hostname, network, SNMP, and the OS password all go
// through step-up re-authentication on the backend (unlike the
// AundeKiosk service toggles above) — these are genuinely sensitive
// system-level changes, not "restart one of our own four units". A
// prompt() for the current password, right before the request, is the
// simplest honest UI for that: the admin always sees exactly what
// they're about to do before they're asked to confirm it.
function promptForStepUp() {
  const text = window.aundekiosk?.t?.("step_up_password_prompt");
  return prompt(text || "Re-enter your current password to confirm:");
}

const REMOTE_ACCESS_LABEL_KEYS = { ssh: "remote_access_name_ssh", vnc: "remote_access_name_vnc" };

function renderRemoteAccessRow(service, status) {
  const template = document.getElementById("template-remote-access");
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.service = service;
  window.aundekiosk?.translateSubtree?.(row);
  const key = REMOTE_ACCESS_LABEL_KEYS[service];
  row.querySelector(".remote-access-name").textContent = (key && window.aundekiosk?.t?.(key)) || service;
  const badge = row.querySelector(".remote-access-status");
  badge.textContent = status;
  badge.classList.add(status === "active" ? "bg-success" : "bg-secondary");
  row.querySelector(".remote-access-enable").addEventListener("click", () => toggleRemoteAccess(service, "enable"));
  row.querySelector(".remote-access-disable").addEventListener("click", () => toggleRemoteAccess(service, "disable"));
  return row;
}

async function loadRemoteAccessStatus() {
  const list = document.getElementById("remote-access-list");
  if (!list) return;
  const res = await fetch("/remote-access-status");
  if (!res.ok) return;
  const statuses = await res.json();
  list.innerHTML = "";
  for (const [service, status] of Object.entries(statuses)) {
    list.appendChild(renderRemoteAccessRow(service, status));
  }
}

async function toggleRemoteAccess(service, action) {
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch(service === "ssh" ? "/ssh-config" : "/vnc-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadRemoteAccessStatus();
}

async function saveHostname() {
  const hostname = document.getElementById("hostname-input").value.trim();
  if (!hostname) return;
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/hostname-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
}

function updateNetworkFieldVisibility() {
  const mode = document.getElementById("network-mode").value;
  const iface = document.getElementById("network-interface").value;
  document.getElementById("network-static-fields").hidden = mode !== "static";
  document.getElementById("network-wifi-fields").hidden = iface !== "wlan0";
}

let networkConfirmTimer = null;

function showNetworkConfirmButton() {
  const button = document.getElementById("network-confirm");
  button.hidden = false;
  let secondsLeft = 60;
  const labelKey = "network_confirm_button_countdown";
  const render = () => {
    button.textContent = window.aundekiosk?.t?.(labelKey, { seconds: secondsLeft }) ?? `Confirm (${secondsLeft}s)`;
  };
  render();
  clearInterval(networkConfirmTimer);
  networkConfirmTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      clearInterval(networkConfirmTimer);
      button.hidden = true;
      return;
    }
    render();
  }, 1000);
}

async function applyNetworkConfig() {
  const iface = document.getElementById("network-interface").value;
  const mode = document.getElementById("network-mode").value;
  const payload = {
    interface: iface,
    mode,
    staticIp: mode === "static" ? document.getElementById("network-static-ip").value.trim() : null,
    gateway: mode === "static" ? document.getElementById("network-gateway").value.trim() : null,
    dns: mode === "static" ? document.getElementById("network-dns").value.trim() : null,
    wifiSsid: iface === "wlan0" ? document.getElementById("network-wifi-ssid").value.trim() : null,
    wifiPassword: iface === "wlan0" ? document.getElementById("network-wifi-password").value : null,
  };
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/network-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) showNetworkConfirmButton();
}

async function confirmNetworkConfig() {
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/network-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) {
    clearInterval(networkConfirmTimer);
    document.getElementById("network-confirm").hidden = true;
  }
}

async function saveSnmpConfig() {
  const enabled = document.getElementById("snmp-enabled").checked;
  const payload = enabled
    ? {
        enabled: true,
        username: document.getElementById("snmp-username").value.trim(),
        authProtocol: document.getElementById("snmp-auth-protocol").value,
        authPassphrase: document.getElementById("snmp-auth-passphrase").value,
        privProtocol: document.getElementById("snmp-priv-protocol").value,
        privPassphrase: document.getElementById("snmp-priv-passphrase").value,
        allowedSource: document.getElementById("snmp-allowed-source").value.trim(),
      }
    : { enabled: false };
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/snmp-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
}

async function saveOsPassword() {
  const newPassword = document.getElementById("os-password-new").value;
  if (!newPassword) return;
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/os-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) document.getElementById("os-password-new").value = "";
}

// --- System Updates ------------------------------------------------------
// apt-upgrade.sh runs update/upgrade as a detached systemd unit, so a
// single GET /apt-upgrade/status poll (not a real push/stream) is enough
// to show "live" progress — while it's running we just keep re-fetching
// every couple seconds and re-rendering the log tail.
const APT_UPGRADE_STATE_KEY = {
  idle: "apt_upgrade_state_idle",
  running: "apt_upgrade_state_running",
  success: "apt_upgrade_state_success",
  failed: "apt_upgrade_state_failed",
};
const APT_UPGRADE_STATE_BADGE_CLASS = {
  idle: "bg-secondary",
  running: "bg-info text-dark",
  success: "bg-success",
  failed: "bg-danger",
};

let aptUpgradePollTimer = null;

function renderAptUpgradeStatus(status) {
  const stateEl = document.getElementById("apt-upgrade-state");
  if (!stateEl) return;
  const key = APT_UPGRADE_STATE_KEY[status.state] ?? APT_UPGRADE_STATE_KEY.idle;
  stateEl.textContent = window.aundekiosk?.t?.(key) ?? status.state;
  stateEl.className = "badge " + (APT_UPGRADE_STATE_BADGE_CLASS[status.state] ?? APT_UPGRADE_STATE_BADGE_CLASS.idle);

  document.getElementById("apt-upgrade-reboot-required").hidden = !status.rebootRequired;

  const logEl = document.getElementById("apt-upgrade-log");
  logEl.textContent = status.log;
  logEl.scrollTop = logEl.scrollHeight;

  document.getElementById("apt-upgrade-start").disabled = status.state === "running";
}

async function loadAptUpgradeStatus() {
  const res = await fetch("/apt-upgrade/status");
  if (!res.ok) return;
  const status = await res.json();
  renderAptUpgradeStatus(status);

  if (status.state === "running") {
    if (!aptUpgradePollTimer) {
      aptUpgradePollTimer = setInterval(loadAptUpgradeStatus, 2000);
    }
  } else if (aptUpgradePollTimer) {
    clearInterval(aptUpgradePollTimer);
    aptUpgradePollTimer = null;
  }
}

async function startAptUpgrade() {
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/apt-upgrade/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmPassword }),
  });
  if (!res.ok) {
    alert(await res.text());
  }
  await loadAptUpgradeStatus();
}

// --- Users -------------------------------------------------------------
function renderUserRow(user) {
  const template = document.getElementById("template-user");
  const row = template.content.firstElementChild.cloneNode(true);
  window.aundekiosk?.translateSubtree?.(row);
  row.querySelector(".user-username").textContent = user.username;
  row.querySelector(".user-email").textContent = user.email || "";
  row.querySelector(".user-delete").addEventListener("click", () => deleteUser(user.username));
  return row;
}

async function loadUsers() {
  const list = document.getElementById("users-list");
  if (!list) return;
  const res = await fetch("/users");
  if (!res.ok) return;
  const users = await res.json();
  list.innerHTML = "";
  for (const user of users) {
    list.appendChild(renderUserRow(user));
  }
}

async function addUser() {
  const username = document.getElementById("new-user-username").value.trim();
  const email = document.getElementById("new-user-email").value.trim();
  const password = document.getElementById("new-user-password").value;
  if (!username || !password) return;
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email: email || null, password, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) {
    document.getElementById("new-user-username").value = "";
    document.getElementById("new-user-email").value = "";
    document.getElementById("new-user-password").value = "";
    await loadUsers();
  }
}

async function deleteUser(username) {
  const confirmPassword = promptForStepUp();
  if (!confirmPassword) return;
  const res = await fetch("/users-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, confirmPassword }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadUsers();
}

// --- Audit Log -----------------------------------------------------------
// General "who did what" viewer — unlike formatMonitorEvent (which only
// handles the resource monitor's own event types), this formats every
// event type the audit log records, falling back to a raw sentence for
// anything it doesn't recognize by name.
function formatAuditEvent(event) {
  const lang = document.getElementById("lang-switch")?.value || "tr";
  const locale = MONITOR_EVENT_LOCALE_BY_LANG[lang] || lang;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(event.timestamp));
  const params = { ...event };
  if (typeof event.ok === "boolean") {
    params.status = window.aundekiosk?.t?.(event.ok ? "audit_status_ok" : "audit_status_failed");
  }
  if (typeof event.action === "string") {
    params.action = window.aundekiosk?.t?.(`audit_action_${event.action}`) ?? event.action;
  }
  const translated = window.aundekiosk?.t?.(`audit_event_${event.event}`, params);
  if (translated && !translated.startsWith("audit_event_")) {
    return `${time} — ${translated}`;
  }
  return `${time} — ${event.event}`;
}

async function loadAuditLog() {
  const list = document.getElementById("audit-log-list");
  if (!list) return;
  const res = await fetch("/audit-log");
  if (!res.ok) return;
  const events = await res.json();
  list.innerHTML = "";
  document.getElementById("audit-log-empty").hidden = events.length > 0;
  for (const event of events) {
    const li = document.createElement("li");
    li.className = "list-group-item";
    li.textContent = formatAuditEvent(event);
    list.appendChild(li);
  }
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

  document.getElementById("monitor-add-tier")?.addEventListener("click", () => {
    document.getElementById("monitor-tiers").appendChild(
      renderTierRow({ threshold: 70, sustainedSamples: 10, action: "log", cooldownSeconds: 300 }),
    );
  });
  document.getElementById("monitor-save")?.addEventListener("click", saveMonitorConfig);

  document.getElementById("hostname-save")?.addEventListener("click", saveHostname);
  document.getElementById("network-interface")?.addEventListener("change", updateNetworkFieldVisibility);
  document.getElementById("network-mode")?.addEventListener("change", updateNetworkFieldVisibility);
  document.getElementById("network-apply")?.addEventListener("click", applyNetworkConfig);
  document.getElementById("network-confirm")?.addEventListener("click", confirmNetworkConfig);
  document.getElementById("snmp-save")?.addEventListener("click", saveSnmpConfig);
  document.getElementById("os-password-save")?.addEventListener("click", saveOsPassword);
  updateNetworkFieldVisibility();

  document.getElementById("add-user-button")?.addEventListener("click", addUser);
  document.getElementById("apt-upgrade-start")?.addEventListener("click", startAptUpgrade);

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.loadConfig = loadConfig;
  window.aundekiosk.loadServiceStatus = loadServiceStatus;
  window.aundekiosk.loadMonitorConfig = loadMonitorConfig;
  window.aundekiosk.loadMonitorEvents = loadMonitorEvents;
  window.aundekiosk.loadRemoteAccessStatus = loadRemoteAccessStatus;
  window.aundekiosk.loadUsers = loadUsers;
  window.aundekiosk.loadAuditLog = loadAuditLog;
  window.aundekiosk.loadAptUpgradeStatus = loadAptUpgradeStatus;
}
