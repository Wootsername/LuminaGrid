// ============================================================
// LuminaGrid backend — Fault Service (pure classification, no Firebase)
// ============================================================
// Authoritative hardware classification for the 12 V prototype. This module
// mirrors — and now OWNS — the logic the dashboard used to run in the
// browser (classifyHardwareState / isHardwareTelemetryFresh), so fault
// evaluation no longer depends on an admin/electrician tab being open.
//
// HARDWARE TRUTH (matches ESP32 firmware exactly):
//   Power Fault : night + voltage < 3.0 V
//   Bulb Fault  : night + voltage >= 3.0 V + current < 0.50 A
//   Light sensor: DIGITAL LDR — 0 = Daylight, 1 = Night (never lux)
//
// LEGACY system_config fields are intentionally NEVER read here:
// voltage_threshold_low = 200 (mains-era), dusk/dawn lux (analog LDR era),
// current_threshold_low. The firmware enforces fixed 3.0 V / 0.50 A.
// ============================================================

// Current prototype firmware constants (documented in Admin > Prototype
// Operating Settings as read-only).
const POWER_FAULT_VOLTAGE_THRESHOLD = 3.0; // V — night, below this = power fault
const BULB_FAULT_CURRENT_THRESHOLD = 0.50; // A — night with V ok, below this = bulb fault

// Sensor uploads ~10 s, heartbeats ~30 s, but SMS sending can stall the
// firmware — 90 s is the currently validated freshness allowance for BOTH
// timestamps (preserved from dashboard.js). Stale telemetry proves neither
// hardware failure nor repair: no create AND no resolve while stale.
const HARDWARE_TELEMETRY_FRESH_MS = 90000;

// Website/backend connectivity setting (system_config, default 10 minutes).
const DEFAULT_HEARTBEAT_TIMEOUT_MIN = 10;

// Fault-type ownership. These types are owned by the trusted backend
// lifecycle (create + resolve). Browser UI must not manually resolve them
// (they reappear until telemetry confirms recovery) — this list is a UI
// ownership policy, NOT classification logic.
const HARDWARE_FAULT_TYPES = ["Power Fault", "Bulb Fault"];
const NODE_OFFLINE_TYPE = "Node Offline";
const AUTOMATIC_FAULT_TYPES = ["Power Fault", "Bulb Fault", "Node Offline"];

const FAULT_SEVERITY = {
  "Power Fault": "High",
  "Bulb Fault": "Medium",
  "Node Offline": "Medium"
};

const FAULT_DESCRIPTION = {
  "Power Fault":
    "Hardware-detected power fault. Nighttime condition detected with supply voltage below 3.0 V.",
  "Bulb Fault":
    "Hardware-detected bulb fault. Supply voltage is present but measured current is below 0.50 A.",
  "Node Offline":
    "Node offline. No heartbeat received within the configured heartbeat timeout."
};

// ---------- Classification (section 3) ----------
// Returns "DAYLIGHT" | "POWER_FAULT" | "BULB_FAULT" | "NORMAL", or null when
// telemetry is missing/invalid (UNKNOWN — caller takes NO automatic action).
function classifyHardwareState(reading) {
  if (!reading) return null;
  const rawAmbient = reading.ambient_light;
  const rawVoltage = reading.voltage;
  const rawCurrent = reading.current;
  const numeric = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v));
  if (![rawAmbient, rawVoltage, rawCurrent].every(numeric)) return null;
  const ambient = Number(rawAmbient);
  const voltage = Number(rawVoltage);
  const current = Number(rawCurrent);
  if (!isFinite(ambient) || (ambient !== 0 && ambient !== 1)) return null; // digital LDR only
  if (!isFinite(voltage) || !isFinite(current)) return null;
  if (ambient === 0) return "DAYLIGHT"; // lamp off by design — never a fault
  // Night (ambient === 1):
  if (voltage < POWER_FAULT_VOLTAGE_THRESHOLD) return "POWER_FAULT";
  if (current < BULB_FAULT_CURRENT_THRESHOLD) return "BULB_FAULT";
  return "NORMAL";
}

const { CLOCK_SKEW_TOLERANCE_MS, parseTelemetryTimestamp, timestampAge } = require("../js/telemetry-time");

// ---------- Freshness (section 4) ----------
// CREATE or RESOLVE of Power/Bulb faults requires BOTH the latest reading
// timestamp and the node's last_seen heartbeat to be valid and within the
// 90 s window of nowMs. Stale -> false -> no automatic hardware action.
function isHardwareTelemetryFresh(reading, node, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const readingAge = timestampAge(reading && reading.timestamp, now).effectiveAgeMs;
  const seenAge = timestampAge(node && node.last_seen, now).effectiveAgeMs;
  return Number.isFinite(readingAge) && Number.isFinite(seenAge) &&
         readingAge <= HARDWARE_TELEMETRY_FRESH_MS &&
         seenAge <= HARDWARE_TELEMETRY_FRESH_MS;
}

