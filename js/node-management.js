// ============================================================
// LuminaGrid — Node Management
// ============================================================

requireRole(["admin"]);
paintUserChip();
wireLogout();

async function renderNodeTable() {
  const nodes = await DataService.getStreetlights();
  const tbody = document.getElementById("nodeTableBody");

  tbody.innerHTML = nodes.map(n => `
    <tr>
      <td><strong>${n.node_id || "LG-0" + n.streetlight_id}</strong></td>
      <td>${n.pole_number}</td>
      <td>${n.location || n.barangay}</td>
      <td>${n.latitude.toFixed(5)}, ${n.longitude.toFixed(5)}</td>
      <td>${n.installation_date || "2026-06-01"}</td>
      <td><span class="status-pill ${n.status === 'Active' ? 'ok' : n.status === 'Faulty' ? 'fault' : 'offline'}">${n.status === 'Active' ? 'OK' : n.status}</span></td>
    </tr>
  `).join("");
}

// Modal handling: Register Node
const nodeModal = document.getElementById("nodeModal");
document.getElementById("addNodeBtn").addEventListener("click", () => nodeModal.classList.add("open"));
document.getElementById("cancelNodeBtn").addEventListener("click", () => nodeModal.classList.remove("open"));

document.getElementById("nodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nodes = await DataService.getStreetlights();
  const newId = String(nodes.length + 1);

  await DataService.upsertStreetlight({
    streetlight_id: newId,
    node_id: document.getElementById("nodeId").value.trim(),
    pole_number: document.getElementById("poleNumber").value.trim(),
    barangay: "Guadalupe",
    location: document.getElementById("locationDesc").value.trim(),
    latitude: parseFloat(document.getElementById("latitude").value),
    longitude: parseFloat(document.getElementById("longitude").value),
    installation_date: new Date().toISOString().slice(0, 10),
    status: "Active"
  });

  nodeModal.classList.remove("open");
  e.target.reset();
  renderNodeTable();
});

// Modal handling: Config Thresholds
const configModal = document.getElementById("configModal");
document.getElementById("configBtn").addEventListener("click", async () => {
  const cfg = await DataService.getSystemConfig();
  if (cfg.current_threshold_high) document.getElementById("cfgHighCurrent").value = cfg.current_threshold_high;
  if (cfg.current_threshold_low) document.getElementById("cfgLowCurrent").value = cfg.current_threshold_low;
  if (cfg.dusk_lux_threshold) document.getElementById("cfgDuskLux").value = cfg.dusk_lux_threshold;
  if (cfg.dawn_lux_threshold) document.getElementById("cfgDawnLux").value = cfg.dawn_lux_threshold;
  configModal.classList.add("open");
});
document.getElementById("cancelConfigBtn").addEventListener("click", () => configModal.classList.remove("open"));

document.getElementById("configForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await DataService.updateSystemConfig({
    current_threshold_high: parseFloat(document.getElementById("cfgHighCurrent").value),
    current_threshold_low: parseFloat(document.getElementById("cfgLowCurrent").value),
    dusk_lux_threshold: parseInt(document.getElementById("cfgDuskLux").value, 10),
    dawn_lux_threshold: parseInt(document.getElementById("cfgDawnLux").value, 10)
  });
  configModal.classList.remove("open");
  alert("Operating thresholds updated successfully.");
});

renderNodeTable();
