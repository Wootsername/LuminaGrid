const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFaultWorker } = require("../fault-worker");
const NOW = Date.parse("2026-10-16T12:00:00Z");
const iso = (t = NOW) => new Date(t).toISOString();
const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));

// Optimistic RTDB model: retries callbacks after ANY overlapping write,
// exercises an empty local cache, and commits the entire returned tree at once.
// No Admin SDK / credentials / network access. Hooks simulate lost acknowledgments.
function fixture(options = {}) {
  const store = {
    streetlight: { 1: { streetlight_id: 1, status: "Active", last_seen: iso(), node_id: "LG-01" } },
    user: { u1: { user_id: "u1", status: "Active" }, u2: { user_id: "u2", status: "Active" }, u3: { user_id: "u3", status: "Deactivated" } },
    system_config: { heartbeat_timeout_minutes: 10 },
    sensor_reading: { 1: {} }
  };
  const read = p => p.split("/").filter(Boolean).reduce((v, k) => v?.[k], store) ?? null;
  function write(p, v) {
    const keys = p.split("/").filter(Boolean);
    if (!keys.length) { Object.keys(store).forEach(k => delete store[k]); Object.assign(store, clone(v)); return; }
    let cur = store;
    for (const k of keys.slice(0, -1)) cur = cur[k] ||= {};
    cur[keys.at(-1)] = clone(v);
  }
  const db = {
    transactions: 0, queries: [], beforeCommit: null, afterCommit: null,
    ref(p = "") {
      return {
        async once() { const value = clone(read(p)); return { val: () => value }; },
        orderByChild(field) {
          let lower, upper, limit;
          const rank = value => value == null ? 0 : value === false ? 1 : value === true ? 2 :
            typeof value === "number" ? 3 : typeof value === "string" ? 4 : 5;
          const compare = (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
          const query = {
            startAt(value) { lower = value; return query; },
            endAt(value) { upper = value; return query; },
            limitToLast(value) { limit = value; return query; },
            async once() {
              db.queries.push({ path: p, field, lower, upper, limit });
              let entries = Object.entries(read(p) || {}).filter(([, r]) =>
                (lower === undefined || compare(r?.[field], lower) >= 0) &&
                (upper === undefined || compare(r?.[field], upper) <= 0))
                .sort(([ak, a], [bk, b]) => compare(a?.[field], b?.[field]) || (ak < bk ? -1 : ak > bk ? 1 : 0));
              if (limit !== undefined) entries = entries.slice(-limit);
              return { key: p.split("/").at(-1), val: () => clone(Object.fromEntries(entries)),
                forEach(fn) { for (const [key, value] of entries) { if (fn({ key, val: () => clone(value) }) === true) return true; } return false; } };
            }
          };
          return query;
        },
        async transaction(update) {
          db.transactions++;
          // Firebase's first callback may see null even on a populated DB.
          const empty = update(null);
          if (empty === undefined) return { committed: false, snapshot: { val: () => clone(read(p)) } };
          for (let retry = 0; retry < 50; retry++) {
            const before = JSON.stringify(store);
            const next = update(clone(read(p)));
            if (next === undefined) return { committed: false, snapshot: { val: () => clone(read(p)) } };
            await Promise.resolve();
            if (db.beforeCommit) { const hook = db.beforeCommit; db.beforeCommit = null; await hook(next, p); }
            if (before !== JSON.stringify(store)) continue;
            write(p, next);
            if (db.afterCommit) { const hook = db.afterCommit; db.afterCommit = null; await hook(next, p); }
            const value = clone(read(p));
            return { committed: true, snapshot: { val: () => value } };
          }
          throw new Error("retry limit");
        }
      };
    }
  };
  const worker = createFaultWorker(db, { clock: () => NOW, debug: false, ...options });
  function reading(kind, age = 0, key = "r_10_new") {
    store.sensor_reading[1] = { [key]: { reading_id: key, timestamp: iso(NOW - age),
      ambient_light: kind === "day" ? 0 : 1, voltage: kind === "power" ? 2.9 : 3,
      current: kind === "bulb" ? 0.49 : 0.5 } };
  }
  function legacy(type, id = "f510") {
    store.fault_report ||= {};
    store.fault_report[id] = { fault_id: id, streetlight_id: 1, fault_type: type, status: "Pending", detected_at: iso(NOW - 60000) };
  }
  const faults = (type, status) => Object.values(store.fault_report || {}).filter(f => (!type || f.fault_type === type) && (!status || f.status === status));
  const notifications = type => Object.values(store.notification || {}).filter(n => !type || n.notification_type === type);
  async function run() { const r = await worker.runOnce(NOW); assert.ok(r.every(n => !n.error), JSON.stringify(r)); return r; }
  return { store, db, worker, reading, legacy, faults, notifications, run };
}
for (const [kind, type, severity] of [["power", "Power Fault", "High"], ["bulb", "Bulb Fault", "Medium"]]) {
  test(`${type}: creation, persistence, fan-out, concurrent workers, recovery`, async () => {
    const f = fixture(); f.reading(kind);
    await Promise.all([f.run(), f.run()]);
    for (let i = 0; i < 3; i++) await f.run();
    assert.equal(f.faults(type, "Pending").length, 1);
    assert.equal(f.faults()[0].fault_id, "f501");
    assert.equal(f.faults()[0].severity, severity);
    assert.equal(f.faults()[0].reading_id, "r_10_new");
    assert.equal(f.store.streetlight[1].status, "Faulty");
    assert.equal(f.notifications("Fault Alert").length, 2);
    assert.deepEqual(f.notifications().map(n => n.user_id).sort(), ["u1", "u2"]);
    assert.ok(f.notifications().every(n => n.status === "Unread" && n.sent_at && n.fault_id && n.notification_id));
    f.reading("normal"); await Promise.all([f.run(), f.run()]); await f.run();
    assert.equal(f.faults(type, "Pending").length, 0);
    assert.equal(f.store.streetlight[1].status, "Active");
    assert.equal(f.notifications("Resolution").length, 2);
  });
  test(`${type}: adoption, daylight, stale reading and heartbeat preserve Pending`, async () => {
    const f = fixture(); f.legacy(type); f.reading(kind); await f.run();
    assert.equal(f.faults().length, 1); assert.equal(f.notifications().length, 0);
    f.reading("day"); await f.run(); assert.equal(f.faults(type, "Pending").length, 1);
    f.reading("normal", 90001); await f.run(); assert.equal(f.faults(type, "Pending").length, 1);
    f.reading("normal"); f.store.streetlight[1].last_seen = iso(NOW - 90001);
    await f.run(); assert.equal(f.faults(type, "Pending").length, 1);
  });
  test(`${type}: transition establishes replacement atomically, no full recovery`, async () => {
    const f = fixture(); f.reading(kind); await f.run();
    f.reading(kind === "power" ? "bulb" : "power");
    const before = clone(f.store);
    const c = await f.worker.claimNode("1", NOW);
    assert.deepEqual(f.store.fault_report, before.fault_report);
    await f.worker.applyEvent(c.eventKey, null, NOW);
    assert.equal(f.faults(type, "Resolved").length, 1);
    assert.equal(f.faults(null, "Pending").length, 1);
    assert.equal(f.store.streetlight[1].status, "Faulty");
    assert.equal(f.notifications("Resolution").length, 0);
  });
}
test("legacy duplicates and both fault types: adopt target, close other type, consolidate recovery", async () => {
  const f = fixture(); f.legacy("Power Fault", "f510"); f.legacy("Power Fault", "f511"); f.legacy("Bulb Fault", "f512");
  f.reading("bulb"); await f.run();
  assert.equal(f.faults("Power Fault", "Pending").length, 0);
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1); assert.equal(f.notifications().length, 0);
  f.legacy("Bulb Fault", "f513"); f.reading("normal"); await f.run();
  assert.equal(f.faults(null, "Pending").length, 0); assert.equal(f.notifications("Resolution").length, 2);
});
test("recovery with another manual Pending fault stays Faulty and sends no Resolution", async () => {
  const f = fixture(); f.reading("power"); await f.run(); f.legacy("Wiring Damage", "f900");
  f.reading("normal"); await f.run();
  assert.equal(f.store.streetlight[1].status, "Faulty"); assert.equal(f.notifications("Resolution").length, 0);
});
test("unprovisioned/dynamically registered Node 5 remains Offline with no side effects", async () => {
  const f = fixture(); f.reading("normal"); await f.run();
  f.store.streetlight[5] = { streetlight_id: 5, status: "Offline" }; await f.run();
  assert.equal(f.store.streetlight[5].status, "Offline"); assert.equal(f.faults().length, 0); assert.equal(f.notifications().length, 0);
});
test("timeout creates one Offline, no hardware faults; heartbeat recovery", async () => {
  const f = fixture(); f.store.streetlight[1].last_seen = iso(NOW - 600001); f.reading("power");
  await f.run(); await f.run();
  assert.equal(f.faults().length, 1); assert.equal(f.faults("Node Offline", "Pending").length, 1);
  assert.equal(f.store.streetlight[1].status, "Offline"); assert.equal(f.notifications().length, 2);
  f.store.streetlight[1].last_seen = iso(); f.reading("normal"); await f.run();
  assert.equal(f.faults("Node Offline", "Resolved").length, 1); assert.equal(f.store.streetlight[1].status, "Active");
  assert.equal(f.notifications("Resolution").length, 2);
});
test("configured timeout, never-seen and stale sensor never create hardware faults", async () => {
  const f = fixture(); f.store.system_config.heartbeat_timeout_minutes = 20;
  f.store.streetlight[1].last_seen = iso(NOW - 11 * 60000); f.reading("power"); await f.run();
  assert.equal(f.faults().length, 0);
  delete f.store.streetlight[1].last_seen; await f.run();
  assert.equal(f.faults().length, 0); assert.equal(f.store.streetlight[1].status, "Offline");
  f.store.streetlight[1].last_seen = iso(); f.reading("power", 90001); await f.run(); assert.equal(f.faults().length, 0);
});
for (const kind of ["bulb", "normal"]) test(`offline reconnect with ${kind}: correct final status and consolidated messaging`, async () => {
  const f = fixture(); f.reading("power"); await f.run();
  f.store.streetlight[1].last_seen = iso(NOW - 600001); await f.run();
  f.store.streetlight[1].last_seen = iso(); f.reading(kind); await Promise.all([f.run(), f.run()]);
  assert.equal(f.faults("Node Offline", "Pending").length, 0);
  assert.equal(f.store.streetlight[1].status, kind === "bulb" ? "Faulty" : "Active");
  assert.equal(f.notifications("Resolution").length, kind === "bulb" ? 0 : 2);
});
test("crash after claim/allocation: restart uses the same IDs", async () => {
  const f = fixture(); f.reading("power"); const c = await f.worker.claimNode("1", NOW);
  assert.equal(c.event.status, "pending"); assert.equal(c.event.faults[0].fault_id, "f501");
  assert.equal(f.faults().length, 0); assert.equal(f.notifications().length, 0);
  assert.equal(f.store.counter.notification, 2);
  const restarted = createFaultWorker(f.db, { clock: () => NOW }); await restarted.runOnce(NOW);
  assert.equal(f.faults().length, 1); assert.equal(f.notifications().length, 2);
  assert.equal(f.store.counter.fault, 501); assert.equal(f.store.counter.notification, 2);
  assert.equal(f.store.backend_state.fault.events[c.eventKey].status, "applied");
});
for (const recovery of [false, true]) test(`atomic ${recovery ? "resolution" : "creation"}: failure before commit leaves no partial writes`, async () => {
  const f = fixture(); f.reading("power");
  if (recovery) { await f.run(); f.reading("normal"); }
  const c = await f.worker.claimNode("1", NOW); const before = clone(f.store);
  f.db.beforeCommit = () => { throw new Error("crash before atomic commit"); };
  await assert.rejects(f.worker.applyEvent(c.eventKey, null, NOW), /crash/);
  assert.deepEqual(f.store, before); // fault/status/notifications/applied-marker are all unchanged
  await f.run();
  assert.equal(f.faults(null, "Pending").length, recovery ? 0 : 1);
  assert.equal(f.notifications(recovery ? "Resolution" : "Fault Alert").length, 2);
});
test("lost commit acknowledgment and delayed stale replay cannot reopen faults or reset Read", async () => {
  const f = fixture(); f.reading("power"); const c = await f.worker.claimNode("1", NOW);
  f.db.afterCommit = () => { throw new Error("lost acknowledgment"); };
  await assert.rejects(f.worker.applyEvent(c.eventKey, null, NOW), /acknowledgment/);
  assert.equal(f.store.backend_state.fault.events[c.eventKey].status, "applied");
  f.reading("normal"); await f.run();
  f.notifications()[0].status = "Read";
  const before = clone(f.store);
  const replay = await f.worker.applyEvent(c.eventKey, c.event, NOW);
  assert.equal(replay.replay, true); assert.deepEqual(f.store, before);
});
test("conflicting telemetry at claim causes transaction retry with fresh classification", async () => {
  const f = fixture(); f.reading("power");
  f.db.beforeCommit = () => f.reading("bulb");
  const c = await f.worker.claimNode("1", NOW); await f.worker.applyEvent(c.eventKey, null, NOW);
  assert.equal(f.faults("Power Fault").length, 0); assert.equal(f.faults("Bulb Fault").length, 1);
});
test("root/counter contention with remaining browser notifications cannot collide", async () => {
  const f = fixture(); f.reading("power");
  f.store.counter = { notification: 50, fault: 1 };
  f.store.notification = { n100: { notification_id: "n100", status: "Read" } }; f.legacy("Wiring Damage", "f999");
  const [c, browser] = await Promise.all([f.worker.claimNode("1", NOW), f.db.ref("counter/notification").transaction(n => (n || 0) + 1)]);
  await f.worker.applyEvent(c.eventKey, null, NOW);
  assert.equal(f.faults("Power Fault")[0].fault_id, "f1000");
  assert.ok(f.notifications("Fault Alert").every(n => n.notification_id !== "n" + String(browser.snapshot.val()).padStart(3, "0")));
  assert.equal(f.store.notification.n100.status, "Read");
});
test("manual fault arriving after recovery claim suppresses full-recovery message and Active", async () => {
  const f = fixture(); f.reading("power"); await f.run(); f.reading("normal");
  const c = await f.worker.claimNode("1", NOW); f.legacy("Wiring Damage", "f900");
  await f.worker.applyEvent(c.eventKey, null, NOW);
  assert.equal(f.store.streetlight[1].status, "Faulty"); assert.equal(f.notifications("Resolution").length, 0);
});
test("latest query uses timestamp despite reboot/nonmonotonic keys; steady polls avoid root transactions", async () => {
  const f = fixture(); f.reading("normal", 0, "r_1_new");
  for (let i = 0; i < 30; i++) f.store.sensor_reading[1]["r_9999_old_" + i] = {
    timestamp: iso(NOW - 60000), ambient_light: 1, voltage: 1, current: 0
  };
  await f.run(); const count = f.db.transactions; await f.run();
  assert.equal(f.db.transactions, count); assert.equal(f.faults().length, 0);
  assert.ok(f.db.queries.every(q => q.field === "timestamp" && q.limit === 20 &&
    q.lower === "2000-01-01T00:00:00.000Z" && q.upper === "9999-12-31T23:59:59Z"));
  assert.equal(f.store.backend_state.fault.nodes[1].phase, "applied");
});

