// ============================================================
// LuminaGrid — Notifications & Alerts
// ============================================================

const currentRole = requireRole(["admin", "electrician", "finance"]);
paintUserChip();
wireLogout();

const notifModal = document.getElementById("notifModal");

let _allRows = [];

function formatNotifDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm} -${dd} - ${d.getFullYear()}`;
}

async function buildRows() {
  const notifications = await DataService.getNotifications(); // Fetch all for full feed in demo
  const faultReports = await DataService.getFaultReports();
  const streetlights = await DataService.getStreetlights();

  const faultById = Object.fromEntries(faultReports.map(f => [f.fault_id, f]));
  const nodeById = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));

  return notifications.map(n => {
    const fault = n.fault_id ? faultById[n.fault_id] || null : null;
    const node = fault ? nodeById[fault.streetlight_id] || null : null;
    const resolved = n.notification_type === "Resolution" || (fault && fault.status === "Resolved");
    return { notification: n, fault, node, resolved };
  });
}

function renderRows(rows) {
  const tbody = document.getElementById("notificationsList");

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No notifications recorded.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(({ notification: n, node, resolved }) => `
    <tr id="notif-${n.notification_id}">
      <td class="notif-status-icon" data-label="">${resolved ? '<span class="icon-ok">✅</span>' : '<span class="icon-warn">⚠️</span>'}</td>
      <td data-label="Date">${formatNotifDate(n.sent_at)}</td>
      <td data-label="Node ID">${node ? node.node_id : '—'}</td>
      <td data-label="Pole ID">${node ? node.pole_number : '—'}</td>
      <td class="notif-addr-cell" data-label="Address">${node ? node.location : (n.message || '—')}</td>
      <td data-label="Action">
        <div class="notif-action-cell">
          <button class="notif-view-btn" onclick="viewNotification('${n.notification_id}')">👁 View</button>
          <span class="notif-status-btn ${resolved ? 'resolved' : 'unresolved'}">${resolved ? '✓ Resolved' : '✕ Unresolved'}</span>
        </div>
      </td>
    </tr>
  `).join("");
}

function updateUnreadBadge(rows) {
  const badge = document.getElementById("notifUnreadBadge");
  const unreadCount = rows.filter(r => r.notification.status === "Unread").length;
  badge.textContent = unreadCount;
  badge.style.display = unreadCount > 0 ? "flex" : "none";
}

function applyFilters() {
  const query = (document.getElementById("notifSearchInput").value || "").toLowerCase().trim();
  const dateFilter = document.getElementById("notifDateFilter").value;

  let rows = _allRows;

  if (query) {
    rows = rows.filter(({ node, fault }) => {
      const haystack = [node?.node_id, node?.pole_number, node?.location, fault?.fault_type]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }

  if (dateFilter) {
    const days = Number(dateFilter);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    rows = rows.filter(({ notification }) => new Date(notification.sent_at).getTime() >= cutoff);
  }

  renderRows(rows);
}

async function loadNotifications() {
  _allRows = await buildRows();
  updateUnreadBadge(_allRows);
  applyFilters();
}

async function viewNotification(notificationId) {
  const row = _allRows.find(r => r.notification.notification_id === notificationId);
  if (!row) return;
  const { notification: n, fault, node } = row;

  document.getElementById("notifModalTitle").textContent = n.notification_type;
  document.getElementById("notifModalBody").innerHTML = `
    <p><strong>Node:</strong> ${node ? `${node.node_id} (${node.pole_number})` : '—'}</p>
    <p><strong>Address:</strong> ${node ? node.location : '—'}</p>
    <p><strong>Message:</strong> ${n.message || 'Fault alert reported via GSM network.'}</p>
    <p><strong>Sent:</strong> ${formatDateTime(n.sent_at)}</p>
    ${fault ? `<p><strong>Fault status:</strong> ${fault.status}</p>` : ''}
  `;

  const markReadBtn = document.getElementById("notifMarkReadBtn");
  if (n.status === "Unread") {
    markReadBtn.style.display = "inline-flex";
    markReadBtn.onclick = async () => {
      await markRead(n.notification_id);
      notifModal.classList.remove("open");
    };
  } else {
    markReadBtn.style.display = "none";
  }

  notifModal.classList.add("open");
}
window.viewNotification = viewNotification;

async function markRead(notificationId) {
  await DataService.markNotificationRead(notificationId);
  loadNotifications();
}
window.markRead = markRead;

document.getElementById("notifModalCloseBtn").addEventListener("click", () => notifModal.classList.remove("open"));
document.getElementById("notifSearchInput").addEventListener("input", applyFilters);
document.getElementById("notifDateFilter").addEventListener("change", applyFilters);

loadNotifications();
