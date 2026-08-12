// ============================================================
// LuminaGrid — Maintenance Management
// Maintenance Electricians & Admins.
// ============================================================

const currentRole = requireRole(["admin", "electrician"]);
paintUserChip();
wireLogout();

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
          <td><strong>${r.maintenance_id}</strong></td>
          <td>${node.node_id || node.pole_number || r.streetlight_id} (${node.pole_number || ""})</td>
          <td>${electricianName}</td>
          <td><span class="status-pill ${r.repair_status === 'Completed' ? 'resolved' : 'pending'}">${r.repair_status}</span></td>
          <td>${formatDateTime(r.repair_date)}</td>
          <td>${r.remarks || "—"}</td>
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
            <h4>${node.node_id || f.streetlight_id} — ${f.fault_type}</h4>
            <p>${node.location || node.barangay} | Severity: <strong>${f.severity}</strong> | Detected ${formatDateTime(f.detected_at)}</p>
          </div>
          <div class="mc-actions">
            <button class="btn btn-amber" style="padding:6px 12px; font-size:0.78rem;" onclick="quickAcknowledge('${f.fault_id}', '${f.streetlight_id}')">Acknowledge & Resolve</button>
          </div>
        </div>
      `;
    }).join("");
  }

  // Populate dropdown in modal
  const select = document.getElementById("mStreetlightSelect");
  select.innerHTML = streetlights.map(s => `<option value="${s.streetlight_id}">${s.node_id} (${s.pole_number}) - ${s.location}</option>`).join("");
}

async function quickAcknowledge(faultId, streetlightId) {
  const currentUserId = sessionStorage.getItem("luminagrid_user_id") || "u002";
  await DataService.resolveFaultReport(faultId);
  await DataService.addMaintenanceRecord({
    fault_id: faultId,
    streetlight_id: streetlightId,
    user_id: currentUserId,
    repair_status: "Completed",
    repair_date: new Date().toISOString(),
    remarks: "Quick repair resolution logged from dashboard."
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
