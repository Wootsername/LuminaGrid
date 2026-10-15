// ============================================================
// LuminaGrid backend — Fault Worker
// ============================================================
// Trusted server process (Firebase Admin SDK). Polls streetlights + latest
// telemetry and OWNS the automatic fault lifecycle:
//   ESP32 -> sensor_reading + last_seen -> THIS WORKER -> fault_report
//         -> streetlight status -> notification fan-out -> dashboard displays
// The browser no longer creates or resolves automatic faults (Power Fault,
// Bulb Fault, Node Offline) — it only renders results. SMS stays on the
// ESP32 and remains independent of this process.
//
// Exactly-once strategy (energy-worker lesson: "check then write" is NOT
// enough):
//   * Every transition is CLAIMED inside a ROOT transaction that atomically
//     updates backend_state/fault (node dimension state + event), the fault
//     id counter AND the notification id counter TOGETHER. Two workers
//     racing the same condition -> exactly one claim commits; the loser's
//     callback sees the committed state and aborts.
//   * A pending event stores EVERYTHING needed to finish after a crash: the
//     full fault record, the ids to resolve, and the PRE-BUILT notification
//     records (ids allocated up-front). Re-applying is idempotent: set() at
//     fixed paths with identical content.
//   * Only "applied" events short-circuit; "pending" events are resumed on
//     the next pass. No process-memory guards are trusted.
//   * Browser never reads backend_state (section 10).
//
// Usage:
//   node fault-worker.js              # one pass
//   node fault-worker.js --watch      # loop every FAULT_POLL_INTERVAL_MS
// ============================================================

const { db } = require("./firebase-admin");
const {
  HARDWARE_FAULT_TYPES,
  NODE_OFFLINE_TYPE,
  FAULT_SEVERITY,
  FAULT_DESCRIPTION,
  planFaultActions,
  computeDesiredStatus,
  faultAlertMessage,
  resolutionMessage
} = require("./fault-service");

const POLL_INTERVAL_MS = Number(process.env.FAULT_POLL_INTERVAL_MS || 5000);

function digitsOf(id) {
  const n = parseInt(String(id).replace(/\D/g, ""), 10);
  return isNaN(n) ? null : n;
}

// Next f### fault id, computed INSIDE a claim transaction. Uses
// counter/fault when present; otherwise bootstraps from the highest existing
// fault_report suffix (never below the app's historical f501 start). Skips
// ids that already exist, so browser-created ids can never be overwritten
// (section 13).
function nextFaultIdLocked(root) {
  const faults = root.fault_report || {};
  let n;
  const cur = root.counter && typeof root.counter.fault === "number" ? root.counter.fault : null;
  if (cur != null) {
    n = cur + 1;
  } else {
    const nums = Object.keys(faults).map(digitsOf).filter((x) => x != null);
    n = (nums.length ? Math.max.apply(null, nums) : 500) + 1;
  }
  while (faults["f" + n]) n++;
  root.counter = root.counter || {};
  root.counter.fault = n;
  return "f" + n;
}

// Build the COMPLETE notification records for one fan-out, allocating their
// ids atomically (counter/notification) inside the same claim transaction.
// One copy per ACTIVE user (Deactivated excluded). Ids are persisted in the
// pending event before any notification is written, so a crash can never
// allocate new ids on retry (sections 14/15).
function buildNotificationPlanLocked(root, base) {
  const users = Object.values(root.user || {}).filter((u) => u && u.status === "Active");
  if (users.length === 0) return [];
  const existing = root.notification || {};
  const idOf = (n) => "n" + String(n).padStart(3, "0");
  let start;
  const cur = root.counter && typeof root.counter.notification === "number" ? root.counter.notification : null;
  if (cur != null) {
    start = cur + 1;
  } else {
    const nums = Object.keys(existing).map(digitsOf).filter((x) => x != null);
    start = (nums.length ? Math.max.apply(null, nums) : 0) + 1;
  }
  const collides = (s) => users.some((_, i) => existing[idOf(s + i)]);
  while (collides(start)) start++;
  root.counter = root.counter || {};
  root.counter.notification = start + users.length - 1;
  return users.map((u, i) => ({
    notification_id: idOf(start + i),
    fault_id: base.fault_id,
    user_id: u.user_id,
    notification_type: base.notification_type,
    message: base.message,
    status: "Unread",
    sent_at: base.sent_at
  }));
}

