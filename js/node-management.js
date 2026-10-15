// ============================================================
// LuminaGrid — Node Management
// ============================================================

const currentRole = requireRole(["admin"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function renderNodeTable() {
  const nodes = await DataService.getStreetlights();
  const tbody = document.getElementById("nodeTableBody");

  tbody.innerHTML = nodes.map(n => {
    // Coordinates are numeric in Firebase but guard against legacy records
    // without lat/lng so one bad row can never break the whole table.
    const lat = Number(n.latitude);
    const lng = Number(n.longitude);
    const coords = isFinite(lat) && isFinite(lng)
      ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      : "—";
    return `
    <tr>
      <td><strong>${n.node_id || "LG-0" + n.streetlight_id}</strong></td>
      <td>${n.pole_number}</td>
      <td>${n.location || n.barangay}</td>
      <td>${coords}</td>
      <td>${n.installation_date || "—"}</td>
      <td><span class="status-pill ${n.status === 'Active' ? 'ok' : n.status === 'Faulty' ? 'fault' : 'offline'}">${n.status === 'Active' ? 'OK' : n.status}</span></td>
    </tr>
  `;
  }).join("");
}

// ---------- Register Node form feedback ----------
function setNodeFormError(message) {
  const el = document.getElementById("nodeFormError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

// Success toast appended to the page (kept out of the modal so it survives
// the modal closing). Styled by .lumina-toast in css/style.css.
function showNodeToast(message) {
  const toast = document.createElement("div");
  toast.className = "lumina-toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Modal handling: Register Node
const nodeModal = document.getElementById("nodeModal");
document.getElementById("addNodeBtn").addEventListener("click", () => {
  setNodeFormError("");
  nodeModal.classList.add("open");
});
document.getElementById("cancelNodeBtn").addEventListener("click", () => nodeModal.classList.remove("open"));

// Re-entrancy guard: while a Firebase write is in flight, further Save clicks
// are ignored AND the button is disabled, so one form can never register the
// same node twice.
let savingNode = false;

document.getElementById("nodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (savingNode) return;
  setNodeFormError("");

  const input = {
    node_id: document.getElementById("nodeId").value,
    pole_number: document.getElementById("poleNumber").value,
    location: document.getElementById("locationDesc").value,
    latitude: document.getElementById("latitude").value,
    longitude: document.getElementById("longitude").value
  };

  const saveBtn = document.getElementById("saveNodeBtn");
  savingNode = true;
  if (saveBtn) saveBtn.disabled = true;

  try {
    const existing = await DataService.getStreetlights();

    // Validate BEFORE any Firebase write: required fields, uniqueness among
    // existing nodes, and numeric lat/lng ranges.
    const check = NodeRegistration.validateRegistration(input, existing);
    if (!check.ok) {
      setNodeFormError(check.errors.join(" "));
      return;
    }

    // Next sid = max existing numeric id + 1 (never array length + 1), so the
    // Firebase key stays numeric-string style: streetlight/5, /6, ...
    const sid = NodeRegistration.nextStreetlightId(existing);

    const record = NodeRegistration.buildStreetlightRecord(
      check.values,
      sid,
      NodeRegistration.manilaDateKey()
    );

    // ONE record via the existing DataService path -> Firebase
    // streetlight/{sid} (set()). No mock data, no whole-collection write, no
    // sensor_reading / energy / fault / device_authz side effects. Initial
    // status is "Offline" and last_seen is intentionally absent until a real
    // device heartbeat exists.
    await DataService.upsertStreetlight(record);

    nodeModal.classList.remove("open");
    e.target.reset();
    showNodeToast(`Node ${record.node_id} registered successfully.`);
    await renderNodeTable();
  } catch (err) {
    console.error("[node-management] registration failed:", err);
    setNodeFormError(
      "Could not register the node: " + (err && err.message ? err.message : String(err))
    );
  } finally {
    savingNode = false;
    if (saveBtn) saveBtn.disabled = false;
  }
});

// ---------- Prototype Operating Settings modal ----------
//
// LEGACY system_config COMPATIBILITY NOTES (fields are kept in Firebase —
// do NOT delete or silently rewrite them):
//   * voltage_threshold_low = 200 is legacy MAINS-era configuration. The
//     current 12 V prototype (and the ESP32 firmware) uses a fixed 3.0 V
//     power-fault cutoff; the dashboard evaluator (dashboard.js
//     HARDWARE_VOLTAGE_FAULT_THRESHOLD) intentionally never reads this field.
//   * dusk_lux_threshold / dawn_lux_threshold are lux values from the old
//     analog LDR era and are INCOMPATIBLE with the current DIGITAL LDR
//     (0 = Daylight, 1 = Night — the ESP32 never sends lux). Stored only for
//     backwards compatibility; the hardware evaluator never reads them.
//   * current_threshold_high / current_threshold_low likewise are not used
//     by the hardware evaluator (firmware enforces a fixed 0.50 A cutoff).
// The modal therefore shows those effective firmware thresholds READ-ONLY
// and exposes exactly one editable website/backend setting:
// heartbeat_timeout_minutes (drives _enrich()'s Offline derivation).
const configModal = document.getElementById("configModal");

function setConfigFormError(message) {
  const el = document.getElementById("configFormError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

document.getElementById("configBtn").addEventListener("click", async () => {
  setConfigFormError("");
  configModal.classList.add("open");
  try {
    const cfg = await DataService.getSystemConfig();
    // Live Firebase value (expected 10); documented default only when the
    // field is absent or invalid so the input is never blank/nonsensical.
    const minutes = NodeRegistration.parseHeartbeatTimeout(cfg.heartbeat_timeout_minutes);
    document.getElementById("cfgHeartbeat").value = minutes != null ? minutes : 10;
  } catch (err) {
    console.error("[node-management] could not load operating settings:", err);
    setConfigFormError("Could not load current settings: " + (err && err.message ? err.message : String(err)));
  }
});
document.getElementById("cancelConfigBtn").addEventListener("click", () => configModal.classList.remove("open"));

// Re-entrancy guard: while a config write is in flight, further Save clicks
// are ignored AND the button is disabled (same pattern as Save Node).
let savingConfig = false;

document.getElementById("configForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (savingConfig) return;
  setConfigFormError("");

  const minutes = NodeRegistration.parseHeartbeatTimeout(
    document.getElementById("cfgHeartbeat").value
  );
  if (minutes == null) {
    setConfigFormError("Heartbeat Timeout must be a whole number between 1 and 60 minutes.");
    return;
  }

  const saveBtn = document.getElementById("saveConfigBtn");
  savingConfig = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    // Preserve ALL existing config fields, change ONLY
    // heartbeat_timeout_minutes (legacy threshold/lux/tariff fields are
    // written back byte-identical; see the compatibility notes above).
    const current = await DataService.getSystemConfig();
    await DataService.updateSystemConfig({
      ...current,
      heartbeat_timeout_minutes: minutes
    });
    configModal.classList.remove("open");
    showNodeToast("Operating settings updated.");
  } catch (err) {
    console.error("[node-management] settings save failed:", err);
    setConfigFormError(
      "Could not save settings: " + (err && err.message ? err.message : String(err))
    );
  } finally {
    savingConfig = false;
    if (saveBtn) saveBtn.disabled = false;
  }
});

renderNodeTable();
