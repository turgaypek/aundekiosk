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
}
