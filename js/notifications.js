// ============================================================
// LuminaGrid — Notifications & Alerts
// ============================================================

const currentRole = requireRole(["admin", "electrician", "finance"]);
paintUserChip();
wireLogout();

async function loadNotifications() {
  const userId = sessionStorage.getItem("luminagrid_user_id");
  const notifications = await DataService.getNotifications(); // Fetch all for full feed in demo

  const listEl = document.getElementById("notificationsList");
  const unreadCount = notifications.filter(n => n.status === "Unread").length;

  document.getElementById("unreadBannerText").textContent = `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`;

  if (notifications.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No notifications recorded.</div>`;
    return;
  }

  listEl.innerHTML = notifications.map(n => `
    <div class="notification-item ${n.status === 'Unread' ? 'unread' : ''}" id="notif-${n.notification_id}">
      <div class="notification-icon" style="${n.notification_type === 'Resolution' ? 'background:var(--green-light); color:var(--green);' : ''}">
        ${n.notification_type === 'Resolution' ? '✅' : '🚨'}
      </div>
      <div class="notification-content">
        <h4>${n.notification_type}</h4>
        <p>${n.message || 'Fault alert reported via GSM network.'}</p>
      </div>
      <div class="notification-time">
        ${formatDateTime(n.sent_at)}
        ${n.status === 'Unread' ? `<br><button class="link-btn" onclick="markRead('${n.notification_id}')" style="font-size:0.72rem; margin-top:4px;">Mark read</button>` : ''}
      </div>
    </div>
  `).join("");
}

async function markRead(notificationId) {
  await DataService.markNotificationRead(notificationId);
  loadNotifications();
}
window.markRead = markRead;

loadNotifications();
