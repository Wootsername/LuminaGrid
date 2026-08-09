// ============================================================
// LuminaGrid — Energy Analytics
// Admin and Budget/Finance Officer only, per Use Case Diagram.
// Reads sensor readings through DataService only.
// ============================================================

const currentRole = requireRole(["admin", "finance"]);
paintUserChip();
wireLogout();

let energyChart, nodeChart;
let latestRows = [];

function initCharts() {
  energyChart = new Chart(document.getElementById("energyChart"), {
    type: "line",
    data: { labels: [], datasets: [{
      label: "Total kWh",
      data: [],
      borderColor: "#f5a623",
      backgroundColor: "rgba(245,166,35,0.15)",
      tension: 0.3,
      fill: true
    }]},
    options: chartOptions()
  });

  nodeChart = new Chart(document.getElementById("nodeChart"), {
    type: "bar",
    data: { labels: [], datasets: [{
      label: "kWh per node",
      data: [],
      backgroundColor: "#3ecf8e"
    }]},
    options: chartOptions()
  });
}

function chartOptions() {
  return {
    responsive: true,
    plugins: { legend: { labels: { color: "#c4cede" } } },
    scales: {
      x: { ticks: { color: "#7d8ba3" }, grid: { color: "#1e2f4a" } },
      y: { ticks: { color: "#7d8ba3" }, grid: { color: "#1e2f4a" } }
    }
  };
}

async function loadAnalytics(timeframe) {
  const readings = await DataService.getAllReadings();
  const streetlights = await DataService.getStreetlights();
  const poleById = Object.fromEntries(streetlights.map((s) => [s.streetlight_id, s.pole_number]));

  latestRows = readings.map((r) => ({ ...r, pole_number: poleById[r.streetlight_id] || r.streetlight_id }));
  renderCharts(latestRows, timeframe);
}

function renderCharts(rows, timeframe) {
  if (rows.length === 0) {
    [energyChart, nodeChart].forEach((c) => {
      c.data.labels = [];
      c.data.datasets[0].data = [];
      c.update();
    });
    return;
  }

  const bucketFn = (ts) => {
    const d = new Date(ts);
    return timeframe === "daily"
      ? d.getHours() + ":00"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const buckets = {};
  const perNode = {};

  rows.forEach((r) => {
    const kwh = (r.power_consumption || 0) / 1000;
    const bucketKey = bucketFn(r.timestamp);
    buckets[bucketKey] = (buckets[bucketKey] || 0) + kwh;
    perNode[r.pole_number] = (perNode[r.pole_number] || 0) + kwh;
  });

  energyChart.data.labels = Object.keys(buckets);
  energyChart.data.datasets[0].data = Object.values(buckets).map((v) => v.toFixed(3));
  energyChart.update();

  nodeChart.data.labels = Object.keys(perNode);
  nodeChart.data.datasets[0].data = Object.values(perNode).map((v) => v.toFixed(3));
  nodeChart.update();
}

document.getElementById("timeframeSelect").addEventListener("change", (e) => {
  loadAnalytics(e.target.value);
});

document.getElementById("exportBtn").addEventListener("click", () => {
  if (latestRows.length === 0) {
    alert("No data to export yet.");
    return;
  }
  const header = "pole_number,current,voltage,power_consumption,light_status,timestamp\n";
  const body = latestRows
    .map((r) => `${r.pole_number},${r.current},${r.voltage},${r.power_consumption},${r.light_status},${r.timestamp}`)
    .join("\n");
  const blob = new Blob([header + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "luminagrid_energy_export.csv";
  a.click();
  URL.revokeObjectURL(url);
});

initCharts();
loadAnalytics("daily");
