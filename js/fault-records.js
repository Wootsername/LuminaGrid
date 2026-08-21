// ============================================================
// LuminaGrid — Fault Records
// ============================================================

const currentRole = requireRole(["admin", "electrician"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function renderFaultTable() {
  const statusFilter = document.getElementById("statusFilter").value;
  const searchQuery = (document.getElementById("faultSearch").value || "").toLowerCase().trim();
  const reports = await DataService.getFaultReports({ status: statusFilter });
  const streetlights = await DataService.getStreetlights();
  const nodeById = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));
  const filteredReports = reports.filter(report => {
    if (!searchQuery) return true;
    const node = nodeById[report.streetlight_id] || {};
    return [report.fault_id, report.fault_type, report.severity, node.node_id, node.pole_number, node.location]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(searchQuery);
  });

  const tbody = document.getElementById("faultTableBody");
  if (filteredReports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No fault records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredReports.map(r => {
    const node = nodeById[r.streetlight_id] || {};
    const nodeLabel = node.node_id ? `${node.node_id} (${node.pole_number})` : (node.pole_number || r.streetlight_id);

    return `
      <tr>
        <td><strong>${r.fault_id}</strong></td>
        <td>${nodeLabel}</td>
        <td>${r.fault_type}</td>
        <td><span class="severity-badge severity-${r.severity.toLowerCase()}">${r.severity}</span></td>
        <td><span class="status-pill ${r.status === 'Resolved' ? 'resolved' : 'pending'}">${r.status}</span></td>
        <td>${formatDateTime(r.detected_at)}</td>
        <td>${formatDateTime(r.resolved_at)}</td>
        <td>
          ${r.status === 'Pending' ? `<button class="history-resolve-btn" onclick="resolveFaultRecord('${r.fault_id}')">Resolve</button>` : '—'}
        </td>
      </tr>
    `;
  }).join("");
}

async function resolveFaultRecord(faultId) {
  await DataService.resolveFaultReport(faultId);
  renderFaultTable();
}
window.resolveFaultRecord = resolveFaultRecord;

document.getElementById("statusFilter").addEventListener("change", renderFaultTable);
document.getElementById("faultSearch").addEventListener("input", renderFaultTable);

renderFaultTable();
