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

// Step 13: the two simulation buttons perform privileged Firebase writes
// (fault_report creation, streetlight status, notification fan-out). Under the
// candidate hardened rules only admin/electrician sessions may perform them,
// so finance sessions never trigger a permission-denied write. The fault
// resolve controls further down were already role-guarded.
if (currentRole !== "admin" && currentRole !== "electrician") {
  ["simulateFaultsBtn", "simulateHeartbeatBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = "none";
  });
}

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

// The LDR currently connected to the ESP32 is DIGITAL only:
// ambient_light arrives as 0 (daylight) or 1 (nighttime) — it is NOT a lux
// measurement. Display-only mapping; the Firebase field name is unchanged.
function ldrLabel(value) {
  if (value === 0 || value === "0") return "Daylight";
  if (value === 1 || value === "1") return "Night";
  return String(value); // legacy readings that stored other numbers
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
      <div class="popup-row"><span>LDR</span><span>${reading ? ldrLabel(reading.ambient_light) : "—"}</span></div>
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

    const existingMarker = markers[node.streetlight_id];
    if (existingMarker) {
      // Update the existing marker in place (never recreate it): swap the dot
      // icon only when the status actually CHANGED so repeated 5s telemetry
      // polls cannot re-render (flicker) the marker, and refresh the popup
      // content so an open popup shows the newest reading.
      if (existingMarker._luminaStatus !== node.status) {
        existingMarker.setIcon(makeDotIcon(node.status));
        existingMarker._luminaStatus = node.status;
      }
      existingMarker.setPopupContent(html);
    } else {
      const marker = L.marker([node.latitude, node.longitude], {
        icon: makeDotIcon(node.status)
      })
        .addTo(map)
        .bindPopup(html);
      marker._luminaStatus = node.status;

      // Click to select in side panel
      marker.on("click", () => {
        showNodeDetail(node.streetlight_id);
      });
      markers[node.streetlight_id] = marker;
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
    // ESP32 sends power_consumption = voltage x current: instantaneous power
    // in WATTS (NOT accumulated kWh) — shown raw under the "Power / W" tile.
    document.getElementById("detailEnergy").textContent =
      typeof reading.power_consumption === "number" ? reading.power_consumption.toFixed(1) : "—";
    // Digital LDR: 0 = daylight, 1 = nighttime — not a lux value.
    document.getElementById("detailAmbient").textContent = ldrLabel(reading.ambient_light);
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
  const nodeLabel = node ? (node.node_id ? `Node ${node.node_id} (${node.pole_number || "—"})` : `Node ${node.pole_number || node.streetlight_id}`) : latestFault.streetlight_id;

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
    await safeRefresh();
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
  await safeRefresh();
}

// ---------- Simulate faults ----------
document.getElementById("simulateFaultsBtn").addEventListener("click", async () => {
  if (currentRole !== "admin" && currentRole !== "electrician") {
    alert("Only Admin or Electrician can simulate faults.");
    return;
  }
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
  await safeRefresh();
});

// ---------- Simulate heartbeat (power restore / auto-recovery demo) ----------
document.getElementById("simulateHeartbeatBtn").addEventListener("click", async () => {
  if (currentRole !== "admin" && currentRole !== "electrician") {
    alert("Only Admin or Electrician can run the heartbeat simulation.");
    return;
  }
  const nodes = await DataService.getStreetlights();
  const offlineNodes = nodes.filter(n => n.status === "Offline");
  if (offlineNodes.length === 0) {
    alert("All nodes are currently ONLINE. Nothing to recover — pick a node and simulate a power outage (stale last_seen) to test blackout recovery.");
    return;
  }
  // Fresh heartbeat on the first offline node; it flips back to ONLINE for free.
  await DataService.tickHeartbeat(offlineNodes[0].streetlight_id);
  await safeRefresh();
});

// ---------- Real hardware fault evaluation (STEP 14F) ----------
// The ESP32 classifies its own local state and sends SMS alerts itself; this
// evaluator converts the SAME live Firebase telemetry into the EXISTING fault
// lifecycle (reportFault/resolveFaultReport) so real hardware faults appear on
// the map, in Fault Records, notifications and the maintenance workflow —
// without granting the device account any fault_report/notification access
// (the device may only write its own sensor_reading/* and last_seen).
//
// NOTE: these are 12 V prototype thresholds, calibrated to the working Node 1
// hardware, and are intentionally SEPARATE from the legacy mains-era values in
// system_config (e.g. voltage_threshold_low = 200) until a dedicated
// threshold-calibration/config migration is completed. This evaluator must
// never read voltage_threshold_low / dusk_lux_threshold / dawn_lux_threshold.
const HARDWARE_VOLTAGE_FAULT_THRESHOLD = 3.0;  // V — at night, below this = power fault
const HARDWARE_CURRENT_FAULT_THRESHOLD = 0.50; // A — at night with V ok, below this = bulb fault
// Sensor uploads ~10 s, heartbeats ~30 s, but SMS sending can stall the
// firmware — 90 s is a conservative freshness allowance for BOTH timestamps.
const HARDWARE_TELEMETRY_FRESH_MS = 90000;
// Real automatic hardware fault types (deterministic): used for duplicate
// detection and as the ONLY types the evaluator may auto-resolve.
const HARDWARE_FAULT_TYPES = ["Power Fault", "Bulb Fault"];
// Per-browser mutation guard so one browser can never race itself across
// refresh cycles. Cross-browser concurrency is a documented prototype
// limitation (see report).
const hwMutationLock = new Set();

// Digital LDR semantics: ambient_light is 0 (daylight) or 1 (night) — NOT lux.
// Returns "DAYLIGHT" | "NIGHT_NORMAL" | "POWER_FAULT" | "BULB_FAULT", or null
// when required fields are missing/invalid — the caller must then DO NOTHING
// (never invent a fault from incomplete data).
function classifyHardwareState(reading) {
  if (!reading) return null;
  const rawAmbient = reading.ambient_light;
  const rawVoltage = reading.voltage;
  const rawCurrent = reading.current;
  if (rawAmbient == null || rawVoltage == null || rawCurrent == null) return null;
  const ambient = Number(rawAmbient);
  const voltage = Number(rawVoltage);
  const current = Number(rawCurrent);
  if (!isFinite(ambient) || (ambient !== 0 && ambient !== 1)) return null;
  if (!isFinite(voltage) || !isFinite(current)) return null;
  if (ambient === 0) return "DAYLIGHT"; // lamp off by design — never a fault
  if (voltage < HARDWARE_VOLTAGE_FAULT_THRESHOLD) return "POWER_FAULT";
  if (current < HARDWARE_CURRENT_FAULT_THRESHOLD) return "BULB_FAULT";
  return "NIGHT_NORMAL";
}

// Stale telemetry must never create OR resolve a hardware fault: a dead or
// SMS-stalled node is a connectivity concern (Offline derivation), not proof
// of a hardware power failure — and not proof of a repair either.
function isHardwareTelemetryFresh(node, reading) {
  const readingMs = Date.parse((reading && reading.timestamp) || "");
  const seenMs = Date.parse((node && node.last_seen) || "");
  if (isNaN(readingMs) || isNaN(seenMs)) return false;
  const now = Date.now();
  return (now - readingMs) <= HARDWARE_TELEMETRY_FRESH_MS &&
         (now - seenMs) <= HARDWARE_TELEMETRY_FRESH_MS;
}
async function evaluateNodeHardwareFaults(node, pendingReports) {
  const sid = String(node.streetlight_id);
  const reading = await DataService.getLatestReading(node.streetlight_id);
  const state = classifyHardwareState(reading);
  if (!state) return;                                      // invalid data -> do nothing
  if (!isHardwareTelemetryFresh(node, reading)) return;    // stale -> do nothing

  const pendingAutomatic = pendingReports.filter(
    (f) => String(f.streetlight_id) === sid && HARDWARE_FAULT_TYPES.includes(f.fault_type)
  );

  // DAYLIGHT: the lamp is intentionally off — create NOTHING and resolve
  // NOTHING. This matches the firmware (FAULT -> DAYLIGHT sends no RESTORED):
  // we cannot know the hardware was repaired until a NORMAL night returns,
  // so the Pending fault stays open.
  if (state === "DAYLIGHT") return;

  if (hwMutationLock.has(sid)) return; // one mutation pass per node at a time
  hwMutationLock.add(sid);
  try {
    if (state === "NIGHT_NORMAL") {
      // Restoration: resolve EVERY pending automatic hardware fault through
      // the existing lifecycle (idempotent — only the final Pending->Resolved
      // transition on a now-clean node fans out one Resolution set, and
      // legacy duplicate Pendings all get closed).
      for (const fault of pendingAutomatic) {
        await DataService.resolveFaultReport(fault.fault_id);
      }
      return;
    }

    const isPower = state === "POWER_FAULT";
    const wantedType = isPower ? "Power Fault" : "Bulb Fault";

    // Duplicate prevention: ONE Pending fault per continuous outage.
    const alreadyPending = pendingAutomatic.some((f) => f.fault_type === wantedType);

    // Transition (Power <-> Bulb): create the NEW type FIRST, then resolve the
    // old one. resolveFaultReport() restores Active / fans out Resolution only
    // when no other Pending hardware fault remains, so the node stays Faulty
    // throughout and no false full-recovery is emitted.
    if (!alreadyPending) {
      await DataService.reportFault(node.streetlight_id, {
        fault_type: wantedType,
        severity: isPower ? "High" : "Medium",
        description: isPower
          ? "Hardware-detected power fault. Nighttime condition detected with supply voltage below 3.0 V."
          : "Hardware-detected bulb fault. Supply voltage is present but measured current is below 0.50 A."
      });
    }
    for (const fault of pendingAutomatic) {
      if (fault.fault_type !== wantedType) {
        await DataService.resolveFaultReport(fault.fault_id);
      }
    }
  } finally {
    hwMutationLock.delete(sid);
  }
}

// Runs inside the single safeRefresh() cycle (guarded — no second timer).
// Admin/electrician sessions only; finance never reaches the writes. Works for
// ALL streetlights, so Nodes 2-4 need no new logic when their hardware comes
// online. One node's failure never blocks the others or the UI refresh.
async function evaluateHardwareFaults() {
  if (currentRole !== "admin" && currentRole !== "electrician") return;
  const nodes = await DataService.getStreetlights();
  const pendingReports = await DataService.getFaultReports({ status: "Pending" });
  for (const node of nodes) {
    try {
      await evaluateNodeHardwareFaults(node, pendingReports);
    } catch (error) {
      console.error("Hardware fault evaluation failed for node", node.streetlight_id, error);
    }
  }
}
// ---------- Auto-refresh ----------
// The ESP32 uploads a new sensor reading about every 10 seconds and heartbeats
// about every 30 seconds, so the dashboard polls every 5 seconds to surface new
// Firebase telemetry within roughly 5-15 seconds without a manual browser
// refresh. safeRefresh() skips a tick whenever a previous async refresh is
// still running, so slower networks can never stack overlapping refreshes.
let refreshRunning = false;

async function safeRefresh() {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    // STEP 14F: convert real ESP32 telemetry into the existing fault lifecycle
    // FIRST (admin/electrician only), so any hardware fault created/resolved
    // here is rendered by the same refresh pass. Evaluation failures are
    // isolated so the dashboard still renders.
    try {
      await evaluateHardwareFaults();
    } catch (error) {
      console.error("Hardware fault evaluation failed:", error);
    }
    await refresh();
  } catch (error) {
    console.error("Dashboard refresh failed:", error);
  } finally {
    refreshRunning = false;
  }
}

setInterval(safeRefresh, 5000);

// ---------- Refresh all ----------
async function refresh() {
  await renderNodes();
  await renderNodeList();
  await renderFaultBanner();

  // Keep the open detail panel (if any) in sync with the latest data. The
  // selected node stays selected and the panel is re-rendered IN PLACE (never
  // closed/reopened) so voltage, current, power, LDR, reading time and
  // last_seen all advance with each poll. wasSelected inside showNodeDetail
  // also stops the map from re-panning to the node on every tick.
  if (selectedNodeId) {
    await showNodeDetail(selectedNodeId);
  }
}

safeRefresh(); // initial load
