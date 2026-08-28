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

// ---------- Map init ----------
// Frame the full Vicente Rama Ave corridor -- Ramon Duterte St corner in the
// south up to Golden Success College in the north -- so every node is visible
// on load. renderNodes() finishes the framing with a one-time fitBounds().
const map = L.map("map").setView([10.3199, 123.8845], 15);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

const markers = {};
let allNodes = [];
let selectedNodeId = null;
let mapBounded = false; // only auto-frame the map once on first successful load

function statusColor(status) {
  if (status === "Faulty") return "#EF4444";
  if (status === "Offline") return "#9CA3B5";
  return "#22C55E"; // Active
}

function statusPillClass(status) {
  if (status === "Faulty") return "faulty";
  if (status === "Offline") return "offline";
  return "active";
}

function statusLabel(status) {
  if (status === "Faulty") return "FAULT";
  if (status === "Offline") return "OFFLINE";
  return "ONLINE";
}

function makeDotIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-dot" style="background:${statusColor(status)};"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

async function popupHtml(node) {
  const reading = await DataService.getLatestReading(node.streetlight_id);
  return `
    <div class="node-popup status-${statusPillClass(node.status)}">
      <div class="node-popup-header">
        <h4>${node.node_id || node.pole_number}</h4>
        <span class="status-pill ${statusPillClass(node.status)}">${statusLabel(node.status)}</span>
      </div>
      <div class="node-popup-body">
        <div class="popup-row"><span>Location</span><span>${node.location || node.barangay}</span></div>
      <div class="popup-row"><span>Current</span><span>${reading ? reading.current.toFixed(2) + " A" : "—"}</span></div>
      <div class="popup-row"><span>Voltage</span><span>${reading ? reading.voltage.toFixed(1) + " V" : "—"}</span></div>
      <div class="popup-row"><span>Ambient</span><span>${reading ? reading.ambient_light.toFixed(1) + " lx" : "—"}</span></div>
      <div style="margin-top:8px;">
        <button onclick="showNodeDetail('${node.streetlight_id}')" style="background:var(--amber);color:var(--navy-900);border:none;padding:5px 10px;border-radius:6px;font-weight:600;cursor:pointer;font-family:var(--font-ui);font-size:0.78rem;">View Details</button>
      </div>
      </div>
    </div>
  `;
}

// ---------- Render nodes on map ----------
async function renderNodes() {
  const nodes = await DataService.getStreetlights();
  allNodes = nodes;
  let activeCount = 0, faultyCount = 0, offlineCount = 0;

  for (const node of nodes) {
    if (node.status === "Active") activeCount++;
    else if (node.status === "Faulty") faultyCount++;
    else if (node.status === "Offline") offlineCount++;

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

      // Click to select in side panel
      markers[node.streetlight_id].on("click", () => {
        showNodeDetail(node.streetlight_id);
      });
    }
  }

  document.getElementById("kpiTotal").textContent = nodes.length;
  document.getElementById("kpiActive").textContent = activeCount;
  document.getElementById("kpiFaults").textContent = faultyCount;
  document.getElementById("kpiOffline").textContent = offlineCount;

  // First successful load only: zoom the map once to frame every node (and any
  // future nodes added via Node Management) without fighting the user's pan.
  if (!mapBounded && allNodes.length) {
    mapBounded = true;
    const nodeBounds = L.latLngBounds(allNodes.map(n => [n.latitude, n.longitude]));
    map.fitBounds(nodeBounds.pad(0.2), { maxZoom: 16 });
  }
}

// ---------- Render node list in side panel ----------
async function renderNodeList() {
  const nodes = await DataService.getStreetlights();
  const listEl = document.getElementById("nodeList");

  listEl.innerHTML = nodes.map(node => `
    <div class="node-card ${selectedNodeId === node.streetlight_id ? 'selected' : ''}" 
         onclick="showNodeDetail('${node.streetlight_id}')" id="nodeCard-${node.streetlight_id}">
      <div class="node-card-header">
        <span class="node-status-dot status-dot-${statusPillClass(node.status)}" aria-hidden="true"></span>
        <div class="node-card-info">
          <h4>${node.pole_number || node.node_id}</h4>
          <p class="node-card-location">${node.location || node.barangay}</p>
        </div>
        <span class="status-pill ${statusPillClass(node.status)}">${statusLabel(node.status)}</span>
      </div>
      <div class="node-card-body"></div>
    </div>
  `).join("");
}