// ---------- Heartbeat (section 5) ----------
// "NEVER_SEEN" (no valid last_seen), "TIMED_OUT" (past configured window),
// or "OK". Missing heartbeat is NEVER Power/Bulb and NEVER creates a fault.
function heartbeatState(node, heartbeatTimeoutMin, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const age = timestampAge(node && node.last_seen, now).effectiveAgeMs;
  if (!Number.isFinite(age)) return "NEVER_SEEN";
  const timeoutMs =
    (Number.isFinite(Number(heartbeatTimeoutMin)) && Number(heartbeatTimeoutMin) > 0 ? Number(heartbeatTimeoutMin) : DEFAULT_HEARTBEAT_TIMEOUT_MIN) * 60000;
  return age > timeoutMs ? "TIMED_OUT" : "OK";
}

// ---------- Planning ----------
// Pure decision for one node given the pass's inputs. `pending` must be the
// node's Pending fault_report records. Claims re-validate everything against
// FRESH database state inside their transaction, so this is the intent, not
// the authority.
//   hw:      null | { kind: "ensure", type } | { kind: "resolve" }
//   offline: null | "create" | "resolve"
function planFaultActions({ node, reading, pending, heartbeatTimeoutMin, nowMs }) {
  const now = nowMs == null ? Date.now() : nowMs;
  const pend = (pending || []).filter((f) => f && f.status === "Pending");
  const hb = node ? heartbeatState(node, heartbeatTimeoutMin, now) : "NEVER_SEEN";
  const pendingHw = pend.filter((f) => HARDWARE_FAULT_TYPES.includes(f.fault_type));
  const pendingOffline = pend.filter((f) => f.fault_type === NODE_OFFLINE_TYPE);

  // Offline dimension: never-heartbeated nodes generate NOTHING (section 21).
  let offline = null;
  if (hb === "TIMED_OUT" && pendingOffline.length === 0) offline = "create";
  else if (hb === "OK" && pendingOffline.length > 0) offline = "resolve";

  // Hardware dimension: gated by 90 s freshness of BOTH timestamps.
  let hw = null;
  if (node && hb === "OK" && isHardwareTelemetryFresh(reading, node, now)) {
    const state = classifyHardwareState(reading);
    if (state === "POWER_FAULT") hw = { kind: "ensure", type: "Power Fault" };
    else if (state === "BULB_FAULT") hw = { kind: "ensure", type: "Bulb Fault" };
    else if (state === "NORMAL" && pendingHw.length > 0) hw = { kind: "resolve" };
    // DAYLIGHT with pending faults -> keep Pending (section 6).
    // UNKNOWN / fresh NIGHT with nothing pending -> no action.
  }

  return { hw, offline, heartbeat: hb };
}

// ---------- Node status authority (section 16) ----------
// Returns the authoritative stored status; no valid heartbeat means Offline.
function computeDesiredStatus({ node, pending, heartbeatTimeoutMin, nowMs }) {
  if (!node) return null;
  const now = nowMs == null ? Date.now() : nowMs;
  const hb = heartbeatState(node, heartbeatTimeoutMin, now);
  const pend = (pending || []).filter((f) => f && f.status === "Pending");

  if (hb === "NEVER_SEEN") return "Offline";
  if (hb === "TIMED_OUT") return "Offline";
  return pend.some((f) => f.fault_type !== NODE_OFFLINE_TYPE) ? "Faulty" : "Active";
}

// ---------- Notification message wording (section 14) ----------
// Byte-equivalent to js/data-service.js _faultAlertMessage/_resolutionMessage
// so browser and backend render identical feeds.
function nodeLabel(node, fallbackSid) {
  if (!node) return fallbackSid == null ? "—" : fallbackSid;
  return node.node_id
    ? `${node.node_id} (${node.pole_number || "—"})`
    : (node.pole_number || node.streetlight_id || fallbackSid || "—");
}

function faultAlertMessage(fault, node) {
  return `Fault detected at Node ${nodeLabel(node, fault && fault.streetlight_id)} — ${fault.fault_type}. ${fault && fault.description ? fault.description : ""}`;
}

function resolutionMessage(fault, node) {
  if (fault && fault.fault_type === NODE_OFFLINE_TYPE) {
    return `Node ${nodeLabel(node, fault.streetlight_id)} is back online. Heartbeat resumed and the offline alert has been cleared.`;
  }
  return `Fault ${fault ? fault.fault_id : "—"} at Node ${nodeLabel(node, fault && fault.streetlight_id)} has been resolved. The node is back online.`;
}

module.exports = {
  POWER_FAULT_VOLTAGE_THRESHOLD,
  BULB_FAULT_CURRENT_THRESHOLD,
  HARDWARE_TELEMETRY_FRESH_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MIN,
  HARDWARE_FAULT_TYPES,
  NODE_OFFLINE_TYPE,
  AUTOMATIC_FAULT_TYPES,
  FAULT_SEVERITY,
  FAULT_DESCRIPTION,
  classifyHardwareState,
  CLOCK_SKEW_TOLERANCE_MS,
  parseTelemetryTimestamp,
  timestampAge,
  isHardwareTelemetryFresh,
  heartbeatState,
  planFaultActions,
  computeDesiredStatus,
  nodeLabel,
  faultAlertMessage,
  resolutionMessage
};

