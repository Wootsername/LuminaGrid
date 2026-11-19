// Trusted automatic fault lifecycle. No browser, firmware or Energy dependencies.
// Root transactions are deliberately limited to transitions/bootstrap/recovery:
// RTDB has no cross-location compare-and-swap below the common ancestor.
// Steady polls use bounded telemetry queries. See FAULT-TIMESTAMP-FIX.md.
const svc = require("./fault-service");
const FAULT_WATCH_INTERVAL_MS = 2000; // Fast prototype default; delay after each completed pass.

function nextNumber(root, counter, records, prefix, floor) {
  root.counter ||= {};
  let max = Math.max(floor, Number(root.counter[counter]) || 0);
  for (const id of Object.keys(records || {})) {
    if (new RegExp("^" + prefix + "[0-9]+$").test(id)) max = Math.max(max, Number(id.slice(1)));
  }
  if (!Number.isSafeInteger(max + 1)) throw new Error("ID counter exhausted: " + counter);
  root.counter[counter] = max + 1;
  return max + 1;
}
function nextFaultIdLocked(root) {
  return "f" + nextNumber(root, "fault", root.fault_report, "f", 500);
}
function buildNotificationPlanLocked(root, base) {
  return Object.entries(root.user || {}).filter(([, u]) => u && u.status === "Active")
    .map(([key, u]) => ({
      notification_id: "n" + String(nextNumber(root, "notification", root.notification, "n", 0)).padStart(3, "0"),
      fault_id: base.fault_id, user_id: u.user_id || key,
      notification_type: base.notification_type, message: base.message,
      status: "Unread", sent_at: base.sent_at
    }));
}
// Firebase orders timestamp strings lexically. This range excludes startup
// uptime-* values before limiting; otherwise one such value hides all ISO data.
// Include both second-only and millisecond ISO formats at each endpoint.
// A fixed upper bound keeps future samples visible to the shared freshness
// policy, which accepts only the bounded ESP32 clock-skew allowance.
const TELEMETRY_ISO_MIN = "2000-01-01T00:00:00.000Z";
const TELEMETRY_ISO_MAX = "9999-12-31T23:59:59Z";
const LATEST_READING_CANDIDATES = 20;

function latestReadingEntry(raw) {
  let best = null;
  for (const [key, reading] of Object.entries(raw || {})) {
    const ms = svc.parseTelemetryTimestamp(reading?.timestamp);
    if (!Number.isFinite(ms) || reading.timestamp < TELEMETRY_ISO_MIN || reading.timestamp > TELEMETRY_ISO_MAX) continue;
    // Parsed time matters: .123Z is later in time than Z within one second,
    // even though Firebase's string ordering puts the second-only value last.
    if (!best || ms > best.ms || (ms === best.ms && key > best.key)) best = { key, reading, ms };
  }
  return best;
}
function latestReading(raw) {
  const best = latestReadingEntry(raw);
  return best ? { ...best.reading, reading_id: best.reading.reading_id || best.key } : null;
}
function pendingFor(root, sid) {
  return Object.entries(root.fault_report || {}).filter(([, f]) =>
    f && f.status === "Pending" && String(f.streetlight_id) === String(sid))
    .map(([key, f]) => ({ ...f, fault_id: key }));
}
function stateRoot(root) {
  root.backend_state ||= {};
  root.backend_state.fault ||= { nodes: {}, events: {} };
  const state = root.backend_state.fault;
  state.nodes ||= {};
  state.events ||= {};
  return state;
}
function decisions(root, sid, reading, nowMs) {
  const node = (root.streetlight || {})[sid];
  const pending = pendingFor(root, sid);
  const heartbeatTimeoutMin = (root.system_config || {}).heartbeat_timeout_minutes;
  const plan = svc.planFaultActions({ node, reading, pending, heartbeatTimeoutMin, nowMs });
  const createTypes = [];
  const resolve = [];
  if (plan.hw?.kind === "ensure") {
    if (!pending.some(f => f.fault_type === plan.hw.type)) createTypes.push(plan.hw.type);
    resolve.push(...pending.filter(f => svc.HARDWARE_FAULT_TYPES.includes(f.fault_type) && f.fault_type !== plan.hw.type));
  } else if (plan.hw?.kind === "resolve") {
    resolve.push(...pending.filter(f => svc.HARDWARE_FAULT_TYPES.includes(f.fault_type)));
  }
  if (plan.offline === "create") createTypes.push(svc.NODE_OFFLINE_TYPE);
  if (plan.offline === "resolve") resolve.push(...pending.filter(f => f.fault_type === svc.NODE_OFFLINE_TYPE));
  const remaining = pending.filter(f => !resolve.some(r => r.fault_id === f.fault_id));
  const status = svc.computeDesiredStatus({ node, pending: remaining.concat(createTypes.map(fault_type => ({ fault_type, status: "Pending" }))), heartbeatTimeoutMin, nowMs });
  return { node, createTypes, resolve, status, plan };
}

