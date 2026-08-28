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
  const streetlights = await DataService.getStreetlights();
  const faultById = Object.fromEntries(reports.map(r => [r.fault_id, r]));
  const nodeById = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));

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
    const fault = n.fault_id ? faultById[n.fault_id] : null;
    const node = fault ? nodeById[fault.streetlight_id] : null;
    // Derive from live fault + node data so the dispatch log always shows the
    // node's current identity. Resolution notices read "resolved / back online";
    // Fault Alerts read "Fault detected...". Fall back to the stored message
    // when the source record is missing.
    const detail = n.notification_type === "Resolution"
      ? (fault && node
          ? `Fault ${fault.fault_id} at Node ${node.node_id} (${node.pole_number}) has been resolved. The node is back online.`
          : (n.message || "Fault resolved. The node is back online."))
      : (fault && node
          ? `Fault detected at Node ${node.node_id} (${node.pole_number}) — ${fault.fault_type}. ${fault.description || ''}`
          : (n.message || "Notification sent."));
    logs.push({
      time: n.sent_at,
      type: "GSM Alert Dispatch",
      detail
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