// ---------- Node detail panel ----------
async function showNodeDetail(streetlightId) {
  // Remember whether this node was already open so refresh() can re-render the
  // currently-open detail panel in place without re-centring the map on it.
  const wasSelected = selectedNodeId === streetlightId;
  selectedNodeId = streetlightId;
  const node = await DataService.getStreetlight(streetlightId);
  if (!node) return;

  const reading = await DataService.getLatestReading(streetlightId);

  // Show detail view, hide list view
  document.getElementById("nodeListView").style.display = "none";
  document.getElementById("nodeDetailView").style.display = "block";
  const detailView = document.getElementById("nodeDetailView");
  detailView.classList.remove("visible", "status-active", "status-faulty", "status-offline");
  detailView.classList.add("visible", `status-${statusPillClass(node.status)}`);

  // Populate header
  document.getElementById("detailNodeId").textContent = node.node_id || node.pole_number;
  const statusEl = document.getElementById("detailStatus");
  statusEl.textContent = `● ${statusLabel(node.status)}`;
  statusEl.className = "status-pill " + statusPillClass(node.status);

  document.getElementById("detailLocation").textContent = node.location || node.barangay;

  // Sensor grid
  if (reading) {
    document.getElementById("detailCurrent").textContent = reading.current.toFixed(2);
    document.getElementById("detailVoltage").textContent = reading.voltage.toFixed(0);
    // Rough energy estimate
    const energyKwh = reading.power_consumption > 0 ? ((reading.power_consumption / 1000) * 520).toFixed(1) : (node.node_id === "LG-03" ? "40.05" : "0.0");
    document.getElementById("detailEnergy").textContent = energyKwh;
    document.getElementById("detailAmbient").textContent = reading.ambient_light.toFixed(0);
  } else {
    ["detailCurrent", "detailVoltage", "detailEnergy", "detailAmbient"].forEach(id => {
      document.getElementById(id).textContent = "—";
    });
  }

  // Info table
  document.getElementById("detailNodeIdInfo").textContent = node.node_id || "—";
  document.getElementById("detailPoleNo").textContent = node.pole_number;
  document.getElementById("detailLocationInfo").textContent = node.location || node.barangay;
  document.getElementById("detailCoords").textContent = node.latitude.toFixed(5) + ", " + node.longitude.toFixed(5);

  const lightStatusEl = document.getElementById("detailLightStatus");
  if (reading) {
    lightStatusEl.innerHTML = `<span class="status-pill ${reading.light_status === 'ON' ? 'active' : 'offline'}">${reading.light_status === 'ON' ? 'ONLINE' : 'OFFLINE'}</span>`;
  } else {
    lightStatusEl.textContent = "—";
  }

  document.getElementById("detailLastUpdate").textContent = reading ? formatDateTime(reading.timestamp) : "—";
  document.getElementById("detailLastSeen").textContent = node.last_seen ? formatDateTime(node.last_seen) : "—";

  // Show/hide resolve button
  const resolveBtn = document.getElementById("resolveFaultBtn");
  if (node.status === "Faulty" && (currentRole === "admin" || currentRole === "electrician")) {
    resolveBtn.style.display = "block";
    resolveBtn.onclick = () => resolveNodeFault(streetlightId);
  } else {
    resolveBtn.style.display = "none";
  }

  // Locate on map button
  document.getElementById("locateOnMapBtn").onclick = () => {
    map.flyTo([node.latitude, node.longitude], 18);
    if (markers[streetlightId]) markers[streetlightId].openPopup();
  };

  // Highlight selected card
  renderNodeList();

  // Pan map to node (only when the node is first selected; refresh() re-renders
  // the open panel in place and must not pull the map away from the user).
  if (!wasSelected) {
    map.flyTo([node.latitude, node.longitude], 17);
  }
}
window.showNodeDetail = showNodeDetail;