// Pending fault ids for one node/type set, read FRESH inside a transaction.
function pendingFaultIds(root, sid, types) {
  const out = [];
  const faults = root.fault_report || {};
  for (const id of Object.keys(faults)) {
    const f = faults[id];
    if (
      f &&
      f.status === "Pending" &&
      String(f.streetlight_id) === String(sid) &&
      types.includes(f.fault_type)
    ) {
      out.push(id);
    }
  }
  return out;
}

// Ensure + return the backend_state/fault subtree of a root-transaction
// payload (mutating in place is safe: RTDB hands the callback a private
// deserialized copy, and contention re-runs the callback with fresh data).


// Ensure + return the backend_state/fault subtree of a root-transaction
// payload (mutating in place is safe: RTDB hands the callback a private
// deserialized copy, and contention re-runs the callback with fresh data).
function faultStateRoot(root) {
  root.backend_state = root.backend_state || {};
  const f = (root.backend_state.fault = root.backend_state.fault || {});
  f.nodes = f.nodes || {};
  f.events = f.events || {};
  return f;
}

// ---------- Claim: ensure a Pending hardware fault exists ----------
// Deduplicates repeated telemetry (steady state aborts), adopts existing
// dashboard-era Pending faults instead of duplicating them (section 19), and
// allocates fault id + notification ids atomically with the claim.
async function ensureHardwareFault(sid, type, readingId, nowIso) {
  const severity = FAULT_SEVERITY[type];
  const description = FAULT_DESCRIPTION[type];
  const res = await db.ref().transaction((raw) => {
    const root = raw || {};
    const f = faultStateRoot(root);
    f.nodes[sid] = f.nodes[sid] || {};
    const cur = f.nodes[sid].hw || null;

    if (cur && cur.phase === "pending") return; // in-flight or crash-pending -> resume path owns it
    const same = pendingFaultIds(root, sid, [type]);
    if (cur && cur.state === type && cur.phase === "applied" && same.length > 0) return; // steady -> dedupe (section 11)

    const episode = ((cur && cur.episode) || 0) + 1;

    if (same.length > 0) {
      // Adopt the existing Pending record (bootstrap / legacy) — no duplicate.
      f.nodes[sid].hw = { state: type, phase: "applied", episode, adopted: true, applied_at: nowIso };
      return root;
    }

    // NEW episode: allocate everything now, atomically (sections 12/13/14).
    const faultId = nextFaultIdLocked(root);
    const record = {
      fault_id: faultId,
      streetlight_id: String(sid),
      reading_id: readingId == null ? null : readingId,
      fault_type: type,
      description,
      severity,
      status: "Pending",
      detected_at: nowIso,
      resolved_at: null
    };
    // Power <-> Bulb transition: the NEW type is established first; stale ids
    // of the other hardware type are closed inside the SAME applied event
    // (section 8) — with NO resolution fan-out (no misleading full recovery).
    const stale = pendingFaultIds(root, sid, HARDWARE_FAULT_TYPES.filter((t) => t !== type));
    const alerts = buildNotificationPlanLocked(root, {
      fault_id: faultId,
      notification_type: "Fault Alert",
      message: faultAlertMessage(record, (root.streetlight || {})[sid]),
      sent_at: nowIso
    });
    const key = `${sid}|hw|${type}|ep${episode}`;
    f.events[key] = {
      status: "pending",
      kind: "create_hw",
      dim: "hw",
      sid: String(sid),
      fault_record: record,
      stale_ids: stale,
      stale_resolved_at: nowIso,
      alert_plan: alerts,
      started_at: nowIso
    };
    f.nodes[sid].hw = { state: type, phase: "pending", episode, event_key: key, started_at: nowIso };
    return root;
  });

  if (!res.committed) return { committed: false };
  return { committed: true, ...(extractEvent(res.snapshot.val(), sid, "hw")) };
}