for (const recovery of [false, true]) test(`pending ${recovery ? "recovery" : "creation"} cannot act on telemetry that became stale during downtime`, async () => {
  const f = fixture(); f.reading("power");
  if (recovery) { await f.run(); f.reading("normal"); }
  const c = await f.worker.claimNode("1", NOW);
  await f.worker.applyEvent(c.eventKey, null, NOW + 91000);
  assert.equal(f.store.backend_state.fault.events[c.eventKey].outcome, "superseded");
  assert.equal(f.faults(null, "Pending").length, recovery ? 1 : 0);
  assert.equal(f.notifications("Resolution").length, 0);
});

// Reported physical-test values. Run against the unchanged worker first:
// this verifies whether the supplied evidence alone reproduces steady:true.
test("live A/B/F/G: healthy bootstrap -> actual bulb values -> repeats -> daylight -> night recovery", async () => {
  const f = fixture();
  const start = Date.parse("2026-10-15T18:08:30Z");
  const put = (offset, ambient_light, current) => {
    const now = start + offset;
    const key = "r_104381_58c25405_" + offset;
    f.store.sensor_reading[1][key] = { ambient_light, current, light_status: "OFF",
      power_consumption: 11.28 * current, reading_id: key, streetlight_id: 1,
      timestamp: iso(now - 3000).replace(".000Z", "Z"), voltage: 11.28 };
    f.store.streetlight[1].last_seen = iso(now - 2000).replace(".000Z", "Z");
    return now;
  };
  await f.worker.runOnce(put(0, 1, 2.0));
  assert.equal(f.faults().length, 0);
  const result = await f.worker.runOnce(put(10000, 1, 0.22));
  assert.notEqual(result[0].steady, true);
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
  assert.equal(f.store.streetlight[1].status, "Faulty");
  assert.equal(f.notifications("Fault Alert").length, 2);
  for (const offset of [20000, 30000, 40000]) await f.worker.runOnce(put(offset, 1, 0.362));
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
  assert.equal(f.notifications("Fault Alert").length, 2);
  await f.worker.runOnce(put(50000, 0, 0));
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
  await f.worker.runOnce(put(60000, 1, 2.0));
  assert.equal(f.faults("Bulb Fault", "Resolved").length, 1);
  assert.equal(f.store.streetlight[1].status, "Active");
  assert.equal(f.notifications("Resolution").length, 2);
});
test("live C: queried parent map unwraps real child fields, types and reading_id", async () => {
  const f = fixture();
  const expected = { ambient_light: 1, current: 0.362, light_status: "OFF", power_consumption: 4.11,
    reading_id: "r_104381_58c25405", streetlight_id: 1, timestamp: "2026-10-15T18:08:27Z", voltage: 11.35 };
  f.store.sensor_reading[1] = { r_104381_58c25405: expected };
  assert.deepEqual(await f.worker.readLatestReading("1"), expected);
  delete f.store.sensor_reading[1].r_104381_58c25405.reading_id;
  assert.equal((await f.worker.readLatestReading("1")).reading_id, "r_104381_58c25405");
  f.store.sensor_reading[1] = null;
  assert.equal(await f.worker.readLatestReading("1"), null);
});
test("live D: UTC ISO timestamp ordering wins over reading-key order", async () => {
  const f = fixture();
  f.store.sensor_reading[1] = {
    r_999_old: { timestamp: "2026-10-15T18:08:10Z", ambient_light: 0, voltage: 11.28, current: 0 },
    r_fault: { timestamp: "2026-10-15T18:08:20Z", ambient_light: 1, voltage: 11.28, current: 0.22 },
    r_100_new: { timestamp: "2026-10-15T18:08:30Z", ambient_light: 1, voltage: 11.28, current: 0.36 }
  };
  assert.equal((await f.worker.readLatestReading("1")).reading_id, "r_100_new");
});
test("live E: UTC age is milliseconds; numeric strings supported, light_status ignored", () => {
  const svc = require("../fault-service");
  const now = Date.parse("2026-10-15T18:08:30Z");
  const node = { last_seen: "2026-10-15T18:08:28Z" };
  const reading = { timestamp: "2026-10-15T18:08:27Z", ambient_light: 1, voltage: 11.28, current: 0.22, light_status: "OFF" };
  assert.equal(now - Date.parse(node.last_seen), 2000);
  assert.equal(now - Date.parse(reading.timestamp), 3000);
  assert.equal(svc.isHardwareTelemetryFresh(reading, node, now), true);
  assert.equal(svc.classifyHardwareState(reading), "BULB_FAULT");
  assert.equal(svc.classifyHardwareState({ ...reading, ambient_light: "1", voltage: "11.28", current: "0.22", light_status: "ON" }), "BULB_FAULT");
  assert.equal(svc.classifyHardwareState({ ...reading, ambient_light: true }), null);
  assert.deepEqual(svc.planFaultActions({ node, reading, pending: [], nowMs: now }).hw, { kind: "ensure", type: "Bulb Fault" });
});

