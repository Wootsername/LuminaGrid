// ============================================================
// LuminaGrid — Fault Records
// ============================================================

const currentRole = requireRole(["admin", "electrician"]);
paintUserChip();
wireLogout();

async function renderFaultTable() {
  const statusFilter = document.getElementById("statusFilter").value;
  const reports = await DataService.getFaultReports({ status: statusFilter });
  const streetlights = await DataService.getStreetlights();
  const nodeById = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));

  const tbody = document.getElementById("faultTableBody");
  if (reports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No fault records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = reports.map(r => {
    const node = nodeById[r.streetlight_id] || {};
    const nodeLabel = node.node_id ? `${node.node_id} (${node.pole_number})` : (node.pole_number || r.streetlight_id);

    return `
      <tr>
        <td><strong>${r.fault_id}</strong></td>
        <td>${nodeLabel}</td>
        <td>${r.fault_type}</td>
        <td><span style="font-weight:600; color:${r.severity === 'High' ? 'var(--red)' : r.severity === 'Medium' ? 'var(--amber-dark)' : 'var(--gray-500)'}">${r.severity}</span></td>
        <td><span class="status-pill ${r.status === 'Resolved' ? 'resolved' : 'pending'}">${r.status}</span></td>
        <td>${formatDateTime(r.detected_at)}</td>
        <td>${formatDateTime(r.resolved_at)}</td>
        <td>
          ${r.status === 'Pending' ? `<button class="link-btn" onclick="resolveFaultRecord('${r.fault_id}')">Resolve</button>` : '—'}
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

renderFaultTable();