// ---------- Claim: resolve ALL pending hardware faults (fresh NIGHT NORMAL) ----------
// One consolidated resolution (section 9): legacy duplicate Pendings all
// close in ONE event and at most ONE Resolution fan-out is emitted — and
// only when no other Pending non-offline fault remains.
async function resolveHardwareFaults(sid, nowIso) {
  const res = await db.ref().transaction((raw) => {
    const root = raw || {};
    const f = faultStateRoot(root);
    f.nodes[sid] = f.nodes[sid] || {};
    const cur = f.nodes[sid].hw || null;

    if (cur && cur.phase === "pending") return; // in-flight/crashed -> resume owns it
    const ids = pendingFaultIds(root, sid, HARDWARE_FAULT_TYPES);
    if (ids.length === 0) {
      if (cur && cur.state === "NORMAL" && cur.phase === "applied") return; // steady
      // Nothing pending: settle the dimension to NORMAL (adopt).
      f.nodes[sid].hw = {
        state: "NORMAL",
        phase: "applied",
        episode: ((cur && cur.episode) || 0) + 1,
        adopted: true,
        applied_at: nowIso
      };
      return root;
    }

    const episode = ((cur && cur.episode) || 0) + 1;
    const faults = root.fault_report || {};
    // Deterministic order (newest first); the newest is the message subject.
    const resolveIds = ids.slice().sort(
      (a, b) =>
        Date.parse((faults[b] && faults[b].detected_at) || "") -
        Date.parse((faults[a] && faults[a].detected_at) || "")
    );
    const rep = faults[resolveIds[0]];
    const remaining = Object.keys(faults).filter((id) => {
      const fx = faults[id];
      return (
        fx &&
        fx.status === "Pending" &&
        String(fx.streetlight_id) === String(sid) &&
        fx.fault_type !== NODE_OFFLINE_TYPE &&
        resolveIds.indexOf(id) === -1
      );
    });
    const resolutionNeeded = remaining.length === 0;
    const plan = resolutionNeeded
      ? buildNotificationPlanLocked(root, {
          fault_id: rep.fault_id,
          notification_type: "Resolution",
          message: resolutionMessage(
            { fault_id: rep.fault_id, fault_type: rep.fault_type, streetlight_id: rep.streetlight_id },
            (root.streetlight || {})[sid]
          ),
          sent_at: nowIso
        })
      : [];
    const key = `${sid}|hwres|ep${episode}`;
    f.events[key] = {
      status: "pending",
      kind: "resolve_hw",
      dim: "hw",
      sid: String(sid),
      resolve_ids: resolveIds,
      resolved_at: nowIso,
      resolution_needed: resolutionNeeded,
      resolution_plan: plan,
      rep_fault_id: rep.fault_id,
      started_at: nowIso
    };
    f.nodes[sid].hw = { state: "NORMAL", phase: "pending", episode, event_key: key, started_at: nowIso };
    return root;
  });

  if (!res.committed) return { committed: false };
  return { committed: true, ...(extractEvent(res.snapshot.val(), sid, "hw")) };
}


// Pull the claimed event (+ adoption flag) out of a committed root snapshot.
function extractEvent(rootVal, sid, dim) {
  const f = (((rootVal || {}).backend_state || {}).fault || {});
  const st = ((f.nodes || {})[sid] || {})[dim] || null;
  const key = st ? st.event_key : null;
  const ev = key ? (f.events || {})[key] || null : null;
  return { eventKey: key, event: ev, adopted: !ev };
}

