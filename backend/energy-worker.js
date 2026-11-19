// ============================================================
// LuminaGrid backend — Energy Worker
// ============================================================
// Trusted server process (Firebase Admin SDK). Runs on a poll interval,
// integrates each node's instantaneous power (Watts) into monthly kWh, and
// writes the aggregates to energy_monthly. Restart-safe and concurrency-safe:
//
//   * Each processed interval has a DETERMINISTIC id
//     (sid:prevTs:curTs) recorded at backend_state/energy/processed/{sid}/{key}.
//   * All day segments of an interval within one month are applied atomically
//     with that month's existing interval marker. Replays skip the entire
//     committed month; a restart resumes any remaining months before finalizing
//     the interval claim. No day can be skipped by another day sharing its month.
//   * FIRST BOOTSTRAP: when no state exists, we store the latest reading as the
//     baseline and add 0 kWh — historical readings are NOT back-integrated.
//
// Browser reads today's total from the current energy_monthly record's
// `today` child (client-readable) — never from a private backend_state path.
//
// Usage:
//   node energy-worker.js              # one pass
//   node energy-worker.js --watch      # wait POLL_INTERVAL_MS after each completed pass
// ============================================================

const { db, admin } = require("./firebase-admin");
const {
  planIntervals,
  MAX_ENERGY_GAP_MS,
  intervalKey,
  costFor,
  manilaMonthKey,
  manilaDayKey
} = require("./energy-service");

const { inspectEnergyInputs } = require("./energy-diagnostics");

const POLL_INTERVAL_MS = Number(process.env.ENERGY_POLL_INTERVAL_MS || 15000);

const round6 = (n) => Math.round(n * 1e6) / 1e6;

async function readRate() {
  const snap = await db.ref("system_config/energy_rate_per_kwh").once("value");
  const v = snap.val();
  return typeof v === "number" && v > 0 ? v : 13.6; // documented default
}

// Discover every streetlight id we might have telemetry for.
async function listNodeIds() {
  const snap = await db.ref("streetlight").once("value");
  return Object.keys(snap.val() || {});
}

// Apply all of an interval's day segments for ONE month in one transaction.
// Keep the existing month-level interval marker and database paths. A legacy
// marker remains authoritative: this is not a repair/backfill of old totals.
// A single segment is still accepted for existing callers.
async function applySegment(sid, key, seg, ratePerKwh, nowIso) {
  const segments = Array.isArray(seg) ? seg : [seg];
  const monthKey = segments[0]?.monthKey;
  if (!monthKey || segments.some(part => part.monthKey !== monthKey)) {
    throw new Error("Energy segments must belong to one month");
  }
  const monthRef = db.ref("energy_monthly/" + monthKey);
  const res = await monthRef.transaction((cur) => {
    const rec = cur || { month: monthKey };
    const applied = rec._applied || {};
    if (applied[key]) return; // entire month already committed; never replay it

    const nodes = { ...(rec.nodes || {}) };
    const prev = nodes[sid] || { streetlight_id: Number(sid), total_kwh: 0, cost: 0 };
    let nodeKwh = prev.total_kwh || 0;
    const today = { ...(rec.today || {}) };
    // Preserve the existing per-segment arithmetic and rounding. Only the
    // transaction boundary changes, so the marker cannot hide a sibling day.
    for (const part of segments) {
      nodeKwh = round6(nodeKwh + part.kwh);
      today[part.dayKey] = round6((Number(today[part.dayKey]) || 0) + part.kwh);
    }
    nodes[sid] = {
      streetlight_id: Number(sid),
      total_kwh: nodeKwh,
      cost: round6(costFor(nodeKwh, ratePerKwh)),
      updated_at: nowIso
    };
    const monthTotal = round6(
      Object.values(nodes).reduce((sum, node) => sum + (node.total_kwh || 0), 0)
    );

    return {
      ...rec,
      month: monthKey,
      total_kwh: monthTotal,
      cost: round6(costFor(monthTotal, ratePerKwh)),
      updated_at: nowIso,
      nodes,
      today,
      _applied: { ...applied, [key]: true }
    };
  });
  return res.committed;
}

async function commitInterval(sid, iv, ratePerKwh, nowIso) {
  const key = intervalKey(sid, iv.prevTs, iv.curTs);
  const claimRef = db.ref(`backend_state/energy/processed/${sid}/${key}`);

  // 1) Recoverable claim lifecycle. Create a PENDING claim if none exists; the
  //    claim carries the deterministic payload so a crashed attempt can resume.
  //    If a claim already exists we read it and ONLY skip when it is fully
  //    APPLIED — a PENDING claim (crash) is resumed, never dropped.
  await claimRef.transaction((cur) => {
    if (cur !== null) return; // exists (pending or applied) -> inspect below
    return {
      status: "pending",
      sid, key, prevTs: iv.prevTs, curTs: iv.curTs, kwh: iv.kwh,
      segments: iv.segments, started_at: nowIso
    };
  });
  const claimSnap = await claimRef.once("value");
  const claim = claimSnap.val();
  if (claim && claim.status === "applied") {
    return { claimed: false, alreadyApplied: true, appliedKwh: 0 };
  }

  // 2) Resume the durable payload, grouping ALL sibling days before applying
  // the existing month-level marker. Months remain independently replay-safe.
  const byMonth = new Map();
  for (const seg of claim?.segments || iv.segments) {
    if (!byMonth.has(seg.monthKey)) byMonth.set(seg.monthKey, []);
    byMonth.get(seg.monthKey).push(seg);
  }
  let applied = false;
  let appliedKwh = 0;
  for (const segments of byMonth.values()) {
    const didApply = await applySegment(sid, key, segments, ratePerKwh, nowIso);
    if (didApply) {
      applied = true;
      appliedKwh += segments.reduce((sum, seg) => sum + seg.kwh, 0);
    }
  }

  // 3) Mark the claim fully APPLIED (idempotent). A crash before this leaves the
  //    claim PENDING, but the month transactions are already idempotent, so a
  //    later pass simply re-derives no-ops and then finalizes the claim here.
  await claimRef.transaction((cur) => {
    if (cur === null) return { status: "applied", sid, key, applied_at: nowIso };
    if (cur.status === "applied") return; // already finalized by another worker
    return { ...cur, status: "applied", applied_at: nowIso };
  });

  return { claimed: applied, appliedKwh };
}

