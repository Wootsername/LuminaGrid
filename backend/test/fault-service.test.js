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

for (const invalid of ["", " ", true, false, [], {}, NaN, Infinity]) {
  assert(svc.classifyHardwareState(rd(1, invalid, 0.8)) === null, "invalid voltage rejected: " + String(invalid));
  assert(svc.classifyHardwareState(rd(invalid, 12, 0.8)) === null, "invalid LDR rejected: " + String(invalid));
}
assert(!svc.isHardwareTelemetryFresh(rd(1, 12, 0.8, NOW + 16000), node(), NOW), "future sensor rejected");
assert(!svc.isHardwareTelemetryFresh(rd(1, 12, 0.8), node(new Date(NOW + 16000).toISOString()), NOW), "future heartbeat rejected");
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 0.8, NOW - 90000), node(), NOW), "exact freshness boundary accepted");

console.log("== strict UTC telemetry timestamps (uptime regression) ==");
for (const value of ["2026-10-15T18:08:27Z", "2026-10-15T18:08:27.123Z", "2024-02-29T00:00:00Z"]) {
  assert(svc.parseTelemetryTimestamp(value) === Date.parse(value), "strict parser accepts " + value);
}
for (const value of ["uptime-41992", "41992", "", null, undefined, "not-a-date", {}, [],
  ["2026-10-15T18:08:27Z"], 41992, new Date(NOW), true, " 2026-10-15T18:08:27Z",
  "2026-10-15T18:08:27Z\n", "2026-10-15", "2026-10-15 18:08:27Z", "2026-10-15T18:08:27",
  "2026-10-15T18:08:27+00:00", "2026-10-15T18:08:27.1Z", "2026-10-15T18:08:27.1234Z",
  "2026-02-30T18:08:27Z", "2026-02-29T00:00:00Z", "2026-10-15T24:00:00Z",
  "2026-10-15T18:08:60Z", "2026-13-01T00:00:00Z"]) {
  assert(Number.isNaN(svc.parseTelemetryTimestamp(value)), "strict parser rejects " + String(value));
}
{
  const original = Date.parse;
  let calls = 0;
  try {
    // Even an engine that generously parses every string cannot validate uptime.
    Date.parse = () => { calls++; return NOW; };
    assert(Number.isNaN(svc.parseTelemetryTimestamp("uptime-41992")), "uptime rejected before Date.parse, even with finite engine result");
    assert(calls === 0, "invalid structure is never forwarded to Date.parse");
  } finally { Date.parse = original; }
}
assert(!svc.isHardwareTelemetryFresh({ timestamp: "uptime-41992" }, node(), NOW), "uptime sensor is never fresh");
assert(!svc.isHardwareTelemetryFresh(rd(1, 11.28, 0.22), { last_seen: "uptime-41992" }, NOW), "uptime heartbeat is never fresh");
assert(svc.heartbeatState({ last_seen: "uptime-41992" }, 10, NOW) === "NEVER_SEEN", "uptime heartbeat is not a wall-clock heartbeat");


console.log("== bounded ESP32 clock skew ==");
assert(svc.CLOCK_SKEW_TOLERANCE_MS === 15000, "shared future tolerance is exactly 15 seconds");
const skewNow = Date.parse("2026-10-22T06:58:35Z");
for (const offset of [7000, 14000, 15000, 15001, 16000, 3600000, -30000]) {
  const timestamp = new Date(skewNow + offset).toISOString();
  const n = { status: "Active", last_seen: timestamp };
  const reading = { timestamp, ambient_light: 1, voltage: 11, current: 1 };
  const accepted = offset <= 15000;
  const age = svc.timestampAge(timestamp, skewNow);
  assert(age.rawAgeMs === -offset, "raw age retained: " + offset);
  assert(accepted ? age.effectiveAgeMs === Math.max(0, -offset) : Number.isNaN(age.effectiveAgeMs),
    "bounded effective age: " + offset);
  assert(svc.heartbeatState(n, 10, skewNow) === (accepted ? "OK" : "NEVER_SEEN"), "heartbeat policy: " + offset);
  assert(svc.isHardwareTelemetryFresh(reading, n, skewNow) === accepted, "both ESP32 timestamps: " + offset);
  assert(svc.computeDesiredStatus({ node: n, pending: [], heartbeatTimeoutMin: 10, nowMs: skewNow }) ===
    (accepted ? "Active" : "Offline"), "desired status: " + offset);
  // Exercise sensor skew separately from heartbeat skew.
  assert(svc.isHardwareTelemetryFresh(reading, { last_seen: new Date(skewNow).toISOString() }, skewNow) === accepted,
    "independent sensor skew: " + offset);
}
for (const timeout of [2, 10]) {
  const last_seen = new Date(skewNow - timeout * 60000).toISOString();
  assert(svc.heartbeatState({ last_seen }, timeout, skewNow) === "OK", "timeout boundary unchanged: " + timeout);
  assert(svc.heartbeatState({ last_seen }, timeout, skewNow + 1) === "TIMED_OUT", "real timeout: " + timeout);
  assert(svc.computeDesiredStatus({ node: { last_seen }, pending: [], heartbeatTimeoutMin: timeout, nowMs: skewNow + 1 }) ===
    "Offline", "real timeout stays Offline: " + timeout);
}
assert(svc.isHardwareTelemetryFresh(rd(1, 12, 1, NOW - 90000), node(), NOW), "90-second telemetry boundary unchanged");
assert(!svc.isHardwareTelemetryFresh(rd(1, 12, 1, NOW - 90001), node(), NOW), "90-second telemetry expiry unchanged");

console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
if (fails.length) {
  fails.forEach((f) => console.log("  FAILED: " + f));
  process.exit(1);
}

