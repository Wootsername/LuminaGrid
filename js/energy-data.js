// ============================================================
// LuminaGrid — Energy Data Page (energy_data.html)
// ============================================================

const currentRole = requireRole(["admin", "finance"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function loadEnergyData() {
  const streetlights = await DataService.getStreetlights();
  const monthly = await DataService.getMonthlyEnergy();
  const config = await DataService.getSystemConfig();
  const ratePerKwh = config.energy_rate_per_kwh || 13.60;

  const currentMonthData = monthly["2026-08"] || { total_kwh: 163.3, cost: 2219.0 };
  const totalKwh = currentMonthData.total_kwh;
  const totalCost = currentMonthData.cost;
  const nodeCount = streetlights.length || 4;
  const avgNode = (totalKwh / nodeCount).toFixed(1);

  let activeCount = 0;
  const nodeBreakdowns = [];

  for (const node of streetlights) {
    const reading = await DataService.getLatestReading(node.streetlight_id);
    const isOnline = node.status === "Active";
    if (isOnline) activeCount++;

    const powerKw = reading && reading.power_consumption ? (reading.power_consumption / 1000).toFixed(3) : "0.000";
    
    // Per-node estimated monthly energy share
    let nodeKwh = 0;
    if (node.node_id === "LG-01") nodeKwh = 42.5;
    else if (node.node_id === "LG-02") nodeKwh = 48.2;
    else if (node.node_id === "LG-03") nodeKwh = 40.05;
    else if (node.node_id === "LG-04") nodeKwh = 32.55;
    else nodeKwh = parseFloat(avgNode);

    const cost = (nodeKwh * ratePerKwh).toFixed(2);

    nodeBreakdowns.push({
      id: node.node_id || node.pole_number,
      location: node.location || node.barangay,
      status: node.status,
      powerKw: powerKw,
      energyKwh: nodeKwh.toFixed(2),
      cost: cost
    });
  }

  // Populate KPIs
  const statTotalKwh = document.getElementById("statTotalKwh");
  if (statTotalKwh) statTotalKwh.textContent = totalKwh.toFixed(1);

  const statAvgNode = document.getElementById("statAvgNode");
  if (statAvgNode) statAvgNode.textContent = avgNode;

  const statMonthlyCost = document.getElementById("statMonthlyCost");
  if (statMonthlyCost) statMonthlyCost.textContent = `₱ ${totalCost.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statActiveLights = document.getElementById("statActiveLights");
  if (statActiveLights) statActiveLights.textContent = `${activeCount}/${nodeCount}`;

  // Populate Consumption by Node bars
  const maxKwh = Math.max(...nodeBreakdowns.map(n => parseFloat(n.energyKwh)), 50);
  const nodeBarList = document.getElementById("nodeBarList");
  if (nodeBarList) {
    nodeBarList.innerHTML = nodeBreakdowns.map(n => {
      const pct = Math.min(Math.round((parseFloat(n.energyKwh) / maxKwh) * 100), 100);
      return `
        <div class="energy-node-bar-row" style="margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:600; color:var(--navy-900); margin-bottom:4px;">
            <span>${n.id} (${n.location})</span>
            <span>${n.energyKwh} kWh (₱ ${n.cost})</span>
          </div>
          <div style="background:var(--gray-200); height:10px; border-radius:6px; overflow:hidden;">
            <div style="background:var(--navy-900); height:100%; width:${pct}%; border-radius:6px;"></div>
          </div>
        </div>
      `;
    }).join("");
  }

  // Populate Detailed Breakdown Table
  const breakdownBody = document.getElementById("breakdownBody");
  if (breakdownBody) {
    breakdownBody.innerHTML = nodeBreakdowns.map(n => `
      <tr>
        <td><strong>${n.id}</strong></td>
        <td>${n.location}</td>
        <td><span class="status-pill ${n.status === 'Active' ? 'ok' : n.status === 'Faulty' ? 'fault' : 'offline'}">${n.status === 'Active' ? 'OK' : n.status}</span></td>
        <td style="font-family:var(--font-mono);">${n.powerKw}</td>
        <td style="font-family:var(--font-mono); font-weight:600;">${n.energyKwh}</td>
        <td style="font-family:var(--font-mono); font-weight:600; color:var(--green);">₱ ${n.cost}</td>
      </tr>
    `).join("");
  }
}

loadEnergyData();