// Process one node.
async function processNode(sid, ratePerKwh, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const debug = options.debug ?? (process.env.ENERGY_DEBUG === "1");
  const logger = options.logger || console.log;
  const stateSnap = await db.ref(`backend_state/energy/${sid}`).once("value");
  const state = stateSnap.val() || null;

  const readingsSnap = await db.ref(`sensor_reading/${sid}`).once("value");
  const raw = readingsSnap.val() || {};
  const readings = Object.entries(raw).map(([key, r]) => ({ key, ...r }));

  let energyIncrement = 0;
  let latestProcessed = null;
  let planned = [];
  function finish(result, after = state) {
    if (debug) {
      const { fields } = inspectEnergyInputs(state, readings, nowMs, MAX_ENERGY_GAP_MS);
      const allocationMs = latestProcessed ? latestProcessed.curTs : nowMs;
      logger("[ENERGY DEBUG] " + JSON.stringify({
        sid: String(sid), worker_now_utc: new Date(nowMs).toISOString(),
        ...fields, bootstrap: !!result.bootstrap,
        planned_interval_count: planned.length, processed_interval_count: result.intervals,
        latest_processed_reading_id: latestProcessed?.readingId ?? null,
        latest_processed_timestamp: latestProcessed ? new Date(latestProcessed.curTs).toISOString() : null,
        state_after_last_timestamp: typeof after?.last_timestamp === "string" ? after.last_timestamp : null,
        energy_increment_kwh: energyIncrement,
        month_key: manilaMonthKey(allocationMs), day_key: manilaDayKey(allocationMs)
      }));
    }
    return result;
  }
  if (readings.length === 0) return finish({ sid, intervals: 0 });

  const { bootstrap, intervals, newState } = planIntervals(state, readings, nowMs);
  planned = intervals;

  // Bootstrap/recovery: persist only the usable baseline; add no history.
  if (bootstrap) {
    await db.ref(`backend_state/energy/${sid}`).set(newState);
    return finish({ sid, bootstrap: true, intervals: 0 }, newState);
  }

  const nowIso = new Date(nowMs).toISOString();
  let committed = 0;
  for (const iv of intervals) {
    const res = await commitInterval(sid, iv, ratePerKwh, nowIso);
    if (res.claimed) {
      committed += 1;
      energyIncrement += res.appliedKwh;
      latestProcessed = { ...iv, readingId: iv.readingId ?? null };
    }
  }

  // Advance the baseline pointer only AFTER intervals are committed. A crash
  // before this line leaves intervals already claimed (no double count); a
  // replay re-derives them as no-ops.
  if (newState && newState !== state) {
    await db.ref(`backend_state/energy/${sid}`).set(newState);
  }

  return finish({ sid, intervals: committed }, newState);
}

async function runOnce() {
  const rate = await readRate();
  const ids = await listNodeIds();
  const results = [];
  for (const sid of ids) {
    try {
      results.push(await processNode(sid, rate));
    } catch (e) {
      console.error(`[energy-worker] node ${sid} failed:`, e.message);
      results.push({ sid, error: e.message });
    }
  }
  return results;
}

async function main() {
  const watch = process.argv.includes("--watch");
  try {
    if (watch && (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS <= 0)) {
      throw new Error("ENERGY_POLL_INTERVAL_MS must be a positive finite number");
    }
    if (watch) {
      console.log("[energy-worker] watching; delay after each pass: " + POLL_INTERVAL_MS + "ms (Ctrl+C to stop)");
    }
    do {
      try {
        const results = await runOnce();
        console.log("[energy-worker] pass:", JSON.stringify(results));
        if (!watch && results.some(result => result.error)) process.exitCode = 1;
      } catch (e) {
        if (!watch) throw e;
        // Includes the first pass: a recoverable startup read failure must not
        // permanently stop a watch worker.
        console.error("[energy-worker] pass failed:", e.message);
      }
      // Await completion before scheduling another pass, including after errors.
      if (watch) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    } while (watch);
  } finally {
    // One-pass mode must release the Admin SDK connection so the command exits.
    await admin.app().delete();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[energy-worker] fatal:", e.message);
    process.exitCode = 1;
  });
}

module.exports = { runOnce, processNode, commitInterval, applySegment };
