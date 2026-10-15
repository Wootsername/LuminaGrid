// ============================================================
// LuminaGrid backend — Fault SERVICE (pure classifier) tests
// Run: node test/fault-service.test.js
// ============================================================
const path = require("path");
const svc = require(path.join(__dirname, "..", "fault-service.js"));

let pass = 0;
const fails = [];
function assert(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fails.push(label); console.log("  FAIL " + label); }
}

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const rd = (ambient_light, voltage, current, tsMs) => ({
  reading_id: "r1",
  streetlight_id: "1",
  ambient_light,
  voltage,
  current,
  timestamp: new Date(tsMs == null ? NOW - 5000 : tsMs).toISOString()
});
const node = (lastSeenMs) => ({
  streetlight_id: "1",
  status: "Active",
  last_seen: lastSeenMs == null ? new Date(NOW - 5000).toISOString() : lastSeenMs
});

console.log("== 1-8. hardware classifier ==");
assert(svc.classifyHardwareState(rd(0, 12.0, 0.0)) === "DAYLIGHT", "1 daylight (ambient 0) regardless of V/I");
assert(svc.classifyHardwareState(rd(1, 2.5, 0.3)) === "POWER_FAULT", "2 Power Fault (night, V < 3.0)");
assert(svc.classifyHardwareState(rd(1, 12.0, 0.2)) === "BULB_FAULT", "3 Bulb Fault (night, V ok, I < 0.50)");
assert(svc.classifyHardwareState(rd(1, 12.0, 0.8)) === "NORMAL", "4 normal night");
assert(svc.classifyHardwareState(rd(200, 12.0, 0.8)) === null, "5 invalid LDR value -> UNKNOWN/null");
assert(svc.classifyHardwareState(null) === null, "6 missing telemetry -> null");
assert(svc.classifyHardwareState({ timestamp: rd().timestamp }) === null, "6 partial telemetry -> null");
assert(svc.classifyHardwareState(rd(1, undefined, 0.8)) === null, "6 missing voltage -> null");
assert(svc.classifyHardwareState(rd(1, 3.0, 0.2)) === "BULB_FAULT", "7 exact 3.0 V is NOT power fault (bulb path)");
assert(svc.classifyHardwareState(rd(1, 3.0, 0.5)) === "NORMAL", "7 exact 3.0 V + exact 0.50 A -> NORMAL");
assert(svc.classifyHardwareState(rd(1, 12.0, 0.5)) === "NORMAL", "8 exact 0.50 A boundary -> NORMAL");
assert(svc.classifyHardwareState(rd(1, 12.0, 0.499)) === "BULB_FAULT", "8 just below 0.50 A -> BULB");

console.log("== 9-12. telemetry freshness (90 s window) ==");
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 0.8), node(), NOW) === true, "9 fresh sensor + fresh heartbeat");
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 0.8, NOW - 91000), node(), NOW) === false, "10 stale sensor -> no create/resolve");
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 0.8), node(new Date(NOW - 91000).toISOString()), NOW) === false, "11 stale heartbeat -> no create/resolve");
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 0.8, NOW - 5000), { last_seen: "not-a-date" }, NOW) === false, "12 invalid heartbeat timestamp -> false");
assert(svc.isHardwareTelemetryFresh({ timestamp: "???" }, node(), NOW) === false, "12 invalid sensor timestamp -> false");
assert(svc.isHardwareTelemetryFresh(null, node(), NOW) === false, "12 missing reading -> false");

console.log("== 5/6/21/23/24/28. plan (pure decisions) ==");
const planOf = (o) => svc.planFaultActions(Object.assign({ heartbeatTimeoutMin: 10, nowMs: NOW }, o));
assert(planOf({ node: node(), reading: rd(0, 12, 0.8), pending: [] }).hw === null, "daylight -> no hardware action");
{
  const pend = [{ fault_id: "f1", streetlight_id: "1", fault_type: "Power Fault", status: "Pending" }];
  const p = planOf({ node: node(), reading: rd(0, 12, 0.8), pending: pend });
  assert(p.hw === null, "21 pending Power + DAYLIGHT -> keep Pending (no resolve)");
  const stale = planOf({ node: node(new Date(NOW - 11 * 60000).toISOString()), reading: rd(1, 2.5, 0.2), pending: pend });
  assert(stale.hw === null && stale.offline === "create", "28 stale heartbeat -> NO Power/Bulb, only offline");
}
{
  const never = { streetlight_id: "5", status: "Offline" }; // no last_seen
  const p = planOf({ node: never, reading: null, pending: [] });
  assert(p.offline === null && p.hw === null, "23 never-heartbeated -> nothing at all");
  assert(svc.computeDesiredStatus({ node: never, pending: [], heartbeatTimeoutMin: 10, nowMs: NOW, hasReading: false }) === "Offline",
    "23 unprovisioned node status stays Offline");
}
assert(planOf({ node: node(new Date(NOW - 11 * 60000).toISOString()), reading: rd(1, 12, 0.8), pending: [] }).offline === "create",
  "24 heartbeat timeout -> create Node Offline");
{
  const offPend = [{ fault_id: "f9", streetlight_id: "1", fault_type: "Node Offline", status: "Pending" }];
  assert(planOf({ node: node(), reading: null, pending: offPend }).offline === "resolve", "26 heartbeat back -> resolve Node Offline");
}

console.log("== 40-43. node status authority ==");
const hwPend = [{ fault_id: "f1", streetlight_id: "1", fault_type: "Power Fault", status: "Pending" }];
assert(svc.computeDesiredStatus({ node: node(), pending: hwPend, heartbeatTimeoutMin: 10, nowMs: NOW, hasReading: true }) === "Faulty",
  "40 hardware fault -> Faulty");
assert(svc.computeDesiredStatus({ node: node(new Date(NOW - 11 * 60000).toISOString()), pending: [], heartbeatTimeoutMin: 10, nowMs: NOW, hasReading: true }) === "Offline",
  "41 heartbeat timeout -> Offline");
assert(svc.computeDesiredStatus({ node: node(), pending: [], heartbeatTimeoutMin: 10, nowMs: NOW, hasReading: true }) === "Active",
  "42 no pending -> Active");

console.log("== severity / description / ownership / wording ==");
assert(svc.FAULT_SEVERITY["Power Fault"] === "High", "Power Fault severity High");
assert(svc.FAULT_SEVERITY["Bulb Fault"] === "Medium", "Bulb Fault severity Medium");
assert(svc.FAULT_DESCRIPTION["Power Fault"].includes("below 3.0 V"), "Power description wording (3.0 V)");
assert(svc.FAULT_DESCRIPTION["Bulb Fault"].includes("below 0.50 A"), "Bulb description wording (0.50 A)");
assert(JSON.stringify(svc.AUTOMATIC_FAULT_TYPES) === JSON.stringify(["Power Fault", "Bulb Fault", "Node Offline"]),
  "automatic ownership types are Power/Bulb/Node Offline");
assert(svc.faultAlertMessage({ fault_type: "Bulb Fault", description: "x", streetlight_id: "1" }, { node_id: "LG-01", pole_number: "P-001" })
  .indexOf("Fault detected at Node LG-01 (P-001)") === 0, "fault alert message wording parity");
assert(svc.resolutionMessage({ fault_id: "f501", fault_type: "Node Offline", streetlight_id: "1" }, { pole_number: "P-001" })
  .indexOf("is back online. Heartbeat resumed") > 0, "Node Offline resolution wording");

console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
if (fails.length) {
  fails.forEach((f) => console.log("  FAILED: " + f));
  process.exit(1);
}