function debugFixture() {
  const logs = [];
  const f = fixture({ debug: true, logger: line => logs.push(line) });
  return { ...f, logs, blocks: () => logs.map(line => JSON.parse(line.slice("[FAULT DEBUG] ".length))) };
}
test("debug: actual bulb evidence, query snapshot, full plan, claim and apply are visible without secrets", async () => {
  const f = debugFixture(); f.reading("normal", 3000); await f.run(); f.logs.length = 0;
  f.reading("bulb", 3000, "r_104381_58c25405");
  Object.assign(f.store.sensor_reading[1].r_104381_58c25405, { voltage: 11.28, current: 0.22, light_status: "OFF", password: "DO_NOT_PRINT" });
  f.store.streetlight[1].last_seen = iso(NOW - 2000);
  f.store.private_key = "DO_NOT_PRINT";
  f.store.user.u1.password = "DO_NOT_PRINT";
  const result = await f.run();
  const poll = f.blocks().find(b => b.stage === "poll");
  assert.equal(poll.query_snapshot_key, "1");
  assert.equal(poll.latest_snapshot_key, "r_104381_58c25405");
  assert.deepEqual(poll.snapshot_for_each_keys, ["r_104381_58c25405"]);
  assert.equal(poll.latest_query_child_count, 1);
  assert.equal(poll.snapshot_value_shape, "object");
  assert.equal(poll.classification, "BULB_FAULT");
  assert.equal(poll.sensor_age_ms, 3000); assert.equal(poll.heartbeat_age_ms, 2000);
  assert.equal(poll.sensor_fresh, true); assert.equal(poll.heartbeat_fresh, true);
  assert.equal(poll.pending_bulb_count, 0); assert.equal(poll.streetlight_status, "Active");
  assert.deepEqual(poll.create, [{ fault_type: "Bulb Fault", severity: "Medium" }]);
  assert.deepEqual(poll.resolve_ids, []); assert.equal(poll.desired_status, "Faulty");
  assert.equal(poll.plan_action, "CREATE"); assert.equal(poll.steady, false);
  assert.ok(f.blocks().some(b => b.stage === "claim" && b.claim_committed));
  assert.ok(f.blocks().some(b => b.stage === "apply" && b.apply_action === "CREATE" && b.final_status === "Faulty"));
  assert.equal(result[0].action, "CREATE"); assert.deepEqual(result[0].fault_ids, ["f501"]);
  assert.doesNotMatch(f.logs.join(""), /DO_NOT_PRINT|private_key|password|service_account|access_token/);
});
for (const reason of ["sensor_missing", "sensor_stale", "sensor_invalid", "sensor_future", "heartbeat_stale",
  "heartbeat_future", "heartbeat_timestamp_invalid", "daylight", "fault_already_pending",
  "normal_no_pending_fault", "unprovisioned_never_heartbeated", "offline_fault_already_pending", "invalid_telemetry", "normal_other_fault_pending"]) {
  test(`debug: every steady state explains ${reason}`, async () => {
    const f = debugFixture(); f.reading("normal", 3000);
    const reading = () => f.store.sensor_reading[1].r_10_new;
    if (reason === "sensor_missing") f.store.sensor_reading[1] = null;
    if (reason === "sensor_stale") reading().timestamp = iso(NOW - 90001);
    if (reason === "sensor_invalid") reading().timestamp = "2026-10-32T12:00:00Z";
    if (reason === "sensor_future") reading().timestamp = iso(NOW + 16000);
    if (reason === "heartbeat_stale") f.store.streetlight[1].last_seen = iso(NOW - 90001);
    if (reason === "heartbeat_future") f.store.streetlight[1].last_seen = iso(NOW + 16000);
    if (reason === "heartbeat_timestamp_invalid") f.store.streetlight[1].last_seen = "bad";
    if (reason === "daylight") reading().ambient_light = 0;
    if (reason === "fault_already_pending") f.reading("bulb", 3000);
    if (reason === "unprovisioned_never_heartbeated") delete f.store.streetlight[1].last_seen;
    if (reason === "offline_fault_already_pending") f.store.streetlight[1].last_seen = iso(NOW - 600001);
    if (reason === "invalid_telemetry") reading().ambient_light = true;
    if (reason === "normal_other_fault_pending") f.legacy("Wiring Damage");
    await f.run(); f.logs.length = 0;
    const result = await f.run();
    assert.equal(result[0].steady, true);
    const poll = f.blocks().find(b => b.stage === "poll");
    assert.equal(poll.steady, true); assert.equal(poll.plan_action, "NONE");
    assert.equal(poll.steady_reason, reason);
  });
}
test("debug defaults to absent and concise normal summaries contain no sensor fields", async () => {
  const { formatWorkerResult } = require("../fault-worker");
  const logs = []; const f = fixture({ logger: line => logs.push(line) });
  f.reading("bulb"); const results = await f.run();
  assert.deepEqual(logs, []);
  const line = formatWorkerResult(results[0]);
  assert.match(line, /CREATE/); assert.match(line, /Bulb Fault/); assert.match(line, /f501/); assert.match(line, /Faulty/);
  assert.doesNotMatch(line, /ambient_light|sensor_timestamp|last_seen|voltage|current/);
  f.reading("normal"); const recovery = await f.run();
  assert.equal(recovery[0].action, "RESOLVE"); assert.equal(recovery[0].status, "Active");
});
test("FAULT_DEBUG=1 opts in; other values do not enable diagnostics", async () => {
  const saved = process.env.FAULT_DEBUG;
  try {
    const f = fixture(); f.reading("normal");
    for (const setting of [undefined, "0", "true", "1"]) {
      if (setting === undefined) delete process.env.FAULT_DEBUG; else process.env.FAULT_DEBUG = setting;
      const logs = [];
      const worker = createFaultWorker(f.db, { clock: () => NOW, logger: line => logs.push(line) });
      await worker.runOnce(NOW);
      assert.equal(logs.length > 0, setting === "1");
    }
  } finally { if (saved === undefined) delete process.env.FAULT_DEBUG; else process.env.FAULT_DEBUG = saved; }
});

