// auth.js — decides which UI state to show, and wires the setup/login
// forms and the authenticated app view to the server's auth endpoints.
// decideUiState has no DOM dependency so Deno can import and test it
// directly; everything below the guard at the bottom only runs in a
// real browser.

export function decideUiState(hasAdmin, authenticated) {
  if (!hasAdmin) return "setup";
  if (!authenticated) return "login";
  return "app";
}

async function bootstrapAuth() {
  const setupSection = document.getElementById("setup-section");
  const loginSection = document.getElementById("login-section");
  const appSection = document.getElementById("app-section");

  function showOnly(sectionToShow) {
    for (const section of [setupSection, loginSection, appSection]) {
      if (section) section.hidden = section !== sectionToShow;
    }
  }

  async function refreshState() {
    const statusRes = await fetch("/api/setup");
    const { hasAdmin } = await statusRes.json();

    if (!hasAdmin) {
      showOnly(setupSection);
      return;
    }

    const configRes = await fetch("/config");
    const authenticated = configRes.status !== 401;
    const state = decideUiState(hasAdmin, authenticated);
    showOnly(state === "app" ? appSection : loginSection);
    if (state === "app" && window.aundekiosk?.loadConfig) {
      window.aundekiosk.loadConfig();
    }
    if (state === "app" && window.aundekiosk?.loadServiceStatus) {
      window.aundekiosk.loadServiceStatus();
    }
    if (state === "app" && window.aundekiosk?.loadMonitorConfig) {
      window.aundekiosk.loadMonitorConfig();
    }
    if (state === "app" && window.aundekiosk?.loadMonitorEvents) {
      window.aundekiosk.loadMonitorEvents();
    }
  }

  const setupForm = document.getElementById("setup-form");
  if (setupForm) {
    setupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("setup-username").value;
      const password = document.getElementById("setup-password").value;
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        await refreshState();
      } else {
        document.getElementById("setup-error").textContent = await res.text();
      }
    });
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("login-username").value;
      const password = document.getElementById("login-password").value;
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        await refreshState();
      } else {
        document.getElementById("login-error").textContent = await res.text();
      }
    });
  }

  const logoutButton = document.getElementById("logout-button");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      await refreshState();
    });
  }

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.refreshAuthState = refreshState;
  await refreshState();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapAuth();
}
