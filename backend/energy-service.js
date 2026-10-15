// ============================================================
// LuminaGrid backend — Energy Engine (pure math, no Firebase)
// ============================================================
// power_consumption is INSTANTANEOUS power in Watts. Energy (kWh) must be
// integrated across time. This module holds that math so it is unit-testable
// without any database. The fault engine can reuse the same worker later.
// ============================================================

// The ESP32 uploads roughly every 10s. Never integrate a gap longer than
// this: if a node disconnects we resume accumulation from the next fresh
// reading instead of assuming the last power continued indefinitely.
const MAX_ENERGY_GAP_MS = 60000;

// Philippines is UTC+8 with no DST, so a fixed offset is exact year-round and
// lets us find local day boundaries deterministically.
const MANILA_UTC_OFFSET_MS = 8 * 3600000;
const DAY_MS = 86400000;

// Trapezoidal integration of one interval between two consecutive readings.
//   averagePowerW = (P1 + P2) / 2
//   elapsedHours  = (T2 - T1) / 3_600_000
//   energyKWh     = averagePowerW * elapsedHours / 1000
// Returns 0 for non-increasing timestamps (duplicate/older) and for gaps
// longer than MAX_ENERGY_GAP_MS (do NOT bridge long telemetry gaps).
function integrateIntervalKwh(p1W, p2W, dtMs) {
  if (typeof p1W !== "number" || typeof p2W !== "number") return 0;
  if (!(dtMs > 0)) return 0;              // duplicate / older / zero delta
  if (dtMs > MAX_ENERGY_GAP_MS) return 0; // long telemetry gap -> do not bridge
  const averagePowerW = (p1W + p2W) / 2;
  const elapsedHours = dtMs / 3600000;
  return (averagePowerW * elapsedHours) / 1000;
}

function _manilaParts(ms, opts) {
  const dtf = new Intl.DateTimeFormat("en-CA", Object.assign({ timeZone: "Asia/Manila" }, opts));
  return Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}

// Asia/Manila month key (YYYY-MM). PH has no DST so a fixed +8 offset via Intl
// is stable year-round.
function manilaMonthKey(ms) {
  const p = _manilaParts(ms, { year: "numeric", month: "2-digit" });
  return `${p.year}-${p.month}`;
}

// Asia/Manila day key (YYYY-MM-DD).
function manilaDayKey(ms) {
  const p = _manilaParts(ms, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

// UTC-ms instant of Manila-local midnight that STARTS the day containing ms.
function manilaDayStartMs(ms) {
  const shifted = ms + MANILA_UTC_OFFSET_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS - MANILA_UTC_OFFSET_MS;
}

// Split an interval [t1,t2] carrying `kwh` across Asia/Manila day boundaries,
// allocating energy PROPORTIONALLY to elapsed time. Returns one or more
// segments, each attributed to the day/month it actually falls in.
function splitByDay(t1, t2, kwh) {
  const segs = [];
  let cursor = t1;
  while (cursor < t2) {
    const nextBoundary = manilaDayStartMs(cursor) + DAY_MS;
    const segEnd = Math.min(t2, nextBoundary);
    const frac = (segEnd - cursor) / (t2 - t1);
    segs.push({
      dayKey: manilaDayKey(cursor),
      monthKey: manilaMonthKey(cursor),
      kwh: kwh * frac
    });
    cursor = segEnd;
  }
  return segs;
}

function costFor(kwh, ratePerKwh) {
  return (Number(kwh) || 0) * ratePerKwh;
}

// Deterministic identity for a processed interval. Because it is derived only
// from (sid, previous timestamp, current timestamp), a worker restart or a
// second worker that re-encounters the same interval computes the SAME key and
// can claim it exactly once (see energy-worker.js transaction).
function intervalKey(sid, prevTs, curTs) {
  return `${sid}:${prevTs}:${curTs}`;
}

function mkState(r) {
  // Accept both raw reading shape ({ key, ts, power_consumption }) and the
  // loop's running shape ({ ts, power, key }).
  return {
    last_reading_id: r.key,
    last_timestamp: new Date(r.ts).toISOString(),
    last_power_w: typeof r.power_consumption === "number" ? r.power_consumption : r.power
  };
}

// Plan the NEW intervals to process for one node, given persisted state.
//   state:    { last_reading_id, last_timestamp (ISO), last_power_w } | null
//   readings: [{ key, power_consumption, timestamp }]
//   returns:  { bootstrap, intervals, newState }
//
// FIRST BOOTSTRAP (no state): the node has historical readings but no prior
// baseline. We DO NOT integrate history — we store the latest valid reading as
// the baseline and add 0 kWh, waiting for the next genuinely newer reading.
//
// NORMAL RESTART (state present): ignore readings with ts <= last_timestamp
// and integrate only genuinely newer intervals.
function planIntervals(state, readings) {
  const valid = (readings || [])
    .filter(
      (r) =>
        r &&
        typeof r.power_consumption === "number" &&
        r.timestamp &&
        !Number.isNaN(Date.parse(r.timestamp))
    )
    .map((r) => ({ ...r, ts: Date.parse(r.timestamp) }))
    .sort((a, b) => a.ts - b.ts);

  if (valid.length === 0) return { bootstrap: false, intervals: [], newState: state };

  if (!state) {
    return { bootstrap: true, intervals: [], newState: mkState(valid[valid.length - 1]) };
  }

  let prev = {
    ts: Date.parse(state.last_timestamp),
    power: state.last_power_w,
    key: state.last_reading_id
  };
  const intervals = [];

  for (const r of valid) {
    if (r.ts <= prev.ts) continue; // older / duplicate / replay
    if (typeof prev.power === "number" && r.ts - prev.ts <= MAX_ENERGY_GAP_MS) {
      const kwh = integrateIntervalKwh(prev.power, r.power_consumption, r.ts - prev.ts);
      if (kwh > 0) {
        intervals.push({
          key: intervalKey(undefined, prev.ts, r.ts), // sid filled by worker
          prevTs: prev.ts,
          curTs: r.ts,
          kwh,
          segments: splitByDay(prev.ts, r.ts, kwh)
        });
      }
    }
    prev = { ts: r.ts, power: r.power_consumption, key: r.key };
  }

  return { bootstrap: false, intervals, newState: mkState(prev) };
}

module.exports = {
  MAX_ENERGY_GAP_MS,
  integrateIntervalKwh,
  manilaMonthKey,
  manilaDayKey,
  manilaDayStartMs,
  splitByDay,
  costFor,
  intervalKey,
  planIntervals
};

