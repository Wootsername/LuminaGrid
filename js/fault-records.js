// ============================================================
// LuminaGrid — Fault Records (Admin only)
// Use Case: "Review & Resolve Fault Records"
// ============================================================

requireRole(["admin"]);
paintUserChip();
wireLogout();

async function renderFaults(statusFilter) {
  const [reports, streetlights] = await Promise.all([
    DataService.getFaultReports(statusFilter ? { status: statusFilter } : {}),
    DataService.getStreetlights()
  ]);
  const poleById = Object.fromEntries(streetlights.map((s) => [s.streetlight_id, s.pole_number]));

  const body = document.getElementById("faultTableBody");
  if (reports.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="color:var(--slate-400); text-align:center; padding:24px;">No fault records match this filter.</td></tr>`;
    return;
  }

  body.innerHTML = reports
    .map(
      (r) => `
      <tr>
        <td>${poleById[r.streetlight_id] || r.streetlight_id}</td>
        <td>${r.fault_type}</td>
        <td>${r.severity}</td>
        <td><span class="status-pill ${r.status === "Resolved" ? "active" : "faulty"}">${r.status}</span></td>
        <td>${formatDateTime(r.detected_at)}</td>
        <td>${r.resolved_at ? formatDateTime(r.resolved_at) : "—"}</td>
        <td>${r.status === "Pending" ? `<button class="link-btn" onclick="resolve('${r.fault_id}')">Mark Resolved</button>` : ""}</td>
      </tr>`
    )
    .join("");
}

async function resolve(faultId) {
  await DataService.resolveFaultReport(faultId);
  renderFaults(document.getElementById("statusFilter").value);
}
window.resolve = resolve;

document.getElementById("statusFilter").addEventListener("change", (e) => {
  renderFaults(e.target.value);
});

renderFaults("");