const UPTIME_KEY = "r_41992_2c3f6af2";
const UPTIME_READING = { reading_id: UPTIME_KEY, timestamp: "uptime-41992",
  ambient_light: 0, voltage: 0, current: 0.114 };
function addUptime(f) { f.store.sensor_reading[1][UPTIME_KEY] = clone(UPTIME_READING); }

test("uptime regression: old unrestricted query proves why the invalid record wins", async () => {
  const f = fixture(); f.reading("bulb", 3000, "r_live"); addUptime(f);
  const oldSnapshot = await f.db.ref("sensor_reading/1").orderByChild("timestamp").limitToLast(1).once("value");
  assert.deepEqual(Object.keys(oldSnapshot.val()), [UPTIME_KEY]);
  assert.ok("uptime-41992" > f.store.sensor_reading[1].r_live.timestamp);
});
test("uptime regression: latest valid ISO reading wins over exact live uptime record", async () => {
  const f = fixture(); f.reading("bulb", 3000, "r_live"); addUptime(f);
  Object.assign(f.store.sensor_reading[1].r_live, { voltage: 11.28, current: 0.22 });
  assert.equal((await f.worker.readLatestReading("1")).reading_id, "r_live");
});
test("uptime regression: healthy bootstrap then live bulb must create, not stay steady", async () => {
  const f = debugFixture(); f.reading("normal", 5000, "r_normal"); await f.run();
  f.store.sensor_reading[1].r_live = { reading_id: "r_live", timestamp: iso(NOW - 3000),
    ambient_light: 1, voltage: 11.28, current: 0.22, light_status: "OFF" };
  addUptime(f); f.logs.length = 0;
  const results = await f.run();
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
  assert.equal(f.store.streetlight[1].status, "Faulty");
  assert.equal(f.notifications("Fault Alert").length, 2);
  const poll = f.blocks().find(b => b.stage === "poll");
  assert.equal(poll.latest_snapshot_key, "r_live"); assert.equal(poll.sensor_fresh, true);
  assert.equal(poll.classification, "BULB_FAULT"); assert.equal(poll.plan_action, "CREATE");
  assert.equal(results[0].action, "CREATE");
  assert.deepEqual(f.store.sensor_reading[1][UPTIME_KEY], UPTIME_READING);
});

