// ============================================================
// LuminaGrid — System Logs
// ============================================================

const currentRole = requireRole(["admin"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function renderLogs() {
  const reports = await DataService.getFaultReports();
  const notifications = await DataService.getNotifications();
  const maintenance = await DataService.getMaintenanceRecords();

  const logs = [];

  reports.forEach(r => {
    logs.push({
      time: r.detected_at,
      type: "Fault Detected",
      detail: `[${r.fault_type}] ${r.description} (Severity: ${r.severity})`
    });
    if (r.resolved_at) {
      logs.push({
        time: r.resolved_at,
        type: "Fault Resolved",
        detail: `Fault ${r.fault_id} marked as resolved.`
      });
    }
  });

  notifications.forEach(n => {
    logs.push({
      time: n.sent_at,
      type: "GSM Alert Dispatch",
      detail: n.message || "Notification sent."
    });
  });

  maintenance.forEach(m => {
    logs.push({
      time: m.repair_date,
      type: "Maintenance Activity",
      detail: `Repair status: ${m.repair_status}. Remarks: ${m.remarks}`
    });
  });

  // Sort descending by timestamp
  logs.sort((a, b) => new Date(b.time) - new Date(a.time));

  const tbody = document.getElementById("logTableBody");
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No system log entries found.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr>
      <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--gray-500);">${formatDateTime(l.time)}</td>
      <td><span class="role-badge" style="background:var(--gray-200); color:var(--navy-900);">${l.type}</span></td>
      <td>${l.detail}</td>
    </tr>
  `).join("");
}

renderLogs();
