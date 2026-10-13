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

const NAV_ITEMS = Object.freeze([
  { label: "Dashboard", path: "dashboard.html", roles: ["admin", "electrician", "finance"], icon: "dashboard" },
  { label: "Energy", path: "energy_data.html", roles: ["admin", "finance"], icon: "energy" },
  { label: "Notification", path: "notifications.html", roles: ["admin", "electrician", "finance"], icon: "notification" },
  { label: "Report", path: "energy-analytics.html", roles: ["admin", "finance"], icon: "report" },
  { label: "History", path: "fault-records.html", roles: ["admin", "electrician"], icon: "history" },
  { label: "Admin", path: "node-management.html", roles: ["admin"], icon: "admin", activePaths: ["node-management.html", "user-management.html", "system-logs.html"] }
].map((item) => Object.freeze({
  ...item,
  roles: Object.freeze([...item.roles]),
  activePaths: item.activePaths ? Object.freeze([...item.activePaths]) : undefined
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
  nav.innerHTML = NAV_ITEMS.map((item) => {
    const visible = role === "admin" || item.roles.includes(role);
    const active = currentRoute === item.path || (item.activePaths || []).includes(currentRoute);
    const badge = item.icon === "notification"
      ? '<span class="nav-notif-badge" id="navNotifBadge" aria-label="Unread notifications"></span>'
      : '';
    return `<a href="${item.path}" class="${active ? "active" : ""}" data-roles="${item.roles.join(",")}" data-nav-icon="${item.icon}"${active ? ' aria-current="page"' : ""}${visible ? "" : " hidden"}>
      <span class="nav-icon" aria-hidden="true"></span>${item.label}${badge}
    </a>`;
  }).join("");
}

// Call on every protected page to enforce the Use Case Diagram's
// access boundaries (e.g. only 'admin' may see Node Management,
// User Management, Fault Records, System Logs).
// Since Step 9, sessionStorage is only a UI cache: Firebase
// Authentication is the actual source of truth for "is someone
// signed in", so a stale local session must not grant access.
function requireRole(allowedRoles) {
  const role = sessionStorage.getItem("luminagrid_role");
  if (!role) {
    window.location.href = "index.html";
    return null;
  }
  _enforceFirebaseSession();
  if (allowedRoles && !allowedRoles.includes(role)) {
    alert("Your role (" + roleLabel(role) + ") doesn't have access to this page.");
    window.location.href = "dashboard.html";
    return null;
  }
  return role;
}

// Verify via auth.onAuthStateChanged that Firebase Authentication really
// has a signed-in user, and that the linked /user profile still exists and
// is Active. If not, end the Auth session, clear the cached UI session and
// return to the login page. Smallest change that prevents a logged-out
// user from being treated as authenticated merely because stale
// sessionStorage exists. Role/profile data in sessionStorage remains only
// as UI convenience for the nav/chips.
function _enforceFirebaseSession() {
  if (typeof auth === "undefined" || !auth) return;
  auth.onAuthStateChanged(async (fbUser) => {
    const reject = async () => {
      try { await auth.signOut(); } catch (_) { /* already signed out */ }
      sessionStorage.clear();
      window.location.href = "index.html";
    };
    if (!fbUser) {
      // No Firebase Auth session — only stale local storage remains.
      await reject();
      return;
    }
    try {
      // Step 13 revision: authz-first resolution (auth.uid -> authz/{uid} ->
      // logical user_id -> own profile) so hardened rules never need a whole
      // /user scan. PERMISSION_DENIED means "no authz / deactivated" -> reject.
      // Missing authz under still-permissive rules (transition) falls back to
      // the legacy lookups. Other errors keep the existing blip tolerance.
      let profile = null;
      let entry = null;
      try {
        entry = await DataService.getAuthz(fbUser.uid);
      } catch (err) {
        if (err && err.code === "PERMISSION_DENIED") {
          await reject();
          return;
        }
        throw err; // transient read failure -> outer catch keeps session
      }
      if (entry && entry.user_id) {
        profile = await DataService.getUserById(entry.user_id);
      } else {
        profile = await DataService.getUserByAuthUid(fbUser.uid);
        if (!profile && fbUser.email) {
          profile = await DataService.getUserByEmail(fbUser.email);
        }
      }
      if (!profile || String(profile.status) !== "Active") {
        await reject();
      }
    } catch (_) {
      // Profile read failed (e.g. transient network error) — keep the
      // session rather than locking the user out on a blip.
    }
  });
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
  // Kick off real-time notification badge polling
  _startNotificationBadgePolling();
}

// ---- Real-time notification badge ----
let _notifBadgeInterval = null;

async function _updateNotificationBadge() {
  try {
    if (typeof DataService === "undefined") return;
    const count = await DataService.getUnreadCount();
    const badge = document.getElementById("navNotifBadge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : count;
      badge.classList.add("visible");
      badge.setAttribute("aria-label", count + " unread notifications");
    } else {
      badge.textContent = "";
      badge.classList.remove("visible");
      badge.setAttribute("aria-label", "No unread notifications");
    }
  } catch (_) { /* silent — badge is non-critical */ }
}

function _startNotificationBadgePolling() {
  if (_notifBadgeInterval) return; // already running
  _updateNotificationBadge(); // immediate first paint
  _notifBadgeInterval = setInterval(_updateNotificationBadge, 3000);
}

function paintUserChip() {
  const nameEl = document.getElementById("userName");
  const roleEl = document.getElementById("userRole");
  const avatarEl = document.querySelector(".user-avatar");
  const fullName = sessionStorage.getItem("luminagrid_name") || "";
  const initials = sessionStorage.getItem("luminagrid_initials") || formatInitials(fullName);

  if (nameEl) nameEl.textContent = fullName || "User";
  if (roleEl) roleEl.textContent = roleLabel(sessionStorage.getItem("luminagrid_role"));
  // Fill the round initials circle with the real logged-in user's initials,
  // so it matches the name (this also updates live after a profile edit).
  if (avatarEl) avatarEl.textContent = initials || "—";
}

function wireLogout() {
  const link = document.getElementById("logoutLink");
  if (!link) return;
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    // Firebase Authentication is the actual session — end it FIRST, then
    // clear the UI cache and apply the existing redirect behavior.
    try {
      if (typeof auth !== "undefined" && auth) await auth.signOut();
    } catch (_) { /* still clear local state */ }
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