for (const invalids of [[], ["uptime-41992"], ["uptime-41992", "uptime-999999"],
  ["not-a-date", "2026-99-99T25:99:99Z", "2026-10-16T12:00:00junk"], [null, 41992, {}, []]]) {
  test("mixed timestamps: newest valid ISO survives " + JSON.stringify(invalids), async () => {
    const f = debugFixture();
    f.store.sensor_reading[1] = {
      r_999_old: { timestamp: iso(NOW - 10000), ambient_light: 0, voltage: 0, current: 0 },
      r_100_new: { timestamp: iso(NOW - 3000), ambient_light: 1, voltage: 11.28, current: 0.22 }
    };
    invalids.forEach((timestamp, i) => { f.store.sensor_reading[1]["invalid_" + i] = { timestamp, ambient_light: 0, voltage: 0, current: 0 }; });
    assert.equal((await f.worker.readLatestReading("1")).reading_id, "r_100_new");
    await f.run();
    assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
    assert.equal(f.blocks().find(b => b.stage === "poll").latest_snapshot_key, "r_100_new");
  });
}
test("mixed seconds/milliseconds: newest parsed instant beats lexical ISO order in poll, claim and apply", async () => {
  const f = fixture();
  f.store.sensor_reading[1] = {
    z_old: { timestamp: "2026-10-16T11:59:59Z", ambient_light: 0, voltage: 0, current: 0 },
    a_new: { timestamp: "2026-10-16T11:59:59.123Z", ambient_light: 1, voltage: 11.28, current: 0.22 }
  };
  addUptime(f);
  assert.equal((await f.worker.readLatestReading("1")).reading_id, "a_new");
  await f.run(); assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
});
for (const [type, voltage, severity] of [["Bulb Fault", 11.28, "Medium"], ["Power Fault", 0, "High"]]) {
  test(`uptime lifecycle: ${type}, repeats, daylight and recovery preserve invalid history`, async () => {
    const f = fixture(); f.store.streetlight[1].last_seen = iso(NOW - 2000); addUptime(f);
    const put = (age, ambient_light, current, volts = voltage) => {
      const key = "r_live_" + age;
      f.store.sensor_reading[1][key] = { reading_id: key, timestamp: iso(NOW - age), ambient_light,
        voltage: volts, current, light_status: "OFF" };
    };
    put(9000, 1, 0.22); await Promise.all([f.run(), f.run()]);
    assert.equal(f.faults(type, "Pending").length, 1);
    assert.equal(f.faults(type)[0].severity, severity);
    assert.equal(f.store.streetlight[1].status, "Faulty");
    assert.equal(f.notifications("Fault Alert").length, 2);
    for (const age of [8000, 7000, 6000]) { put(age, 1, 0.22); await f.run(); }
    assert.equal(f.faults(type, "Pending").length, 1); assert.equal(f.notifications("Fault Alert").length, 2);
    put(5000, 0, 0); await f.run(); assert.equal(f.faults(type, "Pending").length, 1);
    put(3000, 1, 2, 11.2); await Promise.all([f.run(), f.run()]); await f.run();
    assert.equal(f.faults(type, "Resolved").length, 1);
    assert.equal(f.store.streetlight[1].status, "Active");
    assert.equal(f.notifications("Resolution").length, 2);
    assert.deepEqual(f.store.sensor_reading[1][UPTIME_KEY], UPTIME_READING);
  });
}
test("uptime-only sensor history leaves f516-style heartbeat outage/recovery intact", async () => {
  const f = fixture(); addUptime(f);
  f.legacy("Wiring Damage", "f515"); f.store.fault_report.f515.status = "Resolved";
  f.store.streetlight[1].last_seen = iso(NOW - 600001);
  await f.run(); await f.run();
  assert.equal(f.faults("Node Offline", "Pending").length, 1);
  assert.equal(f.faults("Node Offline")[0].fault_id, "f516");
  assert.equal(f.store.streetlight[1].status, "Offline");
  assert.equal(f.notifications("Fault Alert").length, 2);
  f.store.streetlight[1].last_seen = iso(NOW - 1000);
  await f.run(); await f.run();
  assert.equal(f.faults("Node Offline", "Resolved").length, 1);
  assert.equal(f.store.streetlight[1].status, "Active");
  assert.equal(f.notifications("Resolution").length, 2);
  assert.deepEqual(f.store.sensor_reading[1][UPTIME_KEY], UPTIME_READING);
});
test("invalid-only candidates yield no hardware action; future ISO still fails the freshness gate", async () => {
  const f = debugFixture(); addUptime(f);
  f.store.sensor_reading[1].malformed = { timestamp: "2026-10-32T12:00:00Z", ambient_light: 1, voltage: 0, current: 0 };
  await f.run();
  assert.equal(f.faults().length, 0); assert.equal(await f.worker.readLatestReading("1"), null);
  assert.equal(f.blocks().find(b => b.stage === "poll").sensor_time_reason, "invalid");
  delete f.store.sensor_reading[1].malformed;
  f.legacy("Bulb Fault"); f.logs.length = 0;
  f.store.sensor_reading[1].future = { timestamp: iso(NOW + 16000), ambient_light: 1, voltage: 0, current: 0 };
  await f.run();
  const poll = f.blocks().find(b => b.stage === "poll");
  assert.equal(poll.latest_snapshot_key, "future"); assert.equal(poll.sensor_time_reason, "future");
  assert.equal(poll.sensor_fresh, false);
  assert.equal(f.faults("Power Fault").length, 0); assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
});
test("strict heartbeat diagnostics reject uptime as invalid instead of a future date", async () => {
  const f = debugFixture(); f.reading("bulb", 3000); f.store.streetlight[1].last_seen = "uptime-41992";
  await f.run();
  const poll = f.blocks().find(b => b.stage === "poll");
  assert.equal(poll.heartbeat_time_reason, "invalid"); assert.equal(poll.heartbeat_parsed_ms, null);
  assert.equal(poll.heartbeat_fresh, false); assert.equal(f.faults().length, 0);
});
test("bounded candidates: exclude uptime before limit and skip malformed ISO-looking candidates", async () => {
  const f = debugFixture();
  for (let i = 1; i <= 60; i++) f.store.sensor_reading[1]["old_" + i] = { timestamp: iso(NOW - i * 10000), ambient_light: 0, voltage: 0, current: 0 };
  for (let i = 0; i < 30; i++) f.store.sensor_reading[1]["uptime_" + i] = { timestamp: "uptime-" + (41992 + i) };
  f.store.sensor_reading[1].invalid = { timestamp: "2026-10-32T12:00:00Z" };
  f.store.sensor_reading[1].live = { timestamp: iso(NOW - 3000), ambient_light: 1, voltage: 11.28, current: 0.22 };
  await f.run();
  const poll = f.blocks().find(b => b.stage === "poll");
  assert.equal(poll.latest_query_limit, 20); assert.equal(poll.latest_query_child_count, 20);
  assert.equal(poll.latest_query_rejected_count, 1); assert.equal(poll.latest_snapshot_key, "live");
  assert.ok(poll.snapshot_for_each_keys.every(k => !k.startsWith("uptime_")));
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
});
test("transaction retry and pending-event apply use the same strict selector as polling", async () => {
  const f = fixture(); f.reading("bulb", 3000);
  f.db.beforeCommit = () => addUptime(f);
  const claim = await f.worker.claimNode("1", NOW);
  assert.equal(claim.event.faults[0].fault_type, "Bulb Fault");
  await f.worker.applyEvent(claim.eventKey, null, NOW);
  assert.equal(f.faults("Bulb Fault", "Pending").length, 1);
  assert.equal(f.store.backend_state.fault.events[claim.eventKey].outcome, undefined);
});

