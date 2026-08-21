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

  if (nameEl) nameEl.textContent = initials;
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
