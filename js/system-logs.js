// ============================================================
// LuminaGrid — System Logs (Admin only)
// Use Case: "View System Logs"
// Merges fault detections, notifications, and maintenance
// actions into a single chronological audit feed.
// ============================================================

requireRole(["admin"]);
paintUserChip();
wireLogout();

async function renderLogs() {
  const [faults, notifications, maintenance, streetlights, users] = await Promise.all([
    DataService.getFaultReports(),
    DataService.getNotifications(),
    DataService.getMaintenanceRecords(),
    DataService.getStreetlights(),
    DataService.getUsers()
  ]);

  const poleById = Object.fromEntries(streetlights.map((s) => [s.streetlight_id, s.pole_number]));
  const faultById = Object.fromEntries(faults.map((f) => [f.fault_id, f]));
  const userById = Object.fromEntries(users.map((u) => [u.user_id, `${u.first_name} ${u.last_name}`]));

  const events = [];

  faults.forEach((f) => {
    events.push({
      time: f.detected_at,
      event: "Fault Detected",
      detail: `${f.fault_type} on Pole ${poleById[f.streetlight_id] || f.streetlight_id} (${f.severity})`
    });
    if (f.resolved_at) {
      events.push({
        time: f.resolved_at,
        event: "Fault Resolved",
        detail: `Pole ${poleById[f.streetlight_id] || f.streetlight_id}`
      });
    }
  });

  notifications.forEach((n) => {
    const fault = faultById[n.fault_id];
    events.push({
      time: n.sent_at,
      event: "Notification Sent",
      detail: `${n.notification_type} → ${userById[n.user_id] || n.user_id}${fault ? " (Pole " + (poleById[fault.streetlight_id] || fault.streetlight_id) + ")" : ""}`
    });
  });

  maintenance.forEach((m) => {
    const fault = faultById[m.fault_id];
    events.push({
      time: m.repair_date,
      event: "Maintenance Logged",
      detail: `${m.repair_status} by ${userById[m.user_id] || m.user_id}${fault ? " — " + m.remarks : ""}`
    });
  });

  events.sort((a, b) => new Date(b.time) - new Date(a.time));

  const body = document.getElementById("logTableBody");
  if (events.length === 0) {
    body.innerHTML = `<tr><td colspan="3" style="color:var(--slate-400); text-align:center; padding:24px;">No system activity yet.</td></tr>`;
    return;
  }

  body.innerHTML = events
    .map((e) => `<tr><td>${formatDateTime(e.time)}</td><td>${e.event}</td><td>${e.detail}</td></tr>`)
    .join("");
}

renderLogs();
