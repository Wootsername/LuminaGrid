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

function paintUserChip() {
  const nameEl = document.getElementById("userName");
  const roleEl = document.getElementById("userRole");
  if (nameEl) nameEl.textContent = sessionStorage.getItem("luminagrid_name") || "—";
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
