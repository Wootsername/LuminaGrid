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

const markers = Object.create(null);
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
  if (status === "Active" || status === "Faulty" || status === "Offline") return status;
  return "—";
}

// Display-only freshness, using the existing worker's 90-second allowance.
// This never classifies faults or changes the stored operational status.
const TELEMETRY_DISPLAY_FRESH_MS = 90000;


function assessTimestamp(value, nowMs, timeoutMs, readFailed = false) {
  const age = DataService.timestampAge(value, nowMs);
  const finite = Number.isFinite;
  const reason = readFailed ? "read_error" : value == null || value === "" ? "missing" :
    !finite(age.parsedMs) ? "invalid" : !finite(age.effectiveAgeMs) ? "future" :
      age.effectiveAgeMs > timeoutMs ? "stale" : age.rawAgeMs < 0 ? "fresh_clock_skew" : "fresh";
  return Object.freeze({ ...age, reason,
    fresh: !readFailed && finite(age.effectiveAgeMs) && age.effectiveAgeMs <= timeoutMs });
}

function logDashboardPoll(view) {
  if (window.LUMINAGRID_DEBUG !== true || view.sid !== "1") return;
  const scalar = v => v == null ? null :
    ["string", "number", "boolean"].includes(typeof v) ? v : "[non-scalar]";
  const finite = v => Number.isFinite(v) ? v : null;
  const hb = view.timestampState.heartbeat;
  const sensor = view.timestampState.sensor;
  const selected = view.timestampState.selectedSensor;
  console.log("[LuminaGrid poll]", {
    poll_id: view.pollId, browser_now_iso: new Date(view.nowMs).toISOString(),
    streetlight_status: scalar(view.operationalStatus),
    last_seen_raw: scalar(view.rawHeartbeat),
    last_seen_parsed_ms: finite(hb.parsedMs),
    heartbeat_raw_age_ms: finite(hb.rawAgeMs),
    heartbeat_effective_age_ms: finite(hb.effectiveAgeMs),
    heartbeat_reason: hb.reason, heartbeat_fresh: hb.fresh,
    heartbeat_source: view.heartbeatSource,
    selected_heartbeat_timestamp: scalar(view.heartbeat),
    selected_heartbeat_reason: view.timestampState.selectedHeartbeat.reason,
    connection_decision: view.connection,
    candidate_reading_id: scalar(view.candidateKey),
    selected_reading_id: scalar(view.readingKey),
    sensor_timestamp_raw: scalar(view.rawReading?.timestamp),
    sensor_timestamp_parsed_ms: finite(sensor.parsedMs),
    sensor_raw_age_ms: finite(sensor.rawAgeMs),
    sensor_effective_age_ms: finite(sensor.effectiveAgeMs),
    sensor_reason: sensor.reason, sensor_fresh: sensor.fresh,
    reading_source: view.readingSource,
    selected_sensor_timestamp: scalar(view.reading?.timestamp),
    selected_sensor_reason: selected.reason,
    ambient_light: scalar(view.reading?.ambient_light), voltage: scalar(view.reading?.voltage),
    current: scalar(view.reading?.current), power_consumption: scalar(view.reading?.power_consumption),
    light_status_raw: scalar(view.reading?.light_status),
    light_status_decision: view.lightStatus || "—",
    rendered_connection: selectedNodeId === view.sid ? document.getElementById("detailConnection").textContent : null,
    rendered_light_status: selectedNodeId === view.sid ? document.getElementById("detailLightStatus").textContent : null
  });
}

function telemetryDateTime(timestamp) {
  return Number.isFinite(DataService.parseTelemetryTimestamp(timestamp)) ? formatDateTime(timestamp) : "—";
}

function sensorValue(value, decimals) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "—";
}

// The LDR currently connected to the ESP32 is DIGITAL only:
// ambient_light arrives as 0 (daylight) or 1 (nighttime) — it is NOT a lux
// measurement. Display-only mapping; the Firebase field name is unchanged.
function ldrLabel(value) {
  if (value === 0 || value === "0") return "Daylight";
  if (value === 1 || value === "1") return "Night";
  return value == null ? "—" : String(value); // legacy readings that stored other numbers
}

function makeDotIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-dot" style="background:${statusColor(status)};"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function popupHtml(view) {
  const { streetlight: node, reading } = view;
  return `
    <div class="node-popup status-${statusPillClass(node.status)}">
      <div class="node-popup-header">
        <h4>${escapeHtml(node.node_id || node.pole_number)}</h4>
        <span class="status-pill ${statusPillClass(node.status)}">${statusLabel(node.status)}</span>
      </div>
      <div class="node-popup-body">
        <div class="popup-row"><span>Location</span><span>${escapeHtml(node.location || node.barangay)}</span></div>
      <div class="popup-row"><span>Current</span><span>${reading ? sensorValue(reading.current, 2) + " A" : "—"}</span></div>
      <div class="popup-row"><span>Voltage</span><span>${reading ? sensorValue(reading.voltage, 1) + " V" : "—"}</span></div>
      <div class="popup-row"><span>LDR</span><span>${reading ? ldrLabel(reading.ambient_light) : "—"}</span></div>
      <div style="margin-top:8px;">
        <button onclick="showNodeDetail(${htmlStringArgument(node.streetlight_id)})" style="background:var(--amber);color:var(--navy-900);border:none;padding:5px 10px;border-radius:6px;font-weight:600;cursor:pointer;font-family:var(--font-ui);font-size:0.78rem;">View Details</button>
      </div>
      </div>
    </div>
  `;
}