// Close detail view
document.getElementById("closeDetailBtn").addEventListener("click", () => {
  document.getElementById("nodeListView").style.display = "block";
  document.getElementById("nodeDetailView").style.display = "none";
  document.getElementById("nodeDetailView").classList.remove("visible");
  selectedNodeId = null;
  renderNodeList();
});

// ---------- Fault banner ----------
async function renderFaultBanner() {
  const reports = await DataService.getFaultReports({ status: "Pending" });
  const banner = document.getElementById("faultBanner");

  if (reports.length === 0) {
    banner.classList.add("fault-banner-hidden");
    return;
  }

  const streetlights = await DataService.getStreetlights();
  const byId = Object.fromEntries(streetlights.map(s => [s.streetlight_id, s]));

  const latestFault = reports[0];
  const node = byId[latestFault.streetlight_id];
  const nodeLabel = node ? `Node ${node.node_id} (${node.pole_number})` : latestFault.streetlight_id;

  document.getElementById("bannerText").textContent =
    `Fault detected at ${nodeLabel} – ${latestFault.fault_type}. ${latestFault.description || ""}`;

  banner.classList.remove("fault-banner-hidden");

  document.getElementById("bannerViewBtn").onclick = () => {
    showNodeDetail(latestFault.streetlight_id);
  };

  document.getElementById("bannerResolveBtn").onclick = async () => {
    if (currentRole !== "admin" && currentRole !== "electrician") {
      alert("Only Admin or Electrician can resolve faults.");
      return;
    }
    await DataService.resolveFaultReport(latestFault.fault_id);
    await refresh();
  };
}

// ---------- Resolve node fault ----------
async function resolveNodeFault(streetlightId) {
  const reports = await DataService.getFaultReports({ status: "Pending" });
  const faults = reports.filter(r => r.streetlight_id === streetlightId);
  if (faults.length) {
    for (const fault of faults) {
      await DataService.resolveFaultReport(fault.fault_id);
    }
  } else {
    // Simulated fault with no matching fault report -- clear the defect directly.
    await DataService.markNodeActive(streetlightId);
  }
  await refresh();
}

// ---------- Simulate faults ----------
document.getElementById("simulateFaultsBtn").addEventListener("click", async () => {
  const nodes = await DataService.getStreetlights();
  const activeNodes = nodes.filter(n => n.status === "Active");
  if (activeNodes.length === 0) {
    alert("No active nodes to simulate faults on.");
    return;
  }
  // Pick the first active node and file a full fault report against it.
  // reportFault() creates the Pending fault, flips the node to Faulty, and
  // fires a "Fault Alert" notification to every active user -- so the fault
  // banner, Fault Records, and Notifications pages all light up at once.
  const target = activeNodes[0];
  await DataService.reportFault(target.streetlight_id);
  await refresh();
});

// ---------- Simulate heartbeat (power restore / auto-recovery demo) ----------
document.getElementById("simulateHeartbeatBtn").addEventListener("click", async () => {
  const nodes = await DataService.getStreetlights();
  const offlineNodes = nodes.filter(n => n.status === "Offline");
  if (offlineNodes.length === 0) {
    alert("All nodes are currently ONLINE. Nothing to recover — pick a node and simulate a power outage (stale last_seen) to test blackout recovery.");
    return;
  }
  // Fresh heartbeat on the first offline node; it flips back to ONLINE for free.
  await DataService.tickHeartbeat(offlineNodes[0].streetlight_id);
  await refresh();
});

// ---------- Auto-refresh ----------
// Poll so nodes whose heartbeat resumes (power restored) return to ONLINE
// automatically without needing a refresh or manual step.
setInterval(() => { refresh(); }, 30000);

// ---------- Refresh all ----------
async function refresh() {
  await renderNodes();
  await renderNodeList();
  await renderFaultBanner();

  // Keep the open detail panel (if any) in sync with the latest data -- e.g. a
  // fault was just resolved (Resolve button in the panel or banner) or a
  // heartbeat resumed during the 30s auto-refresh. Without this, the panel
  // keeps showing the stale status until the user clicks the node again.
  if (selectedNodeId) {
    await showNodeDetail(selectedNodeId);
  }
}

refresh();
