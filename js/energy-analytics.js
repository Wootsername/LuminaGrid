// ============================================================
// LuminaGrid — Energy Analytics / Reports
// Admin and Budget/Finance Officer view.
// Matching Figure 28: Reports
// ============================================================

const currentRole = requireRole(["admin", "finance"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

let energyChart;
let selectedExportFormat = "spreadsheet";
let selectedTimeframe = "monthly";

// Short month name for a "YYYY-MM" key.
function monthLabel(key) {
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "short" });
}

// Populate the chart from the REAL monthly aggregate. Only months the backend
// has actually written (numeric total_kwh AND a nodes map) are shown; seeded
// demo months are excluded so no fabricated bars are rendered.
function updateChart(monthly) {
  if (!energyChart) return;
  const realMonths = Object.entries(monthly || {})
    .filter(([, rec]) => rec && typeof rec.total_kwh === "number" && rec.nodes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  energyChart.data.labels = realMonths.map(([key]) => monthLabel(key));
  energyChart.data.datasets[0].data = realMonths.map(([, rec]) => Number(rec.total_kwh.toFixed(2)));
  energyChart.update();
}

function initChart() {
  const ctx = document.getElementById("energyChart").getContext("2d");

  energyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "Energy Consumption (kWh)",
        data: [],
        backgroundColor: "#1D4E89",
        borderRadius: 4,
        barThickness: 36
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => ` ${item.raw} kWh`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#64748B", font: { family: "Poppins", size: 11 } }
        },
        y: {
          min: 0,
          ticks: {
            color: "#64748B",
            font: { family: "Poppins", size: 11 }
          },
          grid: { color: "#F1F5F9" }
        }
      }
    }
  });
}

async function loadReportData() {
  // Fault summary from LIVE Firebase fault_report data (no hardcoded 25/20/20).
  const faults = await DataService.getFaultReports();
  const totalFaults = faults.length;
  const resolvedFaults = faults.filter((f) => f.status === "Resolved").length;
  const pendingFaults = faults.filter((f) => f.status === "Pending").length;

  document.getElementById("sumTotalFaults").textContent = totalFaults;
  document.getElementById("sumResolvedFaults").textContent = resolvedFaults;
  document.getElementById("sumPendingFaults").textContent = pendingFaults;

  const monthly = await DataService.getMonthlyEnergy();

  // Energy metrics come from the trusted backend aggregate for the CURRENT
  // Philippine (Asia/Manila) billing month — not a hardcoded demo month.
  // cost is recomputed from the configured tariff so the figure is trustworthy.
  const config = await DataService.getSystemConfig();
  const ratePerKwh =
    typeof config.energy_rate_per_kwh === "number"
      ? config.energy_rate_per_kwh
      : 13.60;

  const monthKey = DataService.getManilaMonthKey();
  updateChart(monthly);
  const latestMonth = monthly[monthKey] || { total_kwh: 0, cost: 0 };

  const totalKwh = latestMonth.total_kwh || 0;
  // Average over nodes that actually reported energy this month.
  const nodeMap = latestMonth.nodes || {};
  const reportingCount = Object.keys(nodeMap).length;
  const avgNode = reportingCount > 0 ? totalKwh / reportingCount : 0;

  document.getElementById("statTotalKwh").textContent = totalKwh.toFixed(1);
  document.getElementById("statMonthlyCost").textContent = (totalKwh * ratePerKwh).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.getElementById("statAvgNode").textContent = avgNode.toFixed(1);
}

const exportModal = document.getElementById("exportModal");
const modalReportType = document.getElementById("modalReportType");
const timeframeButtons = document.querySelectorAll(".segmented-option");

function closeExportModal() {
  exportModal.classList.remove("open");
}

document.getElementById("exportBtn").addEventListener("click", () => exportModal.classList.add("open"));
document.getElementById("closeExportModal").addEventListener("click", closeExportModal);
const cancelExportBtn = document.getElementById("cancelExport");
if (cancelExportBtn) {
  cancelExportBtn.addEventListener("click", closeExportModal);
}
exportModal.addEventListener("click", (event) => {
  if (event.target === exportModal) closeExportModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeExportModal();
});

timeframeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedTimeframe = button.dataset.view;
    timeframeButtons.forEach((item) => item.classList.toggle("selected", item === button));
  });
});

document.querySelectorAll(".export-format-card").forEach((card) => {
  card.addEventListener("click", () => {
    selectedExportFormat = card.dataset.format;
    document.querySelectorAll(".export-format-card").forEach((item) => item.classList.toggle("selected", item === card));
  });
});

document.getElementById("downloadReport").addEventListener("click", async () => {
  const readings = await DataService.getAllReadings();
  if (readings.length === 0) {
    alert("No data available to export.");
    return;
  }

  const categoryText = modalReportType?.selectedOptions?.[0]?.text || "All Metrics";
  const timeframeLabel = selectedTimeframe.charAt(0).toUpperCase() + selectedTimeframe.slice(1);
  const filePrefix = `${categoryText.replace(/\s+/g, "-").toLowerCase()}-${selectedTimeframe}`;
  const header = `LuminaGrid Report,${categoryText},${timeframeLabel}\nreading_id,streetlight_id,current,voltage,ambient_light,power_consumption,light_status,timestamp\n`;
  const body = readings
    .map(r => `${r.reading_id},${r.streetlight_id},${r.current},${r.voltage},${r.ambient_light},${r.power_consumption},${r.light_status},${r.timestamp}`)
    .join("\n");
  const content = selectedExportFormat === "spreadsheet"
    ? header + body
    : `<html><body><h1>LuminaGrid Report</h1><p>${categoryText} | ${timeframeLabel}</p><pre>${header + body}</pre></body></html>`;
  const extensions = { spreadsheet: "csv", pdf: "pdf", docx: "docx" };
  const types = { spreadsheet: "text/csv", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const blob = new Blob([content], { type: types[selectedExportFormat] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filePrefix}_${new Date().toISOString().slice(0, 10)}.${extensions[selectedExportFormat]}`;
  a.click();
  URL.revokeObjectURL(url);
  closeExportModal();
});

document.querySelectorAll(".pagination-pages button:not(.pagination-arrow)").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".pagination-pages button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

initChart();
loadReportData();