// ---------- Apply (idempotent) + finalize ----------
// Every write below is a set()/targeted update at a FIXED path with content
// derived only from the event, so re-running after a crash can never
// duplicate a fault, a notification, or a resolution (sections 11/15).
async function applyEvent(key, ev) {
  if (!ev) return { applied: false };

  if (ev.status === "applied") {
    // Replay of a finished event: only reconcile the phase marker.
    await finalizeEvent(key, ev);
    return { applied: true, replay: true };
  }

  if (ev.kind === "create_hw" || ev.kind === "create_offline") {
    // 1) fault_report (the event's record was fully built at claim time)
    await db.ref("fault_report/" + ev.fault_record.fault_id).set(ev.fault_record);
    // 2) close stale duplicates of the OTHER hardware type silently —
    //    transition (section 8): NO resolution fan-out, node stays Faulty.
    for (const id of ev.stale_ids || []) {
      const snap = await db.ref("fault_report/" + id).once("value");
      const rec = snap.val();
      if (rec && rec.status !== "Resolved") {
        await db.ref("fault_report/" + id).update({
          status: "Resolved",
          resolved_at: ev.stale_resolved_at
        });
      }
    }
    // 3) node status immediately (also enforced by the end-of-pass sync)
    await db
      .ref("streetlight/" + ev.sid + "/status")
      .set(ev.kind === "create_offline" ? "Offline" : "Faulty");
    // 4) notifications — pre-built, fixed ids: retry writes the same records.
    for (const n of ev.alert_plan || []) {
      await db.ref("notification/" + n.notification_id).set(n);
    }
  } else if (ev.kind === "resolve_hw" || ev.kind === "resolve_offline") {
    for (const id of ev.resolve_ids || []) {
      const snap = await db.ref("fault_report/" + id).once("value");
      const rec = snap.val();
      if (rec && rec.status !== "Resolved") {
        await db.ref("fault_report/" + id).update({
          status: "Resolved",
          resolved_at: ev.resolved_at
        });
      }
    }
    // At most ONE consolidated Resolution fan-out, only if the claim decided
    // no other Pending non-offline fault remains (sections 8/9).
    if (ev.resolution_needed) {
      for (const n of ev.resolution_plan || []) {
        await db.ref("notification/" + n.notification_id).set(n);
      }
    }
  }

  await finalizeEvent(key, ev);
  return { applied: true };
}

// Mark the event applied and its node dimension phase applied — the only
// short-circuit for future passes (a pending phase always resumes).
async function finalizeEvent(key, ev) {
  await db.ref().transaction((raw) => {
    const root = raw || {};
    const f = faultStateRoot(root);
    const e = f.events[key];
    if (!e) return; // event gone -> nothing to finalize
    if (e.status !== "applied") {
      e.status = "applied";
      e.applied_at = new Date().toISOString();
    }
    const ns = f.nodes[ev.sid];
    if (ns && ns[ev.dim] && ns[ev.dim].event_key === key && ns[ev.dim].phase !== "applied") {
      ns[ev.dim].phase = "applied";
    }
    return root;
  });
}

// Newest reading for one node: bounded query (never a full historical scan,
// section 20) — last 25 keys, then the greatest valid timestamp wins.
async function readLatestReading(sid) {
  const snap = await db
    .ref("sensor_reading/" + sid)
    .orderByKey()
    .limitToLast(25)
    .once("value");
  const raw = snap.val() || {};
  let best = null;
  let bestMs = -Infinity;
  for (const k of Object.keys(raw).sort()) {
    const r = raw[k];
    if (!r || !r.timestamp) continue;
    const ms = Date.parse(r.timestamp);
    // >= : on equal timestamps the LATER key wins (keys are monotonically
    // increasing), so back-to-back uploads never resolve to the older record.
    if (!isNaN(ms) && ms >= bestMs) {
      bestMs = ms;
      best = r;
    }
  }
  return best;
}

