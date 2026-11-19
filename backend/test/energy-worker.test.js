// ============================================================
// LuminaGrid backend — Energy WORKER regression tests
// Run: node test/energy-worker.test.js
// ============================================================
// In-memory RTDB stub with REAL transaction() semantics (atomic
// read-modify-write; returning undefined aborts). The Admin SDK `db` is
// injected by stubbing "./firebase-admin", so no credentials and no live
// Firebase are needed. Guards the daily-accumulator regression where the
// monthly write used to wipe the `today` child, collapsing the daily value to
// the latest single interval's kWh.
// ============================================================
const path = require("path");
const Module = require("module");
const fs = require("node:fs");
const vm = require("node:vm");
const energyService = require("../energy-service");

function makeDb() {
  const store = {};
  const getPath = (p) => String(p).split("/").filter(Boolean);
  const readNode = (p) => {
    let cur = store;
    for (const k of getPath(p)) {
      if (cur == null || typeof cur !== "object") return null;
      cur = cur[k];
    }
    return cur === undefined ? null : cur;
  };
  const writeNode = (p, val) => {
    const parts = getPath(p);
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = val;
  };
  // Serialize transactions PER PATH, like the RTDB server: concurrent
  // transactions on the same ref run one-at-a-time in arrival order, each
  // seeing the previous one's committed result. This faithfully models the
  // atomic compare-and-set the real backend relies on.
  const locks = {};
  const withLock = (p, fn) => {
    locks[p] = (locks[p] || Promise.resolve()).then(fn, fn);
    return locks[p];
  };
  return {
    ref(p) {
      return {
        async once() {
          const v = readNode(p);
          return { val: () => (v === null ? null : JSON.parse(JSON.stringify(v))) };
        },
        async set(v) {
          await withLock(p, () => { writeNode(p, JSON.parse(JSON.stringify(v))); });
        },
        async transaction(updater) {
          return withLock(p, () => {
            const cur = readNode(p);
            const next = updater(cur === null ? null : JSON.parse(JSON.stringify(cur)));
            if (next === undefined) return { committed: false };
            writeNode(p, JSON.parse(JSON.stringify(next)));
            return { committed: true };
          });
        }
      };
    },
    _store: store
  };
}

const workerPath = path.join(__dirname, "..", "energy-worker.js");
const proxyDb = { ref(p) { return global.__FAKE_DB__.ref(p); } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./firebase-admin") return { db: proxyDb };
  return origLoad.call(this, request, parent, isMain);
};

const { commitInterval, processNode } = require(workerPath);