// ---------- Render nodes on map ----------
function renderNodes(views) {
  const nodes = views.map(view => view.streetlight);
  let activeCount = 0, faultyCount = 0, offlineCount = 0;
  const positions = [];

  for (const view of views) {
    const node = view.streetlight;
    if (node.status === "Active") activeCount++;
    else if (node.status === "Faulty") faultyCount++;
    else if (node.status === "Offline") offlineCount++;

    const existingMarker = markers[node.streetlight_id];
    const coordinates = streetlightCoordinates(node);
    if (!coordinates) {
      if (existingMarker) {
        existingMarker.remove();
        delete markers[node.streetlight_id];
      }
      continue;
    }
    positions.push(coordinates);

    const html = popupHtml(view);
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
      const marker = L.marker(coordinates, {
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
  if (!mapBounded && positions.length) {
    mapBounded = true;
    const nodeBounds = L.latLngBounds(positions);
    map.fitBounds(nodeBounds.pad(0.2), { maxZoom: 16 });
  }
}

// ---------- Render node list in side panel ----------
function renderNodeList(nodes = allNodes) {
  const listEl = document.getElementById("nodeList");

  listEl.innerHTML = nodes.map(node => `
    <div class="node-card ${selectedNodeId === node.streetlight_id ? 'selected' : ''}" 
         onclick="showNodeDetail(${htmlStringArgument(node.streetlight_id)})" id="nodeCard-${escapeHtml(node.streetlight_id)}">
      <div class="node-card-header">
        <span class="node-status-dot status-dot-${statusPillClass(node.status)}" aria-hidden="true"></span>
        <div class="node-card-info">
          <h4>${escapeHtml(node.pole_number || node.node_id)}</h4>
          <p class="node-card-location">${escapeHtml(node.location || node.barangay)}</p>
        </div>
        <span class="status-pill ${statusPillClass(node.status)}">${statusLabel(node.status)}</span>
      </div>
      <div class="node-card-body"></div>
    </div>
  `).join("");
}

// ---------- Node detail panel ----------
function showNodeDetail(streetlightId) {
  const sid = String(streetlightId);
  const wasSelected = selectedNodeId === sid;
  selectedNodeId = sid;
  const view = nodeViews.get(sid);
  if (view) renderNodeDetail(view, wasSelected);
  renderNodeList();
}

function renderNodeDetail(view, wasSelected) {
  const { sid: streetlightId, streetlight: node, reading, connection, lightStatus } = view;
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
    document.getElementById("detailCurrent").textContent = sensorValue(reading.current, 2);
    document.getElementById("detailVoltage").textContent = sensorValue(reading.voltage, 0);
    // ESP32 sends power_consumption = voltage x current: instantaneous power
    // in WATTS (NOT accumulated kWh) — shown raw under the "Power / W" tile.
    document.getElementById("detailEnergy").textContent =
      sensorValue(reading.power_consumption, 1);
    // Digital LDR: 0 = daylight, 1 = nighttime — not a lux value.
    document.getElementById("detailAmbient").textContent = ldrLabel(reading.ambient_light);
    const ldrCode = document.getElementById("detailAmbientCode");
    if (ldrCode) {
      ldrCode.textContent = (reading.ambient_light === 0 || reading.ambient_light === 1)
        ? `${reading.ambient_light} = ${ldrLabel(reading.ambient_light)}`
        : "0 = Daylight · 1 = Night";
    }
  } else {
    ["detailCurrent", "detailVoltage", "detailEnergy", "detailAmbient"].forEach(id => {
      document.getElementById(id).textContent = "—";
    });
    const ldrCodeEmpty = document.getElementById("detailAmbientCode");
    if (ldrCodeEmpty) ldrCodeEmpty.textContent = "0 = Daylight · 1 = Night";
  }

  // Info table — Firebase streetlight records often carry no node_id, so fall
  // back to a stable DISPLAY-ONLY id derived from streetlight_id (NODE-001,
  // NODE-002, ...). This is never written back to Firebase; if a stored
  // node_id exists it always wins.
  document.getElementById("detailNodeIdInfo").textContent =
    node.node_id || ("NODE-" + String(node.streetlight_id).padStart(3, "0"));
  document.getElementById("detailPoleNo").textContent = node.pole_number;
  document.getElementById("detailLocationInfo").textContent = node.location || node.barangay;
  const coordinates = streetlightCoordinates(node);
  document.getElementById("detailCoords").textContent =
    coordinates ? coordinates.map(value => value.toFixed(5)).join(", ") : "—";

  const connectionEl = document.getElementById("detailConnection");
  const connectionText = connection === "ONLINE" ? "ONLINE" : "OFFLINE";
  connectionEl.innerHTML = `<span class="status-pill ${connectionText === "ONLINE" ? "active" : "offline"}">${connectionText}</span>`;

  const lightStatusEl = document.getElementById("detailLightStatus");
  if (lightStatus) {
    lightStatusEl.innerHTML = `<span class="status-pill ${lightStatus === "ON" ? "active" : "offline"}">${lightStatus}</span>`;
  } else {
    lightStatusEl.textContent = "—";
  }

  document.getElementById("detailLastUpdate").textContent = telemetryDateTime(reading && reading.timestamp);
  document.getElementById("detailLastSeen").textContent = telemetryDateTime(view.heartbeat);

  const resolveBtn = document.getElementById("resolveFaultBtn");
  const pending = pendingReports.filter(f => String(f.streetlight_id) === String(streetlightId));
  const manual = pending.filter(fault => !DataService.isAutomaticFaultType(fault.fault_type));
  resolveBtn.style.display = pending.length && (currentRole === "admin" || currentRole === "electrician") ? "block" : "none";
  resolveBtn.disabled = manual.length === 0;
  resolveBtn.textContent = manual.length ? "Resolve Manual Faults" : "Automatic fault — resolves when telemetry confirms recovery.";
  resolveBtn.onclick = manual.length ? () => resolveNodeFault(streetlightId) : null;

  const locateButton = document.getElementById("locateOnMapBtn");
  locateButton.disabled = !coordinates;
  locateButton.onclick = coordinates ? () => {
    map.flyTo(coordinates, 18);
    markers[streetlightId]?.openPopup();
  } : null;

  // Polls update the panel without moving the map away from the user.
  if (!wasSelected && coordinates) {
    map.flyTo(coordinates, 17);
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
async function renderFaultBanner(reports, streetlights) {
  const banner = document.getElementById("faultBanner");

  if (reports.length === 0) {
    banner.classList.add("fault-banner-hidden");
    return;
  }

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

  const resolveBtn = document.getElementById("bannerResolveBtn");
  const automatic = DataService.isAutomaticFaultType(latestFault.fault_type);
  resolveBtn.disabled = automatic;
  resolveBtn.textContent = automatic ? "Automatic fault — resolves when telemetry confirms recovery." : "Resolve";
  resolveBtn.onclick = automatic ? null : async () => {
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
  const faults = reports.filter(r => String(r.streetlight_id) === String(streetlightId));
  for (const fault of faults) {
    if (!DataService.isAutomaticFaultType(fault.fault_type)) {
      await DataService.resolveFaultReport(fault.fault_id);
    }
  }
  await safeRefresh();
}


// Poll snapshots and validated evidence are browser-local and never written back.
const confirmedSamples = new Map();
let nodeViews = new Map();
let latestConfig = Object.freeze({});
let pendingReports = [];
let latestRenderedPoll = 0;

function buildNodeView(node, entry, options) {
  const { nowMs, pollId, config, nodeAvailable = true, nodeReadFailed = false, readingReadFailed = false } = options;
  const sid = String(node.streetlight_id);
  const cached = confirmedSamples.get(sid) || {};
  const rawHeartbeat = nodeAvailable ? node.last_seen : null;
  const rawReading = entry?.reading ? Object.freeze({ ...entry.reading }) : null;
  const timeoutMs = (Number(config.heartbeat_timeout_minutes) || 10) * 60000;
  const heartbeat = assessTimestamp(rawHeartbeat, nowMs, timeoutMs, nodeReadFailed);
  const sensor = assessTimestamp(rawReading?.timestamp, nowMs, TELEMETRY_DISPLAY_FRESH_MS, readingReadFailed);
  let heartbeatSource = "retained", readingSource = "retained";
  if (!nodeReadFailed && Number.isFinite(heartbeat.effectiveAgeMs) &&
      (!cached.heartbeat || heartbeat.parsedMs > cached.heartbeat.ms)) {
    cached.heartbeat = Object.freeze({ timestamp: rawHeartbeat, ms: heartbeat.parsedMs });
    heartbeatSource = "current";
  }
  if (sensor.fresh && (rawReading.light_status === "ON" || rawReading.light_status === "OFF") &&
      (!cached.telemetry || sensor.parsedMs > cached.telemetry.ms)) {
    cached.telemetry = Object.freeze({ key: entry.key, ms: sensor.parsedMs,
      reading: Object.freeze({ ...rawReading }) });
    readingSource = "current";
  }
  confirmedSamples.set(sid, cached);
  const selectedHeartbeat = assessTimestamp(cached.heartbeat?.timestamp, nowMs, timeoutMs);
  const selectedSensor = assessTimestamp(cached.telemetry?.reading.timestamp, nowMs, TELEMETRY_DISPLAY_FRESH_MS);
  const reading = selectedSensor.fresh ? cached.telemetry.reading : null;
  return Object.freeze({
    sid, pollId, nowMs, streetlight: Object.freeze({ ...node }), operationalStatus: node.status,
    rawHeartbeat, rawReading, candidateKey: entry?.key ?? null,
    heartbeat: cached.heartbeat?.timestamp ?? null,
    heartbeatSource: cached.heartbeat ? heartbeatSource : "none",
    reading, readingKey: reading ? cached.telemetry.key : null,
    readingSource: reading ? readingSource : "none",
    connection: selectedHeartbeat.fresh ? "ONLINE" : "OFFLINE",
    lightStatus: reading?.light_status ?? null,
    timestampState: Object.freeze({ heartbeat, sensor, selectedHeartbeat, selectedSensor })
  });
}

function renderSnapshot(views) {
  nodeViews = views;
  allNodes = [...views.values()].map(view => view.streetlight);
  renderNodes([...views.values()]);
  renderNodeList(allNodes);
  renderFaultBanner(pendingReports, allNodes);
  const selected = views.get(selectedNodeId);
  if (selected) renderNodeDetail(selected, true);
}

// Age retained evidence without reads, before starting or waiting on a poll.
function expireDisplayedSamples() {
  const nowMs = Date.now();
  const aged = new Map([...nodeViews].map(([sid, view]) => [sid,
    buildNodeView(view.streetlight, null, { nowMs, pollId: view.pollId, config: latestConfig,
      nodeAvailable: false, nodeReadFailed: true, readingReadFailed: true })]));
  if (aged.size) renderSnapshot(aged);
}

// ---------- Auto-refresh ----------
// Fast prototype: poll every 2 seconds. Slow requests skip ticks; snapshots,
// retained evidence and stale-response rejection still share the same guard.
// Network/worker duration can extend visible latency beyond the poll interval.
const DASHBOARD_POLL_INTERVAL_MS = 2000;
let refreshRunning = false;
let pollSequence = 0;

async function safeRefresh() {
  try {
    expireDisplayedSamples();
  } catch (error) {
    // A display error must not prevent the next Firebase recovery read.
    console.error("Dashboard retained-evidence refresh failed:", error);
  }
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    await refresh();
  } catch (error) {
    console.error("Dashboard refresh failed:", error);
  } finally {
    refreshRunning = false;
  }
}

setInterval(safeRefresh, DASHBOARD_POLL_INTERVAL_MS);

// ---------- Refresh all ----------
async function refresh() {
  const pollId = ++pollSequence;
  const read = fn => Promise.resolve().then(fn);
  const [nodesResult, configResult, faultsResult] = await Promise.allSettled([
    read(() => DataService.getStreetlights()),
    read(() => DataService.getSystemConfig()),
    read(() => DataService.getFaultReports({ status: "Pending" }))
  ]);
  if (pollId !== pollSequence) return;
  const nodesAvailable = nodesResult.status === "fulfilled" && Array.isArray(nodesResult.value) && nodesResult.value.length > 0;
  const fetchedNodes = nodesAvailable ? nodesResult.value : [];
  const availableIds = new Set(fetchedNodes.map(node => String(node.streetlight_id)));
  // A missing record in one response must still age its prior evidence.
  const nodes = [...fetchedNodes, ...allNodes.filter(node => !availableIds.has(String(node.streetlight_id)))];
  const readingResults = await Promise.allSettled(nodes.map(node =>
    read(() => DataService.getLatestReadingEntry(node.streetlight_id))));
  // Check before updating caches as well as before rendering. Late replies can
  // never overwrite either the visible snapshot or last-known-valid evidence.
  if (pollId !== pollSequence || pollId <= latestRenderedPoll) return;
  const reportFailure = (result, resource) => {
    if (result.status === "rejected") console.error("Dashboard read failed:", { poll_id: pollId, resource });
  };
  reportFailure(nodesResult, "streetlight");
  reportFailure(configResult, "system_config");
  reportFailure(faultsResult, "fault_report");
  if (configResult.status === "fulfilled" && Number.isFinite(Number(configResult.value?.heartbeat_timeout_minutes)) &&
      Number(configResult.value.heartbeat_timeout_minutes) > 0) latestConfig = Object.freeze({ ...configResult.value });
  if (faultsResult.status === "fulfilled") pendingReports = Object.freeze((faultsResult.value || []).map(f => Object.freeze({ ...f })));
  const nowMs = Date.now(); // one assessment instant for every field in this poll
  const views = new Map(nodes.map((node, index) => {
    const result = readingResults[index];
    reportFailure(result, "sensor_reading/" + node.streetlight_id);
    const view = buildNodeView(node, result.status === "fulfilled" ? result.value : null, {
      nowMs, pollId, config: latestConfig, nodeAvailable: availableIds.has(String(node.streetlight_id)),
      nodeReadFailed: nodesResult.status === "rejected",
      readingReadFailed: result.status === "rejected"
    });
    return [view.sid, view];
  }));
  latestRenderedPoll = pollId;
  renderSnapshot(views);
  for (const view of views.values()) logDashboardPoll(view);
}


safeRefresh(); // initial load
