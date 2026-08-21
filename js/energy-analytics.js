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

function initChart() {
  const ctx = document.getElementById("energyChart").getContext("2d");

  energyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["January", "February", "March", "April"],
      datasets: [{
        label: "Energy Consumption (kWh)",
        data: [60, 45, 78, 30],
        backgroundColor: [
          "#0F172A", // Dark navy (January)
          "#FDE68A", // Soft amber/yellow (February)
          "#EA580C", // Bright orange (March)
          "#16A34A"  // Green (April)
        ],
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
          max: 80,
          ticks: {
            stepSize: 20,
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
  const totalFaults = 25; // Matching Figure 28
  const resolvedFaults = 20; // Matching Figure 28
  const pendingFaults = 20; // Matching Figure 28

  document.getElementById("sumTotalFaults").textContent = totalFaults;
  document.getElementById("sumResolvedFaults").textContent = resolvedFaults;
  document.getElementById("sumPendingFaults").textContent = pendingFaults;

  const monthly = await DataService.getMonthlyEnergy();
  const latestMonth = monthly["2026-08"] || { total_kwh: 163.3, cost: 2219.0 };

  document.getElementById("statTotalKwh").textContent = latestMonth.total_kwh.toFixed(1);
  document.getElementById("statMonthlyCost").textContent = latestMonth.cost.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.getElementById("statAvgNode").textContent = "41.1";
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