// ---------- Process one node (one pass) ----------
async function processNode(sid, ctx) {
  const out = { sid };

  // 1) RESUME first: finish any claim a crashed pass left pending. The
  //    event carries everything needed; applyEvent is idempotent.
  const stSnap = await db.ref("backend_state/fault/nodes/" + sid).once("value");
  const st = stSnap.val() || {};
  for (const dim of ["hw", "off"]) {
    const s = st[dim];
    if (s && s.phase === "pending" && s.event_key) {
      const evSnap = await db.ref("backend_state/fault/events/" + s.event_key).once("value");
      const ev = evSnap.val();
      if (!ev) {
        // Defensive: the event record is missing (externally deleted). Unblock
        // the dimension without inventing any fault data.
        await db.ref().transaction((raw) => {
          const root = raw || {};
          const f = faultStateRoot(root);
          const ns = f.nodes[sid];
          if (ns && ns[dim] && ns[dim].event_key === s.event_key) {
            ns[dim] = { ...ns[dim], phase: "applied", recovered: true };
          }
          return root;
        });
        (out.stuck = out.stuck || []).push(dim);
      } else {
        await applyEvent(s.event_key, ev);
        (out.resumed = out.resumed || []).push(ev.kind);
      }
    }
  }

  // 2) Fresh inputs -> pure plan (claims re-validate inside transactions).
  const node = ctx.nodes[sid] || null;
  const pending = ctx.pendingBySid[String(sid)] || [];
  const reading = await readLatestReading(sid);
  const plan = planFaultActions({
    node,
    reading,
    pending,
    heartbeatTimeoutMin: ctx.timeoutMin,
    nowMs: ctx.nowMs
  });

  // 3) Execute in safe order: create BEFORE resolve within a dimension so a
  //    Power<->Bulb transition never passes through Active (section 8).
  if (plan.hw && plan.hw.kind === "ensure") {
    const c = await ensureHardwareFault(sid, plan.hw.type, reading ? reading.reading_id : null, ctx.nowIso);
    if (c.committed) {
      if (c.event) {
        await applyEvent(c.eventKey, c.event);
        out.created = c.event.fault_record.fault_type;
      } else {
        out.adopted = plan.hw.type;
      }
    } else {
      (out.steady = out.steady || []).push(plan.hw.type); // deduped / in-flight
    }
  }
  if (plan.hw && plan.hw.kind === "resolve") {
    const c = await resolveHardwareFaults(sid, ctx.nowIso);
    if (c.committed) {
      if (c.event) {
        await applyEvent(c.eventKey, c.event);
        out.resolved = "hardware";
      } else {
        out.adopted = "NORMAL";
      }
    }
  }
  if (plan.offline === "create") {
    const c = await createOfflineFault(sid, ctx.nowIso);
    if (c.committed) {
      if (c.event) {
        await applyEvent(c.eventKey, c.event);
        out.created = NODE_OFFLINE_TYPE;
      } else {
        out.adopted = NODE_OFFLINE_TYPE;
      }
    }
  }
  if (plan.offline === "resolve") {
    const c = await resolveOfflineFault(sid, ctx.nowIso);
    if (c.committed) {
      if (c.event) {
        await applyEvent(c.eventKey, c.event);
        out.resolved = "offline";
      } else {
        out.adopted = "NONE";
      }
    }
  }

  // 4) STATUS AUTHORITY (section 16) from FRESH reads after all mutations:
  //    never-seen -> Offline; timed out -> Offline; any Pending non-offline
  //    -> Faulty; otherwise -> Active.
  const [nodeSnap, faultsSnap] = await Promise.all([
    db.ref("streetlight/" + sid).once("value"),
    db.ref("fault_report").once("value")
  ]);
  const freshNode = nodeSnap.val();
  if (freshNode) {
    const freshPending = Object.values(faultsSnap.val() || {}).filter(
      (f) => f && f.status === "Pending" && String(f.streetlight_id) === String(sid)
    );
    const desired = computeDesiredStatus({
      node: freshNode,
      pending: freshPending,
      heartbeatTimeoutMin: ctx.timeoutMin,
      nowMs: ctx.nowMs,
      hasReading: !!reading
    });
    if (desired && freshNode.status !== desired) {
      await db.ref("streetlight/" + sid + "/status").set(desired);
      out.status = desired;
    }
  }

  return out;
}