let pass = 0;
const fails = [];
function assert(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fails.push(label); console.log("  FAIL " + label); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const readStore = (db, p) => {
  let cur = db._store;
  for (const k of p.split("/").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return 0;
    cur = cur[k];
  }
  return typeof cur === "number" ? cur : 0;
};
function mkInterval(sid, prevTs, curTs, dayKey, monthKey, kwh) {
  return { prevTs, curTs, kwh, segments: [{ dayKey, monthKey, kwh }] };
}

// Reload the actual worker in an isolated JS context for restart/CLI tests.
// Firebase initialization is always intercepted: no credentials or network.
function isolatedWorker(db, options = {}) {
  const logs = [], errors = [];
  let closed = 0;
  const context = vm.createContext({
    require(name) {
      if (name === "./firebase-admin") return {
        db, admin: { app: () => ({ async delete() { closed++; } }) }
      };
      if (name === "./energy-service") return energyService;
      if (name === "./energy-diagnostics") return require("../energy-diagnostics");
      throw new Error("Unexpected worker import: " + name);
    },
    module: { exports: {} },
    process: { env: { ENERGY_POLL_INTERVAL_MS: "15" },
      argv: options.watch ? ["--watch"] : [], exitCode: 0 },
    Date: options.nowMs == null ? Date : class extends Date {
      static now() { return options.nowMs; }
    },
    console: { log: (...v) => logs.push(v.join(" ")), error: (...v) => errors.push(v.join(" ")) },
    setTimeout: options.setTimeout || (() => { throw new Error("Unexpected timer"); }),
    setInterval: () => { throw new Error("Watch must not use an overlapping interval"); },
    testPass: options.pass
  });
  vm.runInContext(fs.readFileSync(workerPath, "utf8"), context);
  return { worker: context.module.exports, context, logs, errors,
    closed: () => closed,
    main: () => vm.runInContext("runOnce = testPass; main()", context) };
}

function midnightInterval(day) {
  const prevTs = Date.parse(day + "T15:59:55Z");
  const curTs = prevTs + 10000;
  const plan = energyService.planIntervals({
    last_reading_id: "before", last_timestamp: new Date(prevTs).toISOString(), last_power_w: 36
  }, [{ key: "after", timestamp: new Date(curTs).toISOString(), power_consumption: 36 }], curTs);
  if (plan.intervals.length !== 1) throw new Error("Midnight fixture must plan one interval");
  return plan.intervals[0];
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const RATE = 13.6;
const NOW = new Date().toISOString();
const MK = "2026-10", DK = "2026-10-15";
const dayPath = (m, d) => `energy_monthly/${m}/today/${d}`;
(async () => {
  console.log("== daily total is monotonic (never decreases) ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    await commitInterval("1", mkInterval("1", 1000, 11000, DK, MK, 0.000060), RATE, NOW);
    const a = readStore(db, dayPath(MK, DK));
    await commitInterval("1", mkInterval("1", 11000, 21000, DK, MK, 0.000061), RATE, NOW);
    const b = readStore(db, dayPath(MK, DK));
    await commitInterval("1", mkInterval("1", 21000, 31000, DK, MK, 0.000059), RATE, NOW);
    const c = readStore(db, dayPath(MK, DK));
    assert(near(a, 0.000060), `A -> 0.000060 (got ${a})`);
    assert(near(b, 0.000121), `B -> 0.000121 (got ${b})`);
    assert(b >= a, "no decrease after B");
    assert(near(c, 0.000180), `C -> 0.000180 (got ${c})`);
    assert(c >= b, "no decrease after C (regression: was collapsing to 0.000059)");
    assert(!near(c, 0.000059), "daily is NOT merely the last interval");
  }

  console.log("== duplicate interval adds 0 to daily ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    await commitInterval("1", iv, RATE, NOW);
    await commitInterval("1", iv, RATE, NOW);
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "replay is idempotent");
  }

  console.log("== concurrent different intervals both land ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    await Promise.all([
      commitInterval("1", mkInterval("1", 1000, 11000, DK, MK, 0.000060), RATE, NOW),
      commitInterval("1", mkInterval("1", 11000, 21000, DK, MK, 0.000061), RATE, NOW)
    ]);
    assert(near(readStore(db, dayPath(MK, DK)), 0.000121), "both increments landed");
  }

  console.log("== two workers race the SAME interval ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    const [a, b] = await Promise.all([
      commitInterval("1", iv, RATE, NOW),
      commitInterval("1", iv, RATE, NOW)
    ]);
    // Exactly ONE worker's apply actually landed energy (the other is an
    // idempotent no-op), regardless of who created the pending claim.
    assert([a.claimed, b.claimed].filter(Boolean).length === 1, "exactly one apply");
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "no double count");
    // Claim is finalized as applied.
    const claim = db._store.backend_state.energy.processed["1"]["1:1000:11000"];
    assert(claim && claim.status === "applied", "claim finalized as applied");
  }

  console.log("== restart/crash replay does not duplicate daily ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    await commitInterval("1", mkInterval("1", 1000, 11000, DK, MK, 0.000060), RATE, NOW);
    await commitInterval("1", mkInterval("1", 1000, 11000, DK, MK, 0.000060), RATE, NOW);
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "no duplicate after replay");
  }

  console.log("== midnight split accumulates each day bucket ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const t1 = Date.parse("2026-10-31T15:59:55Z");
    const t2 = Date.parse("2026-10-31T16:00:05Z");
    const full = (22 * (10 / 3600)) / 1000;
    await commitInterval("1", {
      prevTs: t1, curTs: t2, kwh: full,
      segments: [
        { dayKey: "2026-10-31", monthKey: "2026-10", kwh: full / 2 },
        { dayKey: "2026-11-01", monthKey: "2026-11", kwh: full / 2 }
      ]
    }, RATE, NOW);
    const oct = readStore(db, dayPath("2026-10", "2026-10-31"));
    const nov = readStore(db, dayPath("2026-11", "2026-11-01"));
    assert(near(oct + nov, full, 1e-6), "Oct + Nov daily = full interval");
    assert(near(oct, nov, 1e-6), "split ~50/50 at midnight");
  }

  console.log("== monthly total/nodes/cost unaffected ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    await commitInterval("1", mkInterval("1", 1000, 11000, DK, MK, 0.000060), RATE, NOW);
    await commitInterval("1", mkInterval("1", 11000, 21000, DK, MK, 0.000061), RATE, NOW);
    const rec = db._store.energy_monthly["2026-10"];
    assert(near(rec.nodes["1"].total_kwh, 0.000121), "node monthly total accumulates");
    assert(near(rec.total_kwh, 0.000121), "month total_kwh accumulates");
    assert(near(rec.cost, 0.000121 * RATE, 1e-4), "cost = total_kwh x rate");
    assert(!!rec.today && !!rec.today[DK], "today preserved alongside monthly");
  }

  console.log("== bootstrap via processNode does not integrate history ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    db._store.sensor_reading = { "1": {
      r1: { reading_id: "r1", power_consumption: 20, timestamp: "2026-10-13T00:00:00Z" },
      r2: { reading_id: "r2", power_consumption: 22, timestamp: "2026-10-13T00:00:10Z" }
    } };
    db._store.streetlight = { "1": { streetlight_id: 1, pole_number: "P-001" } };
    const res = await processNode("1", RATE);
    assert(res.bootstrap === true && res.intervals === 0, "first pass bootstraps 0 intervals");
    assert(!db._store.energy_monthly, "bootstrap creates no aggregate");
  }

  console.log("== A. crash AFTER claim, BEFORE any aggregate write ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    // Simulate: claim written as PENDING, then process dies before applySegment.
    db._store.backend_state = { energy: { processed: { "1": { [`1:1000:11000`]: {
      status: "pending", sid: "1", key: "1:1000:11000", prevTs: 1000, curTs: 11000,
      kwh: 0.000060, segments: iv.segments, started_at: NOW
    } } } } };
    assert(!db._store.energy_monthly, "no aggregate written before crash");
    // Worker restarts and re-encounters the interval.
    const res = await commitInterval("1", iv, RATE, NOW);
    assert(res.claimed === true, "pending claim is RESUMED and applied (not skipped)");
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "energy applied exactly once after resume");
    assert(near(db._store.energy_monthly["2026-10"].nodes["1"].total_kwh, 0.000060), "monthly node total = one interval");
  }

  console.log("== B. crash AFTER atomic apply, BEFORE claim finalize ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    // Monthly + node + daily + marker are ONE atomic transaction, so a crash can
    // never split them. The realistic partial-crash state is: the atomic apply
    // committed (monthly + node + daily + marker all present) but the process
    // died before flipping the claim from PENDING to APPLIED.
    db._store.energy_monthly = { "2026-10": {
      month: "2026-10", total_kwh: 0.000060, cost: 0.0008, updated_at: NOW,
      nodes: { "1": { streetlight_id: 1, total_kwh: 0.000060, cost: 0.0008, updated_at: NOW } },
      today: { [DK]: 0.000060 }, _applied: { [`1:1000:11000`]: true }
    } };
    db._store.backend_state = { energy: { processed: { "1": { [`1:1000:11000`]: {
      status: "pending", sid: "1", key: "1:1000:11000", segments: iv.segments
    } } } } };
    // Restart: claim is PENDING -> resume, but marker present -> applySegment
    // no-ops (nothing re-added), then claim is finalized APPLIED.
    const res = await commitInterval("1", iv, RATE, NOW);
    assert(res.claimed === false, "already-applied interval re-applies nothing on resume");
    assert(near(db._store.energy_monthly["2026-10"].total_kwh, 0.000060), "monthly total NOT doubled");
    assert(near(db._store.energy_monthly["2026-10"].nodes["1"].total_kwh, 0.000060), "node total NOT doubled");
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "daily present exactly once");
    const claim = db._store.backend_state.energy.processed["1"]["1:1000:11000"];
    assert(claim && claim.status === "applied", "claim finalized on resume");
  }

  console.log("== C. crash AFTER daily write, BEFORE state-pointer update ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    db._store.sensor_reading = { "1": {
      r1: { reading_id: "r1", power_consumption: 20, timestamp: "2026-10-14T00:00:00Z" },
      r2: { reading_id: "r2", power_consumption: 22, timestamp: "2026-10-14T00:00:10Z" }
    } };
    db._store.streetlight = { "1": { streetlight_id: 1, pole_number: "P-001" } };
    // Interval fully applied + claim APPLIED, but backend_state pointer NOT advanced.
    db._store.backend_state = { energy: { "1": { last_reading_id: "r1", last_timestamp: "2026-10-14T00:00:00Z", last_power_w: 20 } } };
    await commitInterval("1", mkInterval("1", Date.parse("2026-10-14T00:00:00Z"), Date.parse("2026-10-14T00:00:10Z"), DK, MK, 0.000060), RATE, NOW);
    const after1 = readStore(db, dayPath(MK, DK));
    // Replay same interval (state pointer still at r1): must not double.
    await commitInterval("1", mkInterval("1", Date.parse("2026-10-14T00:00:00Z"), Date.parse("2026-10-14T00:00:10Z"), DK, MK, 0.000060), RATE, NOW);
    assert(near(readStore(db, dayPath(MK, DK)), after1), "no duplicate daily after state-pointer lag");
    assert(near(after1, 0.000060), "daily = one interval");
  }

  console.log("== D. two workers recover the SAME pending claim ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    db._store.backend_state = { energy: { processed: { "1": { [`1:1000:11000`]: {
      status: "pending", sid: "1", key: "1:1000:11000", segments: iv.segments
    } } } } };
    const [a, b] = await Promise.all([
      commitInterval("1", iv, RATE, NOW),
      commitInterval("1", iv, RATE, NOW)
    ]);
    assert([a.claimed, b.claimed].filter(Boolean).length === 1, "only one recovery apply lands");
    assert(near(readStore(db, dayPath(MK, DK)), 0.000060), "daily = single interval (no double)");
    assert(near(db._store.energy_monthly["2026-10"].total_kwh, 0.000060), "monthly = single interval (no double)");
  }

  console.log("== E. fully-applied claim replay = no-op ==");
  {
    global.__FAKE_DB__ = makeDb();
    const db = global.__FAKE_DB__;
    const iv = mkInterval("1", 1000, 11000, DK, MK, 0.000060);
    await commitInterval("1", iv, RATE, NOW); // full apply -> claim APPLIED
    const before = readStore(db, dayPath(MK, DK));
    const res = await commitInterval("1", iv, RATE, NOW); // replay
    assert(res.claimed === false && res.alreadyApplied === true, "applied claim short-circuits");
    assert(near(readStore(db, dayPath(MK, DK)), before), "no change on applied replay");
  }

  console.log("== real planner: both midnight boundaries, including replay ==");
  for (const day of ["2026-10-14", "2026-10-31"]) {
    const db = makeDb();
    const worker = isolatedWorker(db).worker;
    const iv = midnightInterval(day);
    const result = await worker.commitInterval("1", iv, RATE, NOW);
    assert(iv.segments.length === 2, day + ": planner splits two days");
    for (const seg of iv.segments) {
      assert(near(readStore(db, dayPath(seg.monthKey, seg.dayKey)), 0.000050),
        day + ": day " + seg.dayKey + " counted");
    }
    const total = Object.values(db._store.energy_monthly).reduce((sum, rec) => sum + rec.total_kwh, 0);
    assert(near(total, 0.000100), day + ": complete interval in monthly totals");
    assert(near(result.appliedKwh, iv.kwh), day + ": reports complete committed increment");
    const before = JSON.stringify(db._store.energy_monthly);
    await worker.commitInterval("1", iv, RATE, "2026-12-01T00:00:00Z");
    assert(JSON.stringify(db._store.energy_monthly) === before, day + ": replay leaves aggregates unchanged");
  }

  console.log("== restart after partial processing across months / before finalize ==");
  for (const day of ["2026-10-14", "2026-10-31"]) {
    const db = makeDb(), iv = midnightInterval(day);
    const key = energyService.intervalKey("1", iv.prevTs, iv.curTs);
    const claimPath = "backend_state/energy/processed/1/" + key;
    const acrossMonths = iv.segments[0].monthKey !== iv.segments[1].monthKey;
    const interrupted = new Error("simulated crash");
    let injected = false;
    const crashingDb = { ref(p) {
      const ref = db.ref(p);
      return { ...ref, transaction(update) {
        return ref.transaction(cur => {
          const next = update(cur);
          const failHere = acrossMonths
            ? p === "energy_monthly/" + iv.segments[1].monthKey
            : p === claimPath && next?.status === "applied";
          if (!injected && failHere && next !== undefined) {
            injected = true;
            throw interrupted;
          }
          return next;
        });
      } };
    } };
    let caught;
    try { await isolatedWorker(crashingDb).worker.commitInterval("1", iv, RATE, NOW); }
    catch (error) { caught = error; }
    assert(caught === interrupted, day + ": injected crash reached");
    assert(db._store.backend_state.energy.processed["1"][key].status === "pending",
      day + ": durable claim remains pending");
    assert(near(readStore(db, dayPath(iv.segments[0].monthKey, iv.segments[0].dayKey)), 0.000050),
      day + ": first day committed before restart");
    assert(near(readStore(db, dayPath(iv.segments[1].monthKey, iv.segments[1].dayKey)), acrossMonths ? 0 : 0.000050),
      day + ": month transaction is atomic");
    // Re-derived input must not replace the already persisted pending payload.
    const changedInput = { ...iv, segments: iv.segments.map(seg => ({ ...seg, kwh: seg.kwh * 4 })) };
    const resumed = await isolatedWorker(db).worker.commitInterval("1", changedInput, RATE, NOW);
    assert(near(resumed.appliedKwh, acrossMonths ? 0.000050 : 0),
      day + ": restart only adds missing month from durable payload");
    for (const seg of iv.segments) {
      assert(near(readStore(db, dayPath(seg.monthKey, seg.dayKey)), 0.000050),
        day + ": resumed day counted exactly once");
    }
    assert(db._store.backend_state.energy.processed["1"][key].status === "applied",
      day + ": recovered claim finalized");
    const before = JSON.stringify(db._store.energy_monthly);
    await isolatedWorker(db).worker.commitInterval("1", iv, RATE, NOW);
    assert(JSON.stringify(db._store.energy_monthly) === before, day + ": restart replay is a no-op");
  }

  console.log("== simultaneous same-month midnight interval is counted once ==");
  {
    const db = makeDb(), iv = midnightInterval("2026-10-14");
    await Promise.all([
      isolatedWorker(db).worker.commitInterval("1", iv, RATE, NOW),
      isolatedWorker(db).worker.commitInterval("1", iv, RATE, NOW)
    ]);
    assert(near(db._store.energy_monthly["2026-10"].total_kwh, 0.000100),
      "racing workers preserve the complete interval exactly once");
    for (const seg of iv.segments) {
      assert(near(readStore(db, dayPath(seg.monthKey, seg.dayKey)), 0.000050),
        "racing workers preserve day " + seg.dayKey);
    }
  }

  console.log("== legacy month marker never automatically repairs old totals ==");
  {
    const db = makeDb(), iv = midnightInterval("2026-10-14");
    const key = energyService.intervalKey("1", iv.prevTs, iv.curTs);
    db._store.energy_monthly = { "2026-10": {
      total_kwh: 0.000050, cost: 0.000680,
      nodes: { "1": { total_kwh: 0.000050, cost: 0.000680 } },
      today: { "2026-10-14": 0.000050 }, _applied: { [key]: true }
    } };
    db._store.backend_state = { energy: { processed: { "1": {
      [key]: { status: "pending", sid: "1", key, segments: iv.segments }
    } } } };
    const before = JSON.stringify(db._store.energy_monthly);
    const result = await isolatedWorker(db).worker.commitInterval("1", iv, RATE, NOW);
    assert(result.appliedKwh === 0, "legacy marker contributes no new historical energy");
    assert(JSON.stringify(db._store.energy_monthly) === before, "legacy totals and daily buckets remain byte-equivalent");
  }

  console.log("== two complete processing passes cannot recount a midnight interval ==");
  {
    const db = makeDb(), iv = midnightInterval("2026-10-14");
    db._store.streetlight = { "1": { streetlight_id: 1 } };
    db._store.system_config = { energy_rate_per_kwh: RATE };
    db._store.backend_state = { energy: { "1": {
      last_reading_id: "before", last_timestamp: new Date(iv.prevTs).toISOString(), last_power_w: 36
    } } };
    db._store.sensor_reading = { "1": {
      before: { timestamp: new Date(iv.prevTs).toISOString(), power_consumption: 36 },
      after: { timestamp: new Date(iv.curTs).toISOString(), power_consumption: 36 }
    } };
    const worker = isolatedWorker(db, { nowMs: iv.curTs }).worker;
    const first = await worker.runOnce();
    const before = JSON.stringify(db._store.energy_monthly);
    const second = await worker.runOnce();
    assert(first[0].intervals === 1 && second[0].intervals === 0,
      "first pass applies interval, second pass has no new interval");
    assert(near(db._store.energy_monthly["2026-10"].total_kwh, 0.000100), "full pass counts both midnight days");
    assert(JSON.stringify(db._store.energy_monthly) === before, "second pass leaves energy unchanged");
    assert(db._store.backend_state.energy["1"].last_timestamp === new Date(iv.curTs).toISOString(),
      "cursor advances only after the complete interval");
  }

  console.log("== watch awaits a slow pass and recovers after later failure ==");
  {
    let now = 0, calls = 0, active = 0, peak = 0, release;
    const timers = [], stop = new Error("end simulated watch");
    const slowPass = new Promise(resolve => { release = resolve; });
    const host = isolatedWorker(makeDb(), {
      watch: true,
      async pass() {
        calls++; active++; peak = Math.max(peak, active);
        try {
          if (calls === 1) await slowPass;
          if (calls === 2) throw new Error("recoverable read failure");
          return [];
        } finally { active--; }
      },
      setTimeout(fn, ms) {
        if (calls === 3) throw stop;
        timers.push({ fn, due: now + ms });
      }
    });
    const done = host.main().then(() => null, error => error);
    await flush();
    now += 75; // five configured intervals elapse while the first pass is pending
    for (const timer of timers.splice(0)) if (timer.due <= now) timer.fn();
    await flush();
    assert(calls === 1 && active === 1 && timers.length === 0, "slow pass creates no overlapping pass or pending watch timer");
    release();
    await flush();
    assert(timers.length === 1 && timers[0].due === now + 15, "delay starts after slow pass completes");
    now += 15; timers.shift().fn(); await flush();
    assert(calls === 2 && host.errors.some(text => text.includes("recoverable read failure")),
      "later failure is logged");
    now += 15; timers.shift().fn(); await flush();
    assert(await done === stop, "simulated watch stops only at the test boundary");
    assert(calls === 3 && peak === 1, "next pass runs after failure with maximum concurrency one");
    assert(host.closed() === 1, "worker releases SDK connection on loop exit");
  }

  console.log("== watch survives its first processing-pass failure ==");
  {
    let calls = 0;
    const timers = [], stop = new Error("end startup recovery test");
    const host = isolatedWorker(makeDb(), {
      watch: true,
      async pass() { if (++calls === 1) throw new Error("startup read failure"); return []; },
      setTimeout(fn) { if (calls === 2) throw stop; timers.push(fn); }
    });
    const done = host.main().then(() => null, error => error);
    await flush();
    assert(calls === 1 && timers.length === 1 && host.errors.some(text => text.includes("startup read failure")),
      "initial failure is logged and schedules a retry");
    timers.shift()(); await flush();
    assert(await done === stop && calls === 2, "first-pass failure does not silently stop watch mode");
  }

  console.log("== one-pass mode runs once, reports failures and releases connection ==");
  for (const scenario of ["success", "node-error", "pass-error"]) {
    let calls = 0;
    const failure = new Error("one-pass failure");
    const host = isolatedWorker(makeDb(), { async pass() {
      calls++;
      if (scenario === "pass-error") throw failure;
      return scenario === "node-error" ? [{ sid: "1", error: "node read failure" }] : [];
    } });
    let caught;
    try { await host.main(); } catch (error) { caught = error; }
    assert(calls === 1 && host.closed() === 1, scenario + ": one pass and SDK cleanup");
    assert(scenario === "pass-error" ? caught === failure : !caught, scenario + ": pass-level outcome preserved");
    assert(host.context.process.exitCode === (scenario === "node-error" ? 1 : 0),
      scenario + ": per-node failure sets unsuccessful exit status");
  }

  console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
  if (fails.length) { fails.forEach((f) => console.log("  FAILED: " + f)); process.exit(1); }
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });

