// Offline regression harness: real planner/worker, in-memory RTDB, no Admin SDK.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const svc = require("../energy-service");
const NOW = Date.parse("2026-10-22T15:15:24Z");
const iso = ms => new Date(ms).toISOString();
const row = (ms, watts = 14) => ({ timestamp: iso(ms), power_consumption: watts });
const stateAt = (ms, watts = 14, id = "baseline") =>
  ({ last_timestamp: iso(ms), last_power_w: watts, last_reading_id: id });
const clone = x => x == null ? null : JSON.parse(JSON.stringify(x));
const expected = 14 * 10000 / 3600000 / 1000;
const approx = (a, b) => assert.ok(Math.abs(a - b) <= 0.00000051, a + " ~= " + b);

function fixture(state = stateAt(NOW - 10000), history = { t2: row(NOW) }, env = {}) {
  const store = { backend_state: { energy: {} }, sensor_reading: { 1: clone(history) },
    streetlight: { 1: { streetlight_id: 1 } }, system_config: { energy_rate_per_kwh: 18.5 } };
  if (state) store.backend_state.energy[1] = clone(state);
  const logs = [], writes = [], locks = {};
  const read = p => p.split("/").filter(Boolean).reduce((v, k) => v?.[k], store) ?? null;
  function write(p, value) {
    const keys = p.split("/"); let cur = store;
    for (const key of keys.slice(0, -1)) cur = cur[key] ||= {};
    cur[keys.at(-1)] = clone(value); writes.push(p);
  }
  const lock = (p, fn) => locks[p] = (locks[p] || Promise.resolve()).then(fn, fn);
  const db = { ref(p) { return {
    async once() { const value = clone(read(p)); return { val: () => value }; },
    async set(v) { return lock(p, () => write(p, v)); },
    async transaction(fn) { return lock(p, () => {
      const next = fn(clone(read(p)));
      if (next === undefined) return { committed: false };
      write(p, next); return { committed: true };
    }); }
  }; } };
  const context = vm.createContext({
    require: name => name === "./firebase-admin" ? { db } : require("../" + name.slice(2)),
    module: { exports: {} }, process: { env, argv: [] },
    console: { log: (...v) => logs.push(v.join(" ")), error: (...v) => logs.push(v.join(" ")) },
    setInterval() { throw new Error("Tests cannot start a live polling loop"); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../energy-worker.js"), "utf8"), context);
  const worker = context.module.exports;
  return { store, logs, writes, worker,
    pass: (nowMs = NOW, debug = true) => worker.processNode("1", 18.5, { nowMs, debug,
      logger: text => logs.push(text) }),
    blocks: () => logs.filter(s => s.startsWith("[ENERGY DEBUG] ")).map(s => JSON.parse(s.slice(15))),
    total: () => store.energy_monthly?.["2026-10"]?.nodes?.[1]?.total_kwh || 0 };
}

test("A: 14 W baseline and next reading 10s later commit one interval", async () => {
  const f = fixture(); const result = await f.pass();
  assert.equal(result.intervals, 1); approx(f.total(), expected);
});
test("B: first pass establishes newest baseline; later T2/T3 uploads integrate", async () => {
  const f = fixture(null, { t1: row(NOW - 20000) });
  assert.equal((await f.pass()).intervals, 0); assert.equal(f.total(), 0);
  f.store.sensor_reading[1].t2 = row(NOW - 10000);
  f.store.sensor_reading[1].t3 = row(NOW);
  assert.equal((await f.pass()).intervals, 2); approx(f.total(), 2 * expected);
  assert.equal((await f.pass()).intervals, 0);
});
test("C: mixed uptime and ISO rows cannot poison the baseline", async () => {
  const f = fixture(stateAt(NOW - 10000), {
    old: { timestamp: "uptime-41992", power_consumption: 0.07 },
    t1: row(NOW - 10000), t2: row(NOW)
  });
  assert.equal((await f.pass()).intervals, 1);
  assert.equal(f.store.backend_state.energy[1].last_timestamp, iso(NOW));
  f.store.sensor_reading[1].t3 = row(NOW + 10000);
  assert.equal((await f.pass(NOW + 10000)).intervals, 1);
  approx(f.total(), 2 * expected);
});
for (const timestamp of ["uptime-41992", "malformed", "2026-02-30T00:00:00Z",
  "+041992-01-01T00:00:00.000Z", iso(NOW + 3600000)]) {
  test("D/E: unusable persisted cursor recovers with zero historical energy: " + timestamp, async () => {
    const f = fixture({ ...stateAt(NOW - 10000), last_timestamp: timestamp },
      { t1: row(NOW - 10000), t2: row(NOW) });
    // Existing totals/markers are retained exactly during recovery.
    f.store.energy_monthly = { "2026-10": { total_kwh: 2, nodes: { 1: { total_kwh: 2 } },
      today: { "2026-10-22": 2 }, _applied: { preserved: true } } };
    const aggregates = clone(f.store.energy_monthly);
    const result = await f.pass();
    assert.equal(result.intervals, 0); assert.equal(result.bootstrap, true);
    assert.deepEqual(f.store.energy_monthly, aggregates);
    assert.equal(f.store.backend_state.energy[1].last_timestamp, iso(NOW));
    assert.deepEqual(f.writes, ["backend_state/energy/1"]);
    f.store.sensor_reading[1].t3 = row(NOW + 10000);
    assert.equal((await f.pass(NOW + 10000)).intervals, 1);
    approx(f.total(), 2 + expected);
    assert.equal((await f.pass(NOW + 10000)).intervals, 0);
  });
}
test("invalid state with no usable readings is left untouched until a safe baseline arrives", async () => {
  const f = fixture({ ...stateAt(NOW), last_timestamp: "uptime-41992" },
    { bad: { timestamp: "uptime-41992", power_consumption: 14 } });
  const before = clone(f.store.backend_state);
  assert.equal((await f.pass()).intervals, 0);
  assert.deepEqual(f.store.backend_state, before);
  assert.equal(f.total(), 0);
  f.store.sensor_reading[1].good = row(NOW);
  assert.equal((await f.pass()).bootstrap, true);
  assert.equal(f.total(), 0);
});
test("F: 120s gap adds nothing, advances baseline, and next 10s interval resumes", async () => {
  const f = fixture(stateAt(NOW - 120000));
  assert.equal((await f.pass()).intervals, 0); assert.equal(f.total(), 0);
  assert.equal(f.store.backend_state.energy[1].last_timestamp, iso(NOW));
  f.store.sensor_reading[1].next = row(NOW + 10000);
  assert.equal((await f.pass(NOW + 10000)).intervals, 1);
  approx(f.total(), expected);
});
test("G: zero-watt interval is processed once while its energy stays zero", async () => {
  const f = fixture(stateAt(NOW - 10000, 0), { t2: row(NOW, 0) });
  assert.equal((await f.pass()).intervals, 1); assert.equal(f.total(), 0);
  assert.equal(f.blocks().at(-1).energy_increment_kwh, 0);
  assert.equal((await f.pass()).intervals, 0);
});
for (const skew of [7000, 14000, 15000, 15001, 16000]) {
  test("H/I/J: device skew " + skew + " only validates time, never changes T2-T1", async () => {
    const f = fixture(stateAt(NOW + skew - 10000), { next: row(NOW + skew) });
    const accepted = skew <= 15000;
    assert.equal((await f.pass()).intervals, accepted ? 1 : 0);
    approx(f.total(), accepted ? expected : 0);
  });
}
test("K: reboot resets reading ID but newer timestamp still integrates", async () => {
  const f = fixture(stateAt(NOW - 10000, 14, "r_999999_z"), { r_10_a: row(NOW) });
  assert.equal((await f.pass()).intervals, 1);
  assert.equal(f.store.backend_state.energy[1].last_reading_id, "r_10_a");
});
test("L: restart with lagging state and replayed readings never double counts", async () => {
  const f = fixture();
  assert.equal((await f.pass()).intervals, 1);
  f.store.backend_state.energy[1] = stateAt(NOW - 10000);
  assert.equal((await f.pass()).intervals, 0); approx(f.total(), expected);
  f.store.sensor_reading[1].next = row(NOW + 10000);
  assert.equal((await f.pass(NOW + 10000)).intervals, 1);
  approx(f.total(), expected * 2);
});
test("valid cursor newer than available history is preserved, not reset backwards", async () => {
  const base = stateAt(NOW);
  const f = fixture(base, { old: row(NOW - 10000) });
  assert.equal((await f.pass()).intervals, 0);
  assert.deepEqual(f.store.backend_state.energy[1], base);
});
test("new bootstrap ignores historical readings and legacy without backfill", async () => {
  const f = fixture(null, { t1: row(NOW - 10000), t2: row(NOW),
    old: { timestamp: "uptime-41992", power_consumption: 14 } });
  assert.equal((await f.pass()).intervals, 0);
  assert.equal(f.store.backend_state.energy[1].last_timestamp, iso(NOW));
  assert.equal(f.total(), 0);
});
test("strict timestamp formats reject numeric, offset and impossible values", () => {
  for (const timestamp of [NOW, "2026-10-22T15:15:24+00:00", "2026-10-22T24:00:00Z", "2026-02-30T00:00:00Z"]) {
    const plan = svc.planIntervals(null, [{ key: "bad", power_consumption: 14, timestamp }], NOW);
    assert.equal(plan.newState, null);
  }
  const plan = svc.planIntervals(stateAt(NOW - 10000), [
    { key: "seconds", ...row(NOW), timestamp: "2026-10-22T15:15:24Z" },
    { key: "ms", ...row(NOW + 123) }
  ], NOW);
  assert.equal(plan.intervals.length, 2);
  assert.equal(plan.intervals[1].curTs - plan.intervals[1].prevTs, 123);
});
test("debug is opt-in, allowlisted, explains rejected candidates and actual committed increments", async () => {
  const f = fixture(stateAt(NOW - 10000), {
    valid: { ...row(NOW), token: "SECRET_TOKEN" },
    legacy: { timestamp: "uptime-41992", power_consumption: 14, user: "SECRET_USER" },
    future: row(NOW + 16000), bad: { timestamp: {}, power_consumption: 14 }
  }, { SERVICE_ACCOUNT: "SECRET_CREDENTIAL", ENERGY_DEBUG: "1" });
  await f.worker.processNode("1", 18.5, { nowMs: NOW });
  const d = f.blocks()[0];
  assert.ok(d); assert.equal(d.candidate_count, 4); assert.equal(d.valid_candidate_count, 1);
  assert.equal(d.rejected_candidate_count, 3); assert.equal(d.legacy_timestamp_count, 1);
  assert.equal(d.invalid_timestamp_count, 2); assert.equal(d.future_timestamp_count, 1);
  assert.equal(d.processed_interval_count, 1);
  assert.ok(d.energy_increment_kwh > 0);
  assert.equal(d.latest_processed_reading_id, "valid");
  assert.equal(d.state_after_last_timestamp, iso(NOW));
  assert.doesNotMatch(f.logs.join(""), /SECRET|token|SERVICE_ACCOUNT/);
  const quiet = fixture(); await quiet.worker.processNode("1", 18.5, { nowMs: NOW });
  assert.deepEqual(quiet.logs, []);
});
test("reported energy increment on replay is zero and configured rate is preserved", async () => {
  const f = fixture(); await f.pass();
  const m = f.store.energy_monthly["2026-10"];
  approx(m.cost, m.total_kwh * 18.5);
  await f.pass();
  assert.equal(f.blocks().at(-1).energy_increment_kwh, 0);
  assert.equal(f.blocks().at(-1).processed_interval_count, 0);
});

test("15-second energy passes integrate seven then eight 2-second readings once, including restart", async () => {
  const f = fixture(stateAt(NOW, 18), {});
  // Reverse insertion order proves chronological integration, independent of key order.
  for (let i = 7; i >= 1; i--) f.store.sensor_reading[1]["sample" + i] = row(NOW + i * 2000, 18);
  assert.equal((await f.pass(NOW + 15000)).intervals, 7);
  approx(f.total(), 0.000070);
  for (let i = 15; i >= 8; i--) f.store.sensor_reading[1]["sample" + i] = row(NOW + i * 2000, 18);
  assert.equal((await f.pass(NOW + 30000)).intervals, 8);
  approx(f.total(), 0.000150);
  assert.equal(Object.keys(f.store.backend_state.energy.processed[1]).length, 15);
  assert.equal((await f.pass(NOW + 30000)).intervals, 0);
  const restarted = fixture(); // fresh worker VM, persisted data from the previous process
  Object.keys(restarted.store).forEach(k => delete restarted.store[k]);
  Object.assign(restarted.store, clone(f.store));
  restarted.store.backend_state.energy[1] = stateAt(NOW, 18); // crash before cursor write
  assert.equal((await restarted.pass(NOW + 30000)).intervals, 0);
  approx(restarted.total(), 0.000150);
  assert.equal(Object.keys(restarted.store.backend_state.energy.processed[1]).length, 15);
  assert.equal(restarted.store.backend_state.energy[1].last_timestamp, iso(NOW + 30000));
});
for (const gap of [60000, 60001]) {
  test("prototype uploads do not change the energy gap boundary: " + gap, async () => {
    const f = fixture(stateAt(NOW - gap, 18), { next: row(NOW, 18) });
    assert.equal((await f.pass()).intervals, gap === 60000 ? 1 : 0);
    approx(f.total(), gap === 60000 ? 0.000300 : 0);
    assert.equal(f.store.backend_state.energy[1].last_timestamp, iso(NOW));
  });
}
