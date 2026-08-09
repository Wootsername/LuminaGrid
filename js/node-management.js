// ============================================================
// LuminaGrid — Node Management (Admin only)
// Use Case: "Register & Configure Monitoring Nodes"
// ============================================================

requireRole(["admin"]);
paintUserChip();
wireLogout();

async function renderNodes() {
  const nodes = await DataService.getStreetlights();
  const body = document.getElementById("nodeTableBody");
  body.innerHTML = nodes
    .map(
      (n) => `
      <tr>
        <td>${n.pole_number}</td>
        <td>${n.barangay}</td>
        <td>${n.latitude}, ${n.longitude}</td>
        <td>${n.installation_date || "—"}</td>
        <td><span class="status-pill ${n.status.toLowerCase()}">${n.status}</span></td>
        <td>
          <select onchange="changeStatus('${n.streetlight_id}', this.value)" style="background:var(--navy-800); color:var(--fog-100); border:1px solid var(--navy-600); border-radius:6px; padding:4px 8px;">
            <option ${n.status === "Active" ? "selected" : ""}>Active</option>
            <option ${n.status === "Faulty" ? "selected" : ""}>Faulty</option>
            <option ${n.status === "Offline" ? "selected" : ""}>Offline</option>
          </select>
        </td>
      </tr>`
    )
    .join("");
}

async function changeStatus(streetlightId, status) {
  await DataService.upsertStreetlight({
    ...(await DataService.getStreetlight(streetlightId)),
    status
  });
  renderNodes();
}
window.changeStatus = changeStatus;

// ---------- Register node modal ----------
const modal = document.getElementById("nodeModal");
document.getElementById("addNodeBtn").addEventListener("click", () => modal.classList.add("open"));
document.getElementById("cancelNodeBtn").addEventListener("click", () => modal.classList.remove("open"));

document.getElementById("nodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nodes = await DataService.getStreetlights();
  const nextId = String(nodes.length + 1);

  await DataService.upsertStreetlight({
    streetlight_id: nextId,
    pole_number: document.getElementById("poleNumber").value.trim(),
    barangay: document.getElementById("barangay").value.trim(),
    latitude: parseFloat(document.getElementById("latitude").value),
    longitude: parseFloat(document.getElementById("longitude").value),
    installation_date: new Date().toISOString().slice(0, 10),
    status: "Offline"
  });

  modal.classList.remove("open");
  e.target.reset();
  document.getElementById("barangay").value = "Guadalupe";
  renderNodes();
});

renderNodes();