// Diagnostics only: these helpers do not participate in classification or writes.
function timestampDiagnostic(value, nowMs) {
  const { parsedMs, rawAgeMs, effectiveAgeMs } = svc.timestampAge(value, nowMs);
  const valid = Number.isFinite(parsedMs);
  const usable = Number.isFinite(effectiveAgeMs);
  return { parsed_ms: valid ? parsedMs : null, age_ms: valid ? rawAgeMs : null,
    effective_age_ms: usable ? effectiveAgeMs : null,
    fresh: usable && effectiveAgeMs <= svc.HARDWARE_TELEMETRY_FRESH_MS,
    reason: !value ? "missing" : !valid ? "invalid" : !usable ? "future" :
      effectiveAgeMs > svc.HARDWARE_TELEMETRY_FRESH_MS ? "stale" : "fresh" };
}
function steadyReason(d, reading, sensor, heartbeat, classification) {
  if (heartbeat.reason === "missing") return "unprovisioned_never_heartbeated";
  if (heartbeat.reason === "invalid") return "heartbeat_timestamp_invalid";
  if (heartbeat.reason === "future") return "heartbeat_future";
  if (d.plan.heartbeat === "TIMED_OUT") return "offline_fault_already_pending";
  if (!reading) return sensor.reason === "invalid" ? "sensor_invalid" : "sensor_missing";
  if (sensor.reason !== "fresh") return "sensor_" + sensor.reason;
  if (!heartbeat.fresh) return "heartbeat_stale";
  if (classification === "DAYLIGHT") return "daylight";
  if (classification === "UNKNOWN") return "invalid_telemetry";
  if (classification === "BULB_FAULT" || classification === "POWER_FAULT") return "fault_already_pending";
  return d.status === "Faulty" ? "normal_other_fault_pending" : "normal_no_pending_fault";
}
function plannedAction(d, ns) {
  if (ns?.phase === "pending") return "RESUME";
  if (d.createTypes.length) return d.resolve.length ? "TRANSITION" :
    d.createTypes.includes(svc.NODE_OFFLINE_TYPE) ? "OFFLINE" : "CREATE";
  if (d.resolve.length) return "RESOLVE";
  if (d.node?.status !== d.status) return "STATUS";
  return ns ? "NONE" : "BOOTSTRAP";
}
function diagnostic(sid, root, reading, d, nowMs, metadata = {}) {
  const ns = root.backend_state?.fault?.nodes?.[sid];
  const sensor = timestampDiagnostic(reading?.timestamp, nowMs);
  if (!reading && metadata.latest_query_rejected_count > 0) sensor.reason = "invalid";
  const heartbeat = timestampDiagnostic(d.node?.last_seen, nowMs);
  const classification = svc.classifyHardwareState(reading) || "UNKNOWN";
  const pending = pendingFor(root, sid);
  const count = type => pending.filter(f => f.fault_type === type).length;
  const action = plannedAction(d, ns);
  // Explicit allowlist: never serialize snapshots, credentials, users or env.
  const scalar = v => v == null ? null : ["string", "number", "boolean"].includes(typeof v) ? v : "[non-scalar]";
  return { sid: String(sid), worker_now_utc: new Date(nowMs).toISOString(), worker_now_ms: nowMs,
    streetlight_status: d.node?.status ?? null,
    last_seen: scalar(d.node?.last_seen), heartbeat_parsed_ms: heartbeat.parsed_ms,
    heartbeat_age_ms: heartbeat.age_ms, heartbeat_effective_age_ms: heartbeat.effective_age_ms,
    heartbeat_fresh: heartbeat.fresh, clock_skew_tolerance_ms: svc.CLOCK_SKEW_TOLERANCE_MS,
    heartbeat_time_reason: heartbeat.reason, heartbeat_state: d.plan.heartbeat,
    heartbeat_timeout_minutes: root.system_config?.heartbeat_timeout_minutes ?? svc.DEFAULT_HEARTBEAT_TIMEOUT_MIN,
    reading_id: scalar(reading?.reading_id), sensor_timestamp: scalar(reading?.timestamp),
    sensor_parsed_ms: sensor.parsed_ms, sensor_age_ms: sensor.age_ms,
    sensor_effective_age_ms: sensor.effective_age_ms,
    sensor_fresh: sensor.fresh, sensor_time_reason: sensor.reason,
    ambient_light: scalar(reading?.ambient_light), voltage: scalar(reading?.voltage), current: scalar(reading?.current),
    ambient_light_type: typeof reading?.ambient_light, voltage_type: typeof reading?.voltage, current_type: typeof reading?.current,
    light_status: scalar(reading?.light_status), classification,
    hardware_telemetry_fresh: svc.isHardwareTelemetryFresh(reading, d.node, nowMs),
    pending_power_count: count("Power Fault"), pending_bulb_count: count("Bulb Fault"),
    pending_offline_count: count(svc.NODE_OFFLINE_TYPE),
    pending_other_count: pending.filter(f => !svc.AUTOMATIC_FAULT_TYPES.includes(f.fault_type)).length,
    desired_fault: d.plan.hw?.type ?? (d.plan.offline === "create" ? svc.NODE_OFFLINE_TYPE : null),
    create: d.createTypes.map(fault_type => ({ fault_type, severity: svc.FAULT_SEVERITY[fault_type] })),
    resolve_ids: d.resolve.map(f => f.fault_id), desired_status: d.status,
    backend_phase: ns?.phase ?? null, backend_sequence: ns?.sequence ?? null, backend_event_key: ns?.event_key ?? null,
    plan_action: action, steady: action === "NONE",
    steady_reason: action === "NONE" ? steadyReason(d, reading, sensor, heartbeat, classification) : null,
    ...metadata };
}
function eventSummary(root, key, committed) {
  const event = root?.backend_state?.fault?.events?.[key];
  if (!event) return { action: "NO_EVENT", committed };
  if (!committed) return { action: "REPLAY", committed, event_key: key };
  if (event.outcome === "superseded") return { action: "SUPERSEDED", committed, event_key: key };
  const faults = event.faults || [];
  const resolved = event.resolve_ids || [];
  return { action: faults.length ? resolved.length ? "TRANSITION" :
      faults.some(f => f.fault_type === svc.NODE_OFFLINE_TYPE) ? "OFFLINE" : "CREATE" : resolved.length ? "RESOLVE" : "STATUS",
    types: [...new Set(faults.map(f => f.fault_type).concat(resolved.map(id => root.fault_report?.[id]?.fault_type).filter(Boolean)))],
    fault_ids: faults.map(f => f.fault_id), resolve_ids: resolved,
    status: root.streetlight?.[event.sid]?.status ?? null, event_key: key, committed };
}
function formatWorkerResult(result) {
  return "[fault-worker] " + JSON.stringify(result);
}

