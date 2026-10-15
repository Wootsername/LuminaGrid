// ============================================================
// LuminaGrid backend — Energy Engine unit tests (pure, no Firebase)
// Run: node test/energy-service.test.js
// ============================================================
const {
  integrateIntervalKwh,
  manilaMonthKey,
  manilaDayKey,
  manilaDayStartMs,
  splitByDay,
  intervalKey,
  planIntervals,
  MAX_ENERGY_GAP_MS
} = require("../energy-service");

let pass = 0;
const fails = [];
function assert(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fails.push(label); console.log("  FAIL " + label); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("== trapezoidal integration ==");
const e1 = integrateIntervalKwh(20, 22, 10000);
assert(near(e1, (21 * (10 / 3600)) / 1000), "20/22W over 10s ~ 0.000058333 kWh");
assert(integrateIntervalKwh(0, 0, 10000) === 0, "0W/0W -> 0");
assert(integrateIntervalKwh(22, 22, 60000) > 0, "exactly 60s integrated");
assert(integrateIntervalKwh(22, 22, 60001) === 0, ">60s gap -> 0 (not bridged)");
assert(MAX_ENERGY_GAP_MS === 60000, "MAX_ENERGY_GAP_MS = 60000");
assert(integrateIntervalKwh(22, 22, 0) === 0, "dt=0 -> 0");
assert(integrateIntervalKwh(22, 22, -1) === 0, "negative dt -> 0");

console.log("== deterministic interval identity ==");
assert(intervalKey("1", 1000, 2000) === "1:1000:2000", "intervalKey = sid:prevTs:curTs");
assert(intervalKey("1", 1000, 2000) === intervalKey("1", 1000, 2000), "same inputs -> same key (idempotent claim)");
assert(intervalKey("1", 1000, 2000) !== intervalKey("2", 1000, 2000), "different sid -> different key");

console.log("== month assignment uses Asia/Manila ==");
assert(manilaMonthKey(Date.parse("2026-09-30T16:30:00Z")) === "2026-10", "UTC late-Sep -> Manila 2026-10");
assert(manilaMonthKey(Date.parse("2026-09-30T15:30:00Z")) === "2026-09", "UTC earlier -> 2026-09");

console.log("== day keys & midnight boundary ==");
assert(manilaDayKey(Date.parse("2026-10-14T16:00:00Z")) === "2026-10-15", "16:00Z -> Manila next day");
// Manila midnight (start of 2026-10-15) is 2026-10-14T16:00:00Z
assert(manilaDayStartMs(Date.parse("2026-10-14T16:00:00Z")) === Date.parse("2026-10-14T16:00:00Z"), "day start lands exactly on Manila midnight");

console.log("== split across midnight is proportional ==");
{
  // Oct 31 23:59:55 -> Nov 1 00:00:05 Manila. 10s total, split ~5s/5s at midnight.
  const t1 = Date.parse("2026-10-31T15:59:55Z"); // 23:59:55 Manila
  const t2 = Date.parse("2026-10-31T16:00:05Z"); // 00:00:05 Manila (Nov 1)
  const kwh = 0.0001;
  const segs = splitByDay(t1, t2, kwh);
  assert(segs.length === 2, "interval split into 2 day-segments at Manila midnight");
  assert(segs[0].monthKey === "2026-10" && segs[1].monthKey === "2026-11", "segments attributed to Oct then Nov");
  assert(near(segs[0].kwh + segs[1].kwh, kwh, 1e-12), "segment kWh sums to the original");
  assert(near(segs[0].kwh, kwh * 0.5, 1e-4) && near(segs[1].kwh, kwh * 0.5, 1e-4), "energy split ~50/50 across the boundary");
}

console.log("== planIntervals: basic one interval ==");
{
  const readings = [
    { key: "r1", power_consumption: 20, timestamp: "2026-10-14T00:00:00Z" },
    { key: "r2", power_consumption: 22, timestamp: "2026-10-14T00:00:10Z" }
  ];
  const plan = planIntervals(null, readings);
  assert(plan.bootstrap === true, "no state -> FIRST BOOTSTRAP (no integration)");
  assert(plan.intervals.length === 0, "bootstrap produces 0 intervals");
  assert(plan.newState.last_power_w === 22, "bootstrap stores latest reading as baseline");
  assert(plan.newState.last_reading_id === "r2", "bootstrap baseline = latest reading id");

  const plan2 = planIntervals(plan.newState, readings);
  assert(plan2.bootstrap === false && plan2.intervals.length === 0, "normal restart with only old readings -> 0 intervals");
}

console.log("== planIntervals: normal processing after bootstrap ==");
{
  const base = { last_reading_id: "r1", last_timestamp: "2026-10-14T00:00:00Z", last_power_w: 20 };
  const readings = [
    { key: "r1", power_consumption: 20, timestamp: "2026-10-14T00:00:00Z" },
    { key: "r2", power_consumption: 22, timestamp: "2026-10-14T00:00:10Z" }
  ];
  const plan = planIntervals(base, readings);
  assert(plan.bootstrap === false, "state present -> normal (not bootstrap)");
  assert(plan.intervals.length === 1, "one new interval (r1->r2)");
  assert(plan.intervals[0].key === intervalKey(undefined, Date.parse("2026-10-14T00:00:00Z"), Date.parse("2026-10-14T00:00:10Z")), "interval key from prev/cur ts");
  assert(plan.newState.last_power_w === 22, "state advances to latest");
}

console.log("== planIntervals: duplicate / older ignored ==");
{
  const base = { last_reading_id: "r2", last_timestamp: "2026-10-14T00:00:10Z", last_power_w: 22 };
  const readings = [
    { key: "r2", power_consumption: 22, timestamp: "2026-10-14T00:00:10Z" },
    { key: "r1", power_consumption: 20, timestamp: "2026-10-14T00:00:00Z" }
  ];
  const plan = planIntervals(base, readings);
  assert(plan.intervals.length === 0, "replayed/older readings -> 0 intervals");
}

console.log("== planIntervals: long gap ignored ==");
{
  const base = { last_reading_id: "r1", last_timestamp: "2026-10-14T00:00:00Z", last_power_w: 22 };
  const readings = [{ key: "r2", power_consumption: 22, timestamp: "2026-10-14T00:02:00Z" }];
  const plan = planIntervals(base, readings);
  assert(plan.intervals.length === 0, "120s gap -> 0 intervals");
  assert(plan.newState.last_power_w === 22, "state still advances past the gap");
}

console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
if (fails.length) { fails.forEach((f) => console.log("  FAILED: " + f)); process.exit(1); }

