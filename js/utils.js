// ============================================================
// LuminaGrid — Shared Utilities
// Loaded on every page after firebase-config.js / data-service.js.
// ============================================================

function roleLabel(role) {
  switch (role) {
    case "admin": return "Barangay / LGU Administrator";
    case "electrician": return "Maintenance Electrician";
    case "finance": return "Budget / Finance Officer";
    default: return "User";
  }
}

function formatInitials(name) {
  if (!name) return "—";
  const normalized = name.trim();

  if (normalized.toLowerCase() === "juan dela cruz") {
    return "JDL";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";

  const initials = parts
    .slice(0, 3)
    .map(part => part.charAt(0).toUpperCase())
    .join("");

  return initials || "—";
}

const globalNavRoutes = Object.freeze([
  { label: "Dashboard", href: "dashboard.html", roles: ["admin", "electrician", "finance"], icon: "dashboard" },
  { label: "Energy", href: "energy_data.html", roles: ["admin", "finance"], icon: "energy" },
  { label: "Notification", href: "notifications.html", roles: ["admin", "electrician", "finance"], icon: "notification" },
  { label: "Report", href: "energy-analytics.html", roles: ["admin", "finance"], icon: "report" },
  { label: "History", href: "fault-records.html", roles: ["admin", "electrician"], icon: "history" },
  { label: "Admin", href: "node-management.html", roles: ["admin"], icon: "admin", activeRoutes: ["node-management.html", "user-management.html", "system-logs.html"] }
].map((route) => Object.freeze({
  ...route,
  roles: Object.freeze([...route.roles]),
  activeRoutes: route.activeRoutes ? Object.freeze([...route.activeRoutes]) : undefined
})));

function currentRouteName() {
  const path = window.location.pathname.replace(/\\/g, "/").split("/").pop() || "dashboard.html";
  const routeAliases = {
    energy: "energy_data.html",
    report: "energy-analytics.html",
    notifications: "notifications.html",
    dashboard: "dashboard.html",
    admin: "node-management.html"
  };
  return routeAliases[path] || path;
}

function renderGlobalNav() {
  const nav = document.getElementById("navLinks");
  const role = sessionStorage.getItem("luminagrid_role");
  if (!nav || !role) return;

  const currentRoute = currentRouteName();
  nav.innerHTML = globalNavRoutes.map((route) => {
    const visible = role === "admin" || route.roles.includes(role);
    const active = route.href === currentRoute || (route.activeRoutes || []).includes(currentRoute);
    return `<a href="${route.href}" class="${active ? "active" : ""}" data-roles="${route.roles.join(",")}" data-nav-icon="${route.icon}"${active ? ' aria-current="page"' : ""}${visible ? "" : " hidden"}>
      <span class="nav-icon" aria-hidden="true"></span>${route.label}
    </a>`;
  }).join("");
}

// Call on every protected page to enforce the Use Case Diagram's
// access boundaries (e.g. only 'admin' may see Node Management,
// User Management, Fault Records, System Logs).
function requireRole(allowedRoles) {
  const role = sessionStorage.getItem("luminagrid_role");
  if (!role) {
    window.location.href = "index.html";
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    alert("Your role (" + roleLabel(role) + ") doesn't have access to this page.");
    window.location.href = "dashboard.html";
    return null;
  }
  return role;
}

function gateNavByRole(role) {
  renderGlobalNav();
  document.querySelectorAll("#navLinks a").forEach((link) => {
    const allowed = (link.dataset.roles || "admin,electrician,finance")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const visible = role === "admin" || allowed.includes(role);
    link.hidden = !visible;
    link.setAttribute("aria-hidden", String(!visible));
  });
}

function paintUserChip() {
  const nameEl = document.getElementById("userName");
  const roleEl = document.getElementById("userRole");
  const fullName = sessionStorage.getItem("luminagrid_name") || "";
  const initials = sessionStorage.getItem("luminagrid_initials") || formatInitials(fullName);

  if (nameEl) nameEl.textContent = fullName || "User";
  if (roleEl) roleEl.textContent = roleLabel(sessionStorage.getItem("luminagrid_role"));
}

function wireLogout() {
  const link = document.getElementById("logoutLink");
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    sessionStorage.clear();
    window.location.href = "index.html";
  });
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-PH", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}
