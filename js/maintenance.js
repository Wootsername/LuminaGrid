// ============================================================
// LuminaGrid — Maintenance Management
// Maintenance Electricians & Admins.
// ============================================================

const currentRole = requireRole(["admin", "electrician"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function loadMaintenanceData() {
  const records = await DataService.getMaintenanceRecords();
  const streetlights = await DataService.getStreetlights();
  const users = await DataService.getUsers();

  const nodeById = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));
  const userById = Object.fromEntries(users.map(u => [u.user_id, u.first_name + " " + u.last_name]));

  // Populate history table
  const tbody = document.getElementById("maintenanceTableBody");
  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No maintenance records logged yet.</td></tr>`;
  } else {
    tbody.innerHTML = records.map(r => {
      const node = nodeById[r.streetlight_id] || {};
      const electricianName = userById[r.user_id] || "Electrician";
      return `
        <tr>
          <td><strong>${escapeHtml(r.maintenance_id)}</strong></td>
          <td>${escapeHtml(node.node_id ? `${node.node_id} (${node.pole_number || "—"})` : (node.pole_number || r.streetlight_id || "—"))}</td>
          <td>${escapeHtml(electricianName)}</td>
          <td><span class="status-pill ${r.repair_status === 'Completed' ? 'resolved' : 'pending'}">${escapeHtml(r.repair_status)}</span></td>
          <td>${formatDateTime(r.repair_date)}</td>
          <td>${escapeHtml(r.remarks || "—")}</td>
        </tr>
      `;
    }).join("");
  }

  // Populate pending repairs / unacknowledged faults
  const pendingFaults = await DataService.getFaultReports({ status: "Pending" });
  const pendingList = document.getElementById("pendingRepairsList");

  if (pendingFaults.length === 0) {
    pendingList.innerHTML = `<div class="empty-state">No pending fault alerts requiring maintenance.</div>`;
  } else {
    pendingList.innerHTML = pendingFaults.map(f => {
      const node = nodeById[f.streetlight_id] || {};
      return `
        <div class="maintenance-card">
          <div class="mc-info">
            <h4>${escapeHtml(node.node_id || node.pole_number || f.streetlight_id)} — ${escapeHtml(f.fault_type)}</h4>
            <p>${escapeHtml(node.location || node.barangay || "—")} | Severity: <strong>${escapeHtml(f.severity)}</strong> | Detected ${formatDateTime(f.detected_at)}</p>
          </div>
          <div class="mc-actions">
            <button class="btn btn-amber" style="padding:6px 12px; font-size:0.78rem;" onclick="quickAcknowledge(${htmlStringArgument(f.fault_id)}, ${htmlStringArgument(f.streetlight_id)})">${DataService.isAutomaticFaultType(f.fault_type) ? 'Log Maintenance' : 'Acknowledge & Resolve'}</button>
            ${DataService.isAutomaticFaultType(f.fault_type) ? '<p>Automatic fault — resolves when telemetry confirms recovery.</p>' : ''}
          </div>
        </div>
      `;
    }).join("");
  }

  // Populate dropdown in modal
  const select = document.getElementById("mStreetlightSelect");
  // Firebase streetlight records may not carry node_id / location — fall back
  // the same way the rest of the app does (node_id -> pole_number ->
  // streetlight_id, location -> barangay) so no "undefined" is rendered.
  select.innerHTML = streetlights.map(s => `<option value="${escapeHtml(s.streetlight_id)}">${escapeHtml(s.node_id ? `${s.node_id} (${s.pole_number || "—"})` : (s.pole_number || s.streetlight_id || "—"))} - ${escapeHtml(s.location || s.barangay || "—")}</option>`).join("");
}

async function quickAcknowledge(faultId, streetlightId) {
  const currentUserId = sessionStorage.getItem("luminagrid_user_id") || "u002";
  const fault = (await DataService.getFaultReports()).find(f => f.fault_id === faultId);
  if (!fault) return;
  const automatic = DataService.isAutomaticFaultType(fault.fault_type);
  if (!automatic) await DataService.resolveFaultReport(faultId);
  await DataService.addMaintenanceRecord({
    fault_id: faultId,
    streetlight_id: streetlightId,
    user_id: currentUserId,
    repair_status: "Completed",
    repair_date: new Date().toISOString(),
    remarks: automatic ? "Maintenance logged; awaiting automatic telemetry recovery." : "Quick repair resolution logged from dashboard."
  });
  loadMaintenanceData();
}
window.quickAcknowledge = quickAcknowledge;

// Modal logic
const modal = document.getElementById("maintenanceModal");
document.getElementById("newLogBtn").addEventListener("click", () => modal.classList.add("open"));
document.getElementById("cancelMaintBtn").addEventListener("click", () => modal.classList.remove("open"));

document.getElementById("maintenanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentUserId = sessionStorage.getItem("luminagrid_user_id") || "u002";
  await DataService.addMaintenanceRecord({
    streetlight_id: document.getElementById("mStreetlightSelect").value,
    user_id: currentUserId,
    repair_status: document.getElementById("mRepairStatus").value,
    repair_date: new Date().toISOString(),
    remarks: document.getElementById("mRemarks").value
  });
  modal.classList.remove("open");
  e.target.reset();
  loadMaintenanceData();
});

loadMaintenanceData();