for (const skew of [7000, 14000, 15000, 15001, 16000, 3600000, -30000]) {
  test("clock skew: worker poll/claim/apply agree for offset " + skew, async () => {
    const f = debugFixture();
    const now = Date.parse("2026-10-22T06:58:35Z");
    const accepted = skew <= 15000;
    f.store.streetlight[1].last_seen = iso(now + skew);
    f.store.sensor_reading[1] = { sample: { timestamp: iso(now + skew),
      ambient_light: 1, voltage: 0, current: 0, light_status: "OFF" } };
    const committedStatuses = [];
    f.db.afterCommit = next => { committedStatuses.push(next.streetlight[1].status); };
    await f.worker.runOnce(now);
    const poll = f.blocks().find(b => b.stage === "poll");
    assert.equal(poll.heartbeat_age_ms, -skew);
    assert.equal(poll.heartbeat_effective_age_ms, accepted ? Math.max(0, -skew) : null);
    assert.equal(poll.heartbeat_fresh, accepted);
    assert.equal(poll.sensor_fresh, accepted);
    assert.equal(poll.heartbeat_state, accepted ? "OK" : "NEVER_SEEN");
    assert.equal(poll.heartbeat_time_reason, accepted ? "fresh" : "future");
    assert.equal(poll.sensor_time_reason, accepted ? "fresh" : "future");
    assert.equal(poll.clock_skew_tolerance_ms, 15000);
    assert.equal(f.store.streetlight[1].status, accepted ? "Faulty" : "Offline");
    assert.equal(f.faults("Power Fault", "Pending").length, accepted ? 1 : 0);
    assert.equal(f.faults("Node Offline").length, 0);
    for (const stage of ["claim", "apply"]) {
      const block = f.blocks().find(b => b.stage === stage && b.heartbeat_state);
      assert.ok(block, stage);
      assert.equal(block.heartbeat_state, accepted ? "OK" : "NEVER_SEEN");
    }
    if (accepted) assert.ok(committedStatuses.every(status => status !== "Offline"));
  });
}
test("exact captured +7026ms heartbeat remains Active before and after wall-clock catches up", async () => {
  const f = debugFixture();
  f.store.streetlight[1].last_seen = "2026-10-22T06:58:42Z";
  f.store.sensor_reading[1] = { row: { timestamp: "2026-10-22T06:58:42Z",
    ambient_light: 0, voltage: 11, current: 0, light_status: "OFF" } };
  for (const now of ["2026-10-22T06:58:34.974Z", "2026-10-22T06:58:47.870Z"]) {
    await f.worker.runOnce(Date.parse(now));
    assert.equal(f.store.streetlight[1].status, "Active");
    assert.equal(f.faults("Node Offline").length, 0);
  }
  const polls = f.blocks().filter(b => b.stage === "poll");
  assert.equal(polls[0].heartbeat_age_ms, -7026);
  assert.equal(polls[0].heartbeat_effective_age_ms, 0);
  assert.ok(polls.every(p => p.heartbeat_state === "OK" && p.heartbeat_fresh));
});
test("day-night-day partial telemetry arrival never creates an Offline transition", async () => {
  const f = debugFixture();
  f.store.streetlight[1].last_seen = iso(NOW + 7000);
  f.reading("day", -7000);
  await f.run();
  const row = f.store.sensor_reading[1].r_10_new;
  for (const patch of [
    { timestamp: iso(NOW + 14000) }, { ambient_light: 1 },
    { light_status: "ON" }, { voltage: 11, current: 1 },
    { timestamp: iso(NOW + 15000) }, { light_status: "OFF" },
    { ambient_light: 0 }, { current: 0 }
  ]) {
    Object.assign(row, patch);
    // The mock transaction replaces the tree, so copy back the evolving sample.
    f.store.sensor_reading[1].r_10_new = clone(row);
    await f.run();
    assert.notEqual(f.store.streetlight[1].status, "Offline");
    assert.equal(f.faults("Node Offline").length, 0);
  }
  assert.ok(f.blocks().filter(b => b.stage === "poll").every(b => b.heartbeat_state === "OK"));
});
test("claim retries and pending apply accept refreshed slightly-future ESP32 timestamps", async () => {
  const f = fixture(); f.reading("power");
  f.db.beforeCommit = () => {
    f.store.streetlight[1].last_seen = iso(NOW + 7000);
    f.store.sensor_reading[1].r_10_new.timestamp = iso(NOW + 7000);
  };
  const claim = await f.worker.claimNode("1", NOW);
  f.store.streetlight[1].last_seen = iso(NOW + 14000);
  f.store.sensor_reading[1].r_10_new.timestamp = iso(NOW + 14000);
  await f.worker.applyEvent(claim.eventKey, null, NOW);
  assert.equal(f.store.streetlight[1].status, "Faulty");
  assert.equal(f.faults("Power Fault", "Pending").length, 1);
  assert.equal(f.faults("Node Offline").length, 0);
});