function createFaultWorker(db, { clock = Date.now, debug = process.env.FAULT_DEBUG === "1", logger = console.log } = {}) {
  const emit = data => { if (debug) logger("[FAULT DEBUG] " + JSON.stringify(data, null, 2)); };
  async function readLatestSnapshot(sid, fixedNow) {
    const started = fixedNow ?? clock();
    const snap = await db.ref("sensor_reading/" + sid).orderByChild("timestamp")
      .startAt(TELEMETRY_ISO_MIN).endAt(TELEMETRY_ISO_MAX)
      .limitToLast(LATEST_READING_CANDIDATES).once("value");
    const raw = snap.val();
    const selected = latestReadingEntry(raw);
    const reading = selected ? { ...selected.reading, reading_id: selected.reading.reading_id || selected.key } : null;
    const keys = Object.keys(raw || {});
    const iteratedKeys = [];
    if (debug && typeof snap.forEach === "function") snap.forEach(child => { iteratedKeys.push(child.key); });
    return { reading, metadata: {
      latest_query_path: "sensor_reading/" + sid, latest_query_order_by: "timestamp", latest_query_limit: LATEST_READING_CANDIDATES,
      latest_query_start_at: TELEMETRY_ISO_MIN, latest_query_end_at: TELEMETRY_ISO_MAX,
      latest_query_rejected_count: Object.values(raw || {}).filter(r => !Number.isFinite(svc.parseTelemetryTimestamp(r?.timestamp))).length,
      latest_query_child_count: keys.length, query_snapshot_key: snap.key ?? null,
      latest_snapshot_key: selected?.key ?? null,
      snapshot_value_shape: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw,
      snapshot_for_each_keys: debug ? iteratedKeys : undefined,
      latest_query_started_at: new Date(started).toISOString(), latest_query_elapsed_ms: (fixedNow ?? clock()) - started
    } };
  }
  async function readLatestReading(sid) {
    return (await readLatestSnapshot(sid)).reading;
  }
  async function claimNode(sid, fixedNow) {
    let trace = null;
    let attempts = 0;
    const result = await db.ref().transaction(raw => {
      attempts++;
      // Firebase may first invoke a transaction with an empty local cache.
      // Propose null, rather than abort: the server then supplies current data.
      if (raw === null) return null;
      const root = raw;
      if (!root.streetlight?.[sid]) {
        trace = { sid, stage: "claim", claim_reason: "node_missing" };
        return;
      }
      const state = stateRoot(root);
      const old = state.nodes[sid];
      if (old?.phase === "pending") {
        trace = { sid, stage: "claim", claim_reason: "pending_event_in_flight", backend_event_key: old.event_key };
        return;
      }
      const nowMs = fixedNow ?? clock();
      const nowIso = new Date(nowMs).toISOString();
      // Recompute against the transaction's current data on EVERY retry.
      const reading = latestReading(root.sensor_reading?.[sid]);
      const d = decisions(root, sid, reading, nowMs);
      if (debug) trace = diagnostic(sid, root, reading, d, nowMs, { stage: "claim" });
      if (old && !d.createTypes.length && !d.resolve.length && d.node.status === d.status) return;
      const sequence = (old?.sequence || 0) + 1;
      const key = sid + "|" + sequence;
      const faults = d.createTypes.map(type => ({
        fault_id: nextFaultIdLocked(root), streetlight_id: d.node.streetlight_id ?? sid,
        reading_id: type === svc.NODE_OFFLINE_TYPE ? null : reading?.reading_id ?? null,
        fault_type: type, severity: svc.FAULT_SEVERITY[type], description: svc.FAULT_DESCRIPTION[type],
        status: "Pending", detected_at: nowIso, resolved_at: null
      }));
      const notifications = [];
      for (const f of faults) notifications.push(...buildNotificationPlanLocked(root, {
        fault_id: f.fault_id, notification_type: "Fault Alert",
        message: svc.faultAlertMessage(f, d.node), sent_at: nowIso
      }));
      // One consolidated full-recovery fan-out, including simultaneous
      // hardware + offline recovery. Transitions and partial repairs are silent.
      if (d.resolve.length && d.status === "Active") {
        const representative = [...d.resolve].sort((a, b) =>
          String(b.detected_at).localeCompare(String(a.detected_at)) || a.fault_id.localeCompare(b.fault_id))[0];
        notifications.push(...buildNotificationPlanLocked(root, {
          fault_id: representative.fault_id, notification_type: "Resolution",
          message: svc.resolutionMessage(representative, d.node), sent_at: nowIso
        }));
      }
      state.events[key] = { status: "pending", sid: String(sid), sequence,
        faults, resolve_ids: d.resolve.map(f => f.fault_id), notifications,
        desired_status: d.status, started_at: nowIso };
      state.nodes[sid] = { phase: "pending", sequence, event_key: key };
      return root;
    }, undefined, false);
    const root = result.snapshot.val();
    const ns = root?.backend_state?.fault?.nodes?.[sid];
    emit({ ...trace, stage: "claim", sid, transaction_attempts: attempts,
      claim_committed: result.committed, event_key: ns?.event_key ?? null,
      event_status: root?.backend_state?.fault?.events?.[ns?.event_key]?.status ?? null });
    return { committed: result.committed, eventKey: ns?.event_key,
      event: root?.backend_state?.fault?.events?.[ns?.event_key] };
  }
  async function applyEvent(key, _untrustedSnapshot, fixedNow) {
    let trace = null;
    let attempts = 0;
    // ALWAYS read the durable event inside the transaction. A delayed worker
    // holding a pending snapshot must never reopen a recovered fault or reset
    // a notification another user has already marked Read.
    const result = await db.ref().transaction(root => {
      attempts++;
      if (root === null) return null;
      const state = stateRoot(root);
      const ev = state.events[key];
      if (!ev || ev.status === "applied") return;
      const ns = state.nodes[ev.sid];
      if (ns?.event_key !== key || ns.phase !== "pending") throw new Error("Fault event ownership mismatch: " + key);
      if (!root.streetlight?.[ev.sid]) throw new Error("Pending fault event references removed node: " + ev.sid);
      const nowMs = fixedNow ?? clock();
      const current = decisions(root, ev.sid, latestReading(root.sensor_reading?.[ev.sid]), nowMs);
      if (debug) trace = diagnostic(ev.sid, root, latestReading(root.sensor_reading?.[ev.sid]), current, nowMs, { stage: "apply" });
      const expectedTypes = (ev.faults || []).map(f => f.fault_type).sort();
      // A pending claim is recoverable intent, not permission to act on stale
      // telemetry after a long outage. Retire obsolete intent without side
      // effects, then the next claim handles current conditions. Reserved IDs
      // remain consumed, never reused.
      if (JSON.stringify(current.createTypes.sort()) !== JSON.stringify(expectedTypes) ||
          JSON.stringify(current.resolve.map(f => f.fault_id).sort()) !== JSON.stringify([...(ev.resolve_ids || [])].sort())) {
        ev.status = "applied";
        ev.outcome = "superseded";
        ev.applied_at = new Date(nowMs).toISOString();
        ns.phase = "applied";
        return root;
      }
      root.fault_report ||= {};
      for (const record of ev.faults || []) {
        if (root.fault_report[record.fault_id]) throw new Error("Reserved fault ID collision: " + record.fault_id);
        root.fault_report[record.fault_id] = record;
      }
      for (const id of ev.resolve_ids || []) {
        const rec = root.fault_report[id];
        if (rec?.status === "Pending") Object.assign(rec, { status: "Resolved", resolved_at: ev.started_at });
      }
      const status = svc.computeDesiredStatus({ node: root.streetlight[ev.sid],
        pending: pendingFor(root, ev.sid), heartbeatTimeoutMin: root.system_config?.heartbeat_timeout_minutes, nowMs });
      root.streetlight[ev.sid].status = status;
      for (const n of ev.notifications || []) {
        // A manual fault or timeout since claim can invalidate full recovery.
        if (n.notification_type === "Resolution" && status !== "Active") continue;
        root.notification ||= {};
        if (root.notification[n.notification_id]) throw new Error("Reserved notification ID collision: " + n.notification_id);
        root.notification[n.notification_id] = n;
      }
      ev.status = "applied";
      ev.applied_at = new Date(nowMs).toISOString();
      ns.phase = "applied";
      return root;
    }, undefined, false);
    const root = result.snapshot.val();
    const summary = eventSummary(root, key, result.committed);
    emit({ ...trace, stage: "apply", event_key: key, transaction_attempts: attempts,
      apply_committed: result.committed, apply_action: summary.action,
      event_status: root?.backend_state?.fault?.events?.[key]?.status ?? null,
      event_outcome: root?.backend_state?.fault?.events?.[key]?.outcome ?? null,
      final_status: summary.status ?? null });
    return { applied: result.committed, replay: !result.committed, ...summary };
  }
  async function processNode(sid, input, fixedNow, inputMetadata = {}) {
    const ns = input.backend_state?.fault?.nodes?.[sid];
    let resumed = null;
    if (ns?.phase === "pending") resumed = await applyEvent(ns.event_key, null, fixedNow);
    const { reading, metadata } = await readLatestSnapshot(sid, fixedNow);
    const nowMs = fixedNow ?? clock();
    const d = decisions(input, sid, reading, nowMs);
    if (debug) emit(diagnostic(sid, input, reading, d, nowMs, { stage: "poll", ...inputMetadata, ...metadata }));
    // This is the original gate. Logging must not change planning behavior.
    if (!ns || ns.phase === "pending" || d.createTypes.length || d.resolve.length || d.node.status !== d.status) {
      const claim = await claimNode(sid, fixedNow);
      if (claim.event?.status === "pending") {
        const applied = await applyEvent(claim.eventKey, null, fixedNow);
        return { sid, ...applied, claim_committed: claim.committed };
      }
      if (resumed?.applied) return { sid, ...resumed, claim_committed: claim.committed };
      return { sid, action: "NO_CHANGE", committed: claim.committed };
    }
    return { sid, action: "STEADY", steady: true };
  }
  async function runOnce(fixedNow) {
    const inputStarted = fixedNow ?? clock();
    const paths = ["streetlight", "fault_report", "system_config", "backend_state/fault/nodes"];
    const snaps = await Promise.all(paths.map(p => db.ref(p).once("value")));
    const input = { streetlight: snaps[0].val() || {}, fault_report: snaps[1].val() || {},
      system_config: snaps[2].val() || {}, backend_state: { fault: { nodes: snaps[3].val() || {} } } };
    const inputMetadata = { inputs_read_started_at: new Date(inputStarted).toISOString(),
      inputs_read_elapsed_ms: (fixedNow ?? clock()) - inputStarted };
    const results = [];
    for (const sid of Object.keys(input.streetlight)) {
      try { results.push(await processNode(sid, input, fixedNow, inputMetadata)); }
      catch (e) { results.push({ sid, error: e.message }); }
    }
    return results;
  }
  return { runOnce, processNode, claimNode, applyEvent, readLatestReading };
}
async function main() {
  const { db, admin, DATABASE_URL } = require("./firebase-admin"); // Existing secure loader only.
  if (process.env.FAULT_DEBUG === "1") {
    // URL.origin excludes credentials, query strings and fragments.
    console.log("[FAULT DEBUG] " + JSON.stringify({ stage: "startup", worker_file: __filename,
      pid: process.pid, database_origin: new URL(DATABASE_URL).origin,
      worker_now_utc: new Date().toISOString() }, null, 2));
  }
  const worker = createFaultWorker(db);
  const watch = process.argv.includes("--watch");
  const interval = Number(process.env.FAULT_POLL_INTERVAL_MS || FAULT_WATCH_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval < 1000) throw new Error("FAULT_POLL_INTERVAL_MS must be at least 1000");
  try {
    do {
      try {
        const results = await worker.runOnce();
        for (const result of results) console.log(formatWorkerResult(result));
        if (!watch && results.some(r => r.error)) process.exitCode = 1;
      } catch (e) {
        if (!watch) throw e;
        console.error("[fault-worker] pass failed:", e.message);
      }
      // Awaited loop: a slow pass cannot overlap the next pass.
      if (watch) await new Promise(resolve => setTimeout(resolve, interval));
    } while (watch);
  } finally { await admin.app().delete(); }
}
if (require.main === module) main().catch(e => { console.error("[fault-worker] fatal:", e.message); process.exitCode = 1; });
module.exports = { createFaultWorker, nextFaultIdLocked, buildNotificationPlanLocked, formatWorkerResult };
