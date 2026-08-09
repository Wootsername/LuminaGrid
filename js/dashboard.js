// ============================================================
// LuminaGrid — Dashboard (Map View)
// Barangay/LGU Admin, Maintenance Electrician, and Budget/
// Finance Officer all land here after login. Reads through
// DataService only -- swapping to live Firebase later means
// editing data-service.js, not this file.
// ============================================================

const currentRole = requireRole(["admin", "electrician", "finance"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

function gateNavByRole(role) {
  document.querySelectorAll("#navLinks a[data-roles]").forEach((link) => {
    const allowed = link.dataset.roles.split(",");
    if (!allowed.includes(role)) link.style.display = "none";
  });
}

// ---------- Map init ----------
// Approximate center for the four nodes at Barangay Guadalupe.
// Replace with real GPS coordinates once hardware is installed.
const map = L.map("map").setView([10.3070, 123.8890], 17);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

const markers = {};

function statusColor(status) {
  if (status === "Faulty") return "#ef5b5b";
  if (status === "Offline") return "#7d8ba3";
  return "#3ecf8e"; // Active
}

function statusPillClass(status) {
  if (status === "Faulty") return "faulty";
  if (status === "Offline") return "offline";
  return "active";
}

function makeDotIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-dot" style="background:${statusColor(status)}; color:${statusColor(status)};"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
}

async function popupHtml(node) {
  const reading = await DataService.getLatestReading(node.streetlight_id);
  return `
    <div class="node-popup">
      <h4>Pole ${node.pole_number}</h4>
      <span class="status-pill ${statusPillClass(node.status)}">${node.status}</span>
      <div class="popup-row"><span>Barangay</span><span>${node.barangay}</span></div>
      <div class="popup-row"><span>Current</span><span>${reading ? reading.current.toFixed(2) + " A" : "—"}</span></div>
      <div class="popup-row"><span>Voltage</span><span>${reading ? reading.voltage.toFixed(1) + " V" : "—"}</span></div>
      <div class="popup-row"><span>Ambient light</span><span>${reading ? reading.ambient_light.toFixed(1) + " lx" : "—"}</span></div>
      <div class="popup-row"><span>Light status</span><span>${reading ? reading.light_status : "—"}</span></div>
      <div class="popup-row"><span>Last update</span><span>${reading ? formatDateTime(reading.timestamp) : "—"}</span></div>
    </div>
  `;
}

async function renderNodes() {
  const nodes = await DataService.getStreetlights();
  let activeCount = 0;

  for (const node of nodes) {
    if (node.status === "Active") activeCount++;
    const html = await popupHtml(node);

    if (markers[node.streetlight_id]) {
      markers[node.streetlight_id].setIcon(makeDotIcon(node.status));
      markers[node.streetlight_id].setPopupContent(html);
    } else {
      markers[node.streetlight_id] = L.marker([node.latitude, node.longitude], {
        icon: makeDotIcon(node.status)
      })
        .addTo(map)
        .bindPopup(html);
    }
  }

  document.getElementById("kpiTotal").textContent = nodes.length;
  document.getElementById("kpiActive").textContent = activeCount;
}

// ---------- Fault list + repair status update ----------
// Electricians can acknowledge/resolve here directly (per Use Case:
// "Update / Acknowledge Repair Status"). Admins can also resolve,
// but full review/resolution history lives in fault-records.html.
async function renderFaults() {
  const reports = await DataService.getFaultReports({ status: "Pending" });
  const streetlights = await DataService.getStreetlights();
  const byId = Object.fromEntries(streetlights.map((s) => [s.streetlight_id, s]));

  document.getElementById("kpiFaults").textContent = reports.length;

  const listEl = document.getElementById("faultList");
  if (reports.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <strong>No faults detected</strong>
        All monitored streetlights are reporting normal current draw.
      </div>`;
    return;
  }

  const canResolve = currentRole === "electrician" || currentRole === "admin";

  listEl.innerHTML = reports
    .map((r) => {
      const pole = byId[r.streetlight_id] ? byId[r.streetlight_id].pole_number : r.streetlight_id;
      return `
      <div class="fault-item">
        <div class="fault-pole">Pole ${pole} — ${r.severity}</div>
        <div>${r.fault_type}</div>
        <div style="color:var(--slate-400); font-size:0.78rem; margin:4px 0;">${r.description || ""}</div>
        <div class="fault-time">Detected ${formatDateTime(r.detected_at)}</div>
        ${canResolve ? `<button class="btn" style="margin-top:8px; padding:6px 10px; font-size:0.78rem;" onclick="resolveFault('${r.fault_id}')">Acknowledge / Mark Resolved</button>` : ""}
      </div>`;
    })
    .join("");
}

async function resolveFault(faultId) {
  await DataService.resolveFaultReport(faultId);
  await renderFaults();
  await renderNodes();
}
window.resolveFault = resolveFault;

// ---------- Energy KPI ----------
async function renderEnergy() {
  const totalKwh = await DataService.getTotalKwhToday();
  document.getElementById("kpiEnergy").textContent = totalKwh.toFixed(2) + " kWh";
}

renderNodes();
renderFaults();
renderEnergy();
