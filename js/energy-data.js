// ============================================================
// LuminaGrid — Energy Data Page (energy_data.html)
// ============================================================
// Values are LIVE and honest:
//   - power_consumption is INSTANTANEOUS Watts. Shown here only as kW
//     (W/1000) from the latest valid reading — never treated as kWh.
//   - Monthly kWh comes from the trusted backend aggregate
//     (energy_monthly/{YYYY-MM}), computed by the Admin SDK energy worker.
//   - Nodes with no telemetry show NO DATA / 0 — never fabricated.
// ============================================================

const currentRole = requireRole(["admin", "finance"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

// A reading is "fresh" if its timestamp is within this window of now.
// The ESP32 uploads ~every 10s; 60s gives generous margin for a live lamp.
const TELEMETRY_FRESH_MS = 60000;

function isFresh(reading) {
  if (!reading || !reading.timestamp) return false;
  const ms = Date.parse(reading.timestamp);
  if (isNaN(ms)) return false;
  return Date.now() - ms <= TELEMETRY_FRESH_MS;
}

// A lamp is electrically ON only with fresh telemetry whose light_status is ON.
function lampIsOn(reading) {
  return isFresh(reading) && reading.light_status === "ON";
}

function fmt(n, dp = 2) {
  return (Number(n) || 0).toFixed(dp);
}

async function loadEnergyData() {
  const streetlights = await DataService.getStreetlights();
  const monthly = await DataService.getMonthlyEnergy();
  const config = await DataService.getSystemConfig();
  const ratePerKwh =
    typeof config.energy_rate_per_kwh === "number"
      ? config.energy_rate_per_kwh
      : 13.60;

  // Billing period = current Philippine (Asia/Manila) calendar month.
  const monthKey = DataService.getManilaMonthKey();
  const monthRecord = monthly[monthKey] || {};
  const monthNodes = monthRecord.nodes || {};

  const billingEl = document.getElementById("billingPeriod");
  if (billingEl) {
    const [y, m] = monthKey.split("-");
    const monthName = new Date(Number(y), Number(m) - 1, 1).toLocaleString(
      "en-US",
      { month: "long" }
    );
    billingEl.textContent = `${monthName} ${y}`;
  }

  let activeCount = 0;
  const nodeBreakdowns = [];
  const reportingNodes = []; // nodes that actually produced telemetry

  for (const node of streetlights) {
    const sid = String(node.streetlight_id);
    const reading = await DataService.getLatestReading(sid);
    const hasTelemetry = !!reading;

    // ---- Active Lights: fresh telemetry AND light_status ON ----
    if (lampIsOn(reading)) activeCount++;

    // ---- POWER (kW): latest valid instantaneous power / 1000 ----
    const powerKw =
      hasTelemetry && typeof reading.power_consumption === "number"
        ? reading.power_consumption / 1000
        : 0;

    // ---- ENERGY (kWh): monthly accumulated from backend aggregate ----
    const nodeAgg = monthNodes[sid] || {};
    const nodeKwh = typeof nodeAgg.total_kwh === "number" ? nodeAgg.total_kwh : 0;

    if (hasTelemetry || nodeKwh > 0) reportingNodes.push(sid);

    // ---- STATUS: real operational state, honest about missing telemetry ----
    let statusLabel, statusClass;
    if (!hasTelemetry) {
      statusLabel = "NO DATA";
      statusClass = "offline";
    } else if (lampIsOn(reading)) {
      statusLabel = "OK";
      statusClass = "ok";
    } else if (node.status === "Faulty") {
      statusLabel = "FAULTY";
      statusClass = "fault";
    } else {
      statusLabel = "OFFLINE";
      statusClass = "offline";
    }

    const nodeCost = nodeKwh * ratePerKwh;

    nodeBreakdowns.push({
      id: node.node_id || node.pole_number || `Node ${sid}`,
      pole: node.pole_number || sid,
      location: node.location || node.barangay || "—",
      status: statusLabel,
      statusClass,
      hasTelemetry,
      powerKw,
      energyKwh: nodeKwh,
      cost: nodeCost
    });
  }

  // ---- TOTAL CONSUMPTION: actual monthly accumulated kWh ----
  const totalKwh =
    typeof monthRecord.total_kwh === "number"
      ? monthRecord.total_kwh
      : nodeBreakdowns.reduce((s, n) => s + n.energyKwh, 0);

  // ---- EST. MONTHLY COST: total kWh x configured rate ----
  const totalCost = totalKwh * ratePerKwh;

  // ---- AVERAGE / REPORTING NODE: over nodes with telemetry/energy only ----
  const denom = reportingNodes.length;
  const avgNode = denom > 0 ? totalKwh / denom : 0;

  // Populate KPIs
  const statTotalKwh = document.getElementById("statTotalKwh");
  if (statTotalKwh) statTotalKwh.textContent = fmt(totalKwh, 1);

  const statAvgNode = document.getElementById("statAvgNode");
  if (statAvgNode) statAvgNode.textContent = fmt(avgNode, 2);

  const statMonthlyCost = document.getElementById("statMonthlyCost");
  if (statMonthlyCost) {
    statMonthlyCost.textContent = `₱ ${totalCost.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  const statActiveLights = document.getElementById("statActiveLights");
  if (statActiveLights) statActiveLights.textContent = `${activeCount}/${streetlights.length}`;

  // ---- Consumption by Node bars: proportional to ACTUAL per-node kWh ----
  const maxKwh = Math.max(...nodeBreakdowns.map((n) => n.energyKwh), 0);
  const nodeBarList = document.getElementById("nodeBarList");
  if (nodeBarList) {
    nodeBarList.innerHTML = nodeBreakdowns.map((n) => {
      const pct = maxKwh > 0 ? Math.min((n.energyKwh / maxKwh) * 100, 100) : 0;
      const gradClass = n.hasTelemetry ? "grad-navy-blue" : "grad-gray";
      return `
        <div class="node-bar-row">
          <div class="node-bar-label">
            <div class="node-id">${n.id}</div>
            <div class="node-pole">${n.pole}</div>
          </div>
          <div class="node-bar-track">
            <div class="node-bar-fill ${gradClass}" style="width:${pct}%;"></div>
          </div>
          <div class="node-bar-value">${n.hasTelemetry ? fmt(n.energyKwh, 3) : "0"}</div>
        </div>
      `;
    }).join("");
  }

  // ---- Detailed Breakdown table ----
  const breakdownBody = document.getElementById("breakdownBody");
  if (breakdownBody) {
    breakdownBody.innerHTML = nodeBreakdowns.map((n) => `
      <tr>
        <td><strong>${n.id}</strong></td>
        <td>${n.location}</td>
        <td><span class="status-pill ${n.statusClass}">${n.status}</span></td>
        <td style="font-family:var(--font-mono);">${n.hasTelemetry ? fmt(n.powerKw, 3) : "—"}</td>
        <td style="font-family:var(--font-mono); font-weight:600;">${fmt(n.energyKwh, 3)}</td>
        <td style="font-family:var(--font-mono); font-weight:600; color:var(--green);">₱ ${fmt(n.cost, 2)}</td>
      </tr>
    `).join("");
  }
}

loadEnergyData();