// ---------- One full pass over every registered node ----------
// Node list comes from the streetlight node each pass — newly registered
// nodes (e.g. LG-05) are handled dynamically; there is no hardcoded id list.
async function runOnce(nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const nowIso = new Date(now).toISOString();

  const [timeoutSnap, nodesSnap, faultsSnap] = await Promise.all([
    db.ref("system_config/heartbeat_timeout_minutes").once("value"),
    db.ref("streetlight").once("value"),
    db.ref("fault_report").once("value")
  ]);
  const timeoutVal = Number(timeoutSnap.val());
  const timeoutMin = timeoutVal > 0 ? timeoutVal : 10;

  const nodes = {};
  for (const [k, v] of Object.entries(nodesSnap.val() || {})) {
    if (v) nodes[k] = v;
  }

  const pendingBySid = {};
  for (const f of Object.values(faultsSnap.val() || {})) {
    if (f && f.status === "Pending") {
      const k = String(f.streetlight_id);
      (pendingBySid[k] = pendingBySid[k] || []).push(f);
    }
  }

  const ctx = { nodes, pendingBySid, timeoutMin, nowMs: now, nowIso };
  const results = [];
  for (const sid of Object.keys(nodes)) {
    try {
      results.push(await processNode(sid, ctx));
    } catch (e) {
      console.error(`[fault-worker] node ${sid} failed:`, e.message);
      results.push({ sid, error: e.message });
    }
  }
  return results;
}

