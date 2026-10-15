// ============================================================
// LuminaGrid backend — Energy Worker
// ============================================================
// Trusted server process (Firebase Admin SDK). Runs on a poll interval,
// integrates each node's instantaneous power (Watts) into monthly kWh, and
// writes the aggregates to energy_monthly. Restart-safe and concurrency-safe:
//
//   * Each processed interval has a DETERMINISTIC id
//     (sid:prevTs:curTs) recorded at backend_state/energy/processed/{sid}/{key}.
//   * The aggregate increment is committed ONLY inside a runTransaction that
//     claims that id. A crash between the aggregate write and the state write
//     therefore cannot double-count: on restart the id is already claimed and
//     the transaction is a no-op. Two workers racing on the same interval:
//     exactly one wins the transaction, so exactly one increment lands.
//   * FIRST BOOTSTRAP: when no state exists, we store the latest reading as the
//     baseline and add 0 kWh — historical readings are NOT back-integrated.
//
// Browser reads today's total from the current energy_monthly record's
// `today` child (client-readable) — never from a private backend_state path.
//
// Usage:
//   node energy-worker.js              # one pass
//   node energy-worker.js --watch      # loop every POLL_INTERVAL_MS
// ============================================================

const { db } = require("./firebase-admin");
const {
  planIntervals,
  intervalKey,
  costFor
} = require("./energy-service");

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

// Claim an interval id and, only on a fresh claim, apply the kWh delta to the
// monthly + per-node + today aggregates. Idempotent + concurrency-safe: the
// runTransaction is atomic; a second caller (crash replay or second worker)
// sees the id already claimed and the transaction applies nothing.
// Apply one (node, month) segment idempotently. Monthly total, per-node total,
// the day bucket AND the per-interval applied-marker ALL live under
// energy_monthly/{monthKey}, so they are updated in a SINGLE transaction —
// atomic, so a crash can never leave the monthly total applied but the daily
// bucket missing, and can never half-write. The marker `_applied[key]` guards
// the transaction: if this exact interval was already applied we abort with no
// change. Because the marker is keyed by the interval (not a high-water mark),
// it is order-independent and makes re-processing after a crash, or a second
// worker racing the same interval, contribute exactly once (no double count).
async function applySegment(sid, key, seg, ratePerKwh, nowIso) {
  const monthRef = db.ref(`energy_monthly/${seg.monthKey}`);
  const res = await monthRef.transaction((cur) => {
    const rec = cur || { month: seg.monthKey };
    const applied = rec._applied || {};
    if (applied[key]) return; // already applied -> abort (idempotent no-op)

    const nodes = { ...(rec.nodes || {}) };
    const prev = nodes[sid] || { streetlight_id: Number(sid), total_kwh: 0, cost: 0 };
    const nodeKwh = round6((prev.total_kwh || 0) + seg.kwh);
    nodes[sid] = {
      streetlight_id: Number(sid),
      total_kwh: nodeKwh,
      cost: round6(costFor(nodeKwh, ratePerKwh)),
      updated_at: nowIso
    };
    const monthTotal = round6(
      Object.values(nodes).reduce((s, n) => s + (n.total_kwh || 0), 0)
    );

    // Daily bucket for THIS segment's day — ACCUMULATE (never overwrite).
    const today = { ...(rec.today || {}) };
    today[seg.dayKey] = round6((Number(today[seg.dayKey]) || 0) + seg.kwh);

    return {
      ...rec,
      month: seg.monthKey,
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
    return { claimed: false, alreadyApplied: true };
  }

  // 2) Apply each month segment. Idempotent + concurrency-safe via the
  //    per-interval applied-marker inside each month transaction (applySegment).
  let applied = false;
  for (const seg of iv.segments) {
    const didApply = await applySegment(sid, key, seg, ratePerKwh, nowIso);
    if (didApply) applied = true;
  }

  // 3) Mark the claim fully APPLIED (idempotent). A crash before this leaves the
  //    claim PENDING, but the month transactions are already idempotent, so a
  //    later pass simply re-derives no-ops and then finalizes the claim here.
  await claimRef.transaction((cur) => {
    if (cur === null) return { status: "applied", sid, key, applied_at: nowIso };
    if (cur.status === "applied") return; // already finalized by another worker
    return { ...cur, status: "applied", applied_at: nowIso };
  });

  return { claimed: applied };
}

// Process one node.
async function processNode(sid, ratePerKwh) {
  const stateSnap = await db.ref(`backend_state/energy/${sid}`).once("value");
  const state = stateSnap.val() || null;

  const readingsSnap = await db.ref(`sensor_reading/${sid}`).once("value");
  const raw = readingsSnap.val() || {};
  const readings = Object.entries(raw).map(([key, r]) => ({ key, ...r }));

  if (readings.length === 0) return { sid, intervals: 0 };

  const { bootstrap, intervals, newState } = planIntervals(state, readings);

  // FIRST BOOTSTRAP: persist the baseline, integrate nothing (no history).
  if (bootstrap) {
    await db.ref(`backend_state/energy/${sid}`).set(newState);
    return { sid, bootstrap: true, intervals: 0 };
  }

  const nowIso = new Date().toISOString();
  let committed = 0;
  for (const iv of intervals) {
    const res = await commitInterval(sid, iv, ratePerKwh, nowIso);
    if (res.claimed) committed += 1;
  }

  // Advance the baseline pointer only AFTER intervals are committed. A crash
  // before this line leaves intervals already claimed (no double count); a
  // replay re-derives them as no-ops.
  if (newState) {
    await db.ref(`backend_state/energy/${sid}`).set(newState);
  }

  return { sid, intervals: committed };
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
  console.log("[energy-worker] pass:", JSON.stringify(await runOnce()));
  if (!watch) return;
  console.log(`[energy-worker] watching every ${POLL_INTERVAL_MS}ms (Ctrl+C to stop)`);
  setInterval(async () => {
    try {
      console.log("[energy-worker] pass:", JSON.stringify(await runOnce()));
    } catch (e) {
      console.error("[energy-worker] pass failed:", e.message);
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[energy-worker] fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { runOnce, processNode, commitInterval, applySegment };