for (const [age, status] of [[14900, "Active"], [15000, "Active"], [15100, "Offline"]]) {
  test("prototype 0.25-minute timeout: heartbeat age " + age, async () => {
    const f = fixture(); f.store.system_config.heartbeat_timeout_minutes = 0.25;
    f.store.streetlight[1].last_seen = iso(NOW - age);
    f.reading("normal"); await f.run();
    assert.equal(f.store.streetlight[1].status, status);
    assert.equal(f.faults("Node Offline", "Pending").length, status === "Offline" ? 1 : 0);
  });
}
for (const [kind, status] of [["power", "Faulty"], ["normal", "Active"]]) {
  test("prototype Faulty -> Offline -> " + status + " on reconnect", async () => {
    const f = fixture(); f.store.system_config.heartbeat_timeout_minutes = 0.25;
    f.reading("power"); f.store.streetlight[1].last_seen = iso(NOW - 14900);
    await f.run(); assert.equal(f.store.streetlight[1].status, "Faulty");
    f.store.streetlight[1].last_seen = iso(NOW - 15100);
    await f.run(); assert.equal(f.store.streetlight[1].status, "Offline");
    assert.equal(f.faults("Power Fault", "Pending").length, 1);
    assert.equal(f.faults("Node Offline", "Pending").length, 1);
    f.store.streetlight[1].last_seen = iso(); f.reading(kind);
    await f.run(); assert.equal(f.store.streetlight[1].status, status);
    assert.equal(f.faults("Node Offline", "Pending").length, 0);
    assert.equal(f.faults("Power Fault", "Pending").length, kind === "power" ? 1 : 0);
  });
}
for (const [env, expected] of [[{}, 2000], [{ FAULT_POLL_INTERVAL_MS: "3200" }, 3200]]) {
  test("fault watch awaits each pass before " + expected + "ms delay", async () => {
    const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
    const stop = new Error("stop fake watch"), pending = [], timers = [];
    let active = 0, maxActive = 0, calls = 0, deletes = 0, waits = 0;
    const workerStub = { async runOnce() {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try { return await new Promise(resolve => pending.push(resolve)); }
      finally { active--; }
    } };
    const context = vm.createContext({
      require(name) {
        if (name === "./fault-service") return {};
        if (name === "./firebase-admin") return { db: {},
          admin: { app: () => ({ delete: async () => { deletes++; } }) },
          DATABASE_URL: "https://example.invalid" };
        throw new Error("unexpected require " + name);
      },
      module: { exports: {} }, process: { env, argv: ["--watch"], exitCode: 0 },
      console: { log() {}, error() {} }, workerStub,
      setTimeout(resolve, ms) {
        assert.equal(ms, expected);
        if (++waits === 2) throw stop;
        timers.push(resolve);
      }
    });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../fault-worker.js"), "utf8"), context);
    vm.runInContext("createFaultWorker = () => workerStub", context);
    const finished = assert.rejects(vm.runInContext("main()", context), error => error === stop);
    await flush();
    assert.equal(calls, 1); assert.equal(active, 1); assert.equal(timers.length, 0);
    await flush(); assert.equal(calls, 1);
    pending[0]([]); await flush();
    assert.equal(active, 0); assert.equal(timers.length, 1); assert.equal(calls, 1);
    timers[0](); await flush();
    assert.equal(calls, 2); assert.equal(active, 1); assert.equal(waits, 1);
    pending[1]([]); await finished;
    assert.equal(maxActive, 1); assert.equal(deletes, 1); assert.equal(waits, 2);
  });
}