async function main() {
  const watch = process.argv.includes("--watch");
  console.log("[fault-worker] pass:", JSON.stringify(await runOnce()));
  if (!watch) return;
  console.log(`[fault-worker] watching every ${POLL_INTERVAL_MS}ms (Ctrl+C to stop)`);
  setInterval(async () => {
    try {
      console.log("[fault-worker] pass:", JSON.stringify(await runOnce()));
    } catch (e) {
      console.error("[fault-worker] pass failed:", e.message);
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[fault-worker] fatal:", e.message);
    process.exit(1);
  });
}

module.exports = {
  runOnce,
  processNode,
  ensureHardwareFault,
  resolveHardwareFaults,
  createOfflineFault,
  resolveOfflineFault,
  applyEvent,
  finalizeEvent,
  readLatestReading,
  nextFaultIdLocked,
  buildNotificationPlanLocked
};

// Section 5: only for nodes that HAVE heartbeated before and now exceed the
// configured timeout. Never-heartbeated nodes never reach this path.
async function createOfflineFault(sid, nowIso) {
  const type = NODE_OFFLINE_TYPE;
  const res = await db.ref().transaction((raw) => {
    const root = raw || {};
    const f = faultStateRoot(root);
    f.nodes[sid] = f.nodes[sid] || {};
    const cur = f.nodes[sid].off || null;

    if (cur && cur.phase === "pending") return;
    const same = pendingFaultIds(root, sid, [type]);
    if (cur && cur.state === "TIMEOUT" && cur.phase === "applied" && same.length > 0) return; // steady -> no duplicate
    const episode = ((cur && cur.episode) || 0) + 1;

    if (same.length > 0) {
      // Existing Pending Node Offline (dashboard-era / seeded) -> adopt.
      f.nodes[sid].off = { state: "TIMEOUT", phase: "applied", episode, adopted: true, applied_at: nowIso };
      return root;
    }

    const faultId = nextFaultIdLocked(root);
    const record = {
      fault_id: faultId,
      streetlight_id: String(sid),
      reading_id: null,
      fault_type: type,
      description: FAULT_DESCRIPTION[type],
      severity: FAULT_SEVERITY[type],
      status: "Pending",
      detected_at: nowIso,
      resolved_at: null
    };
    const alerts = buildNotificationPlanLocked(root, {
      fault_id: faultId,
      notification_type: "Fault Alert",
      message: faultAlertMessage(record, (root.streetlight || {})[sid]),
      sent_at: nowIso
    });
    const key = `${sid}|off|TIMEOUT|ep${episode}`;
    f.events[key] = {
      status: "pending",
      kind: "create_offline",
      dim: "off",
      sid: String(sid),
      fault_record: record,
      alert_plan: alerts,
      started_at: nowIso
    };
    f.nodes[sid].off = { state: "TIMEOUT", phase: "pending", episode, event_key: key, started_at: nowIso };
    return root;
  });

  if (!res.committed) return { committed: false };
  return { committed: true, ...(extractEvent(res.snapshot.val(), sid, "off")) };
}

// ---------- Claim: heartbeat returned -> resolve Pending Node Offline ----------
// Section 5: after resolution the end-of-pass status sync decides the final
// state (Faulty if another Pending non-offline fault exists, else Active).
async function resolveOfflineFault(sid, nowIso) {
  const type = NODE_OFFLINE_TYPE;
  const res = await db.ref().transaction((raw) => {
    const root = raw || {};
    const f = faultStateRoot(root);
    f.nodes[sid] = f.nodes[sid] || {};
    const cur = f.nodes[sid].off || null;

    if (cur && cur.phase === "pending") return;
    const ids = pendingFaultIds(root, sid, [type]);
    if (ids.length === 0) {
      if (cur && cur.state === "NONE" && cur.phase === "applied") return; // steady
      f.nodes[sid].off = {
        state: "NONE",
        phase: "applied",
        episode: ((cur && cur.episode) || 0) + 1,
        adopted: true,
        applied_at: nowIso
      };
      return root;
    }

    const episode = ((cur && cur.episode) || 0) + 1;
    const faults = root.fault_report || {};
    const resolveIds = ids.slice().sort(
      (a, b) =>
        Date.parse((faults[b] && faults[b].detected_at) || "") -
        Date.parse((faults[a] && faults[a].detected_at) || "")
    );
    const rep = faults[resolveIds[0]];
    // Browser parity: Resolution fan-out only when NO other Pending
    // NON-OFFLINE fault remains (resolveFaultReport's stillPending check).
    const remaining = Object.keys(faults).filter((id) => {
      const fx = faults[id];
      return (
        fx &&
        fx.status === "Pending" &&
        String(fx.streetlight_id) === String(sid) &&
        fx.fault_type !== NODE_OFFLINE_TYPE &&
        resolveIds.indexOf(id) === -1
      );
    });
    const resolutionNeeded = remaining.length === 0;
    const plan = resolutionNeeded
      ? buildNotificationPlanLocked(root, {
          fault_id: rep.fault_id,
          notification_type: "Resolution",
          message: resolutionMessage(
            { fault_id: rep.fault_id, fault_type: rep.fault_type, streetlight_id: rep.streetlight_id },
            (root.streetlight || {})[sid]
          ),
          sent_at: nowIso
        })
      : [];
    const key = `${sid}|off|RESOLVE|ep${episode}`;
    f.events[key] = {
      status: "pending",
      kind: "resolve_offline",
      dim: "off",
      sid: String(sid),
      resolve_ids: resolveIds,
      resolved_at: nowIso,
      resolution_needed: resolutionNeeded,
      resolution_plan: plan,
      rep_fault_id: rep.fault_id,
      started_at: nowIso
    };
    f.nodes[sid].off = { state: "NONE", phase: "pending", episode, event_key: key, started_at: nowIso };
    return root;
  });

  if (!res.committed) return { committed: false };
  return { committed: true, ...(extractEvent(res.snapshot.val(), sid, "off")) };
}


