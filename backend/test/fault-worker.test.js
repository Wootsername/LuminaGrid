// ============================================================
// LuminaGrid backend â€” Fault WORKER lifecycle tests
// Run: node test/fault-worker.test.js
// ============================================================
// In-memory RTDB stub with real transaction semantics serialized per path
// (root transactions lock "") plus one-shot failure injection to simulate
// worker crashes at exact points (sections 11/12/15). The Admin SDK `db` is
// injected by stubbing "./firebase-admin" â€” no credentials needed.
// ============================================================
const path = require("path");
const fs = require("fs");
const Module = require("module");

const root = path.join(__dirname, "..", "..");
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

let pass = 0;
const fails = [];
function assert(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fails.push(label); console.log("  FAIL " + label); }
}

// ---------- In-memory RTDB stub ----------
function makeDb(store) {
  const locks = {};
  const withLock = (p, fn) => {
    locks[p] = (locks[p] || Promise.resolve()).then(fn, fn);
    return locks[p];
  };
  const getPath = (p) => String(p == null ? "" : p).split("/").filter(Boolean);
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
    if (parts.length === 0) {
      for (const k of Object.keys(store)) delete store[k];
      if (val && typeof val === "object") Object.assign(store, val);
      return;
    }
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = val;
  };
  const clone = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
  // One-shot failure injection: matcher(path) -> throw before the write.
  const inject = { matcher: null, remaining: 0 };
  const guard = (p) => {
    if (inject.matcher && inject.remaining > 0 && inject.matcher(p)) {
      inject.remaining--;
      throw new Error("injected crash at " + p);
    }
  };
  return {
    ref(p) {
      const refPath = p == null ? "" : String(p);
      return {
        orderByKey() {
          return {
            limitToLast(n) {
              return {
                async once() {
                  const v = readNode(refPath);
                  const keys = v && typeof v === "object" ? Object.keys(v).sort() : [];
                  const out = {};
                  keys.slice(-n).forEach((k) => { out[k] = v[k]; });
                  return { val: () => clone(out), exists: () => keys.length > 0 };
                }
              };
            }
          };
        },
        async once() {
          const v = readNode(refPath);
          return { val: () => clone(v), exists: () => v !== null };
        },
        async set(v) {
          guard(refPath);
          return withLock(refPath, async () => { writeNode(refPath, clone(v)); });
        },
        async update(v) {
          guard(refPath);
          return withLock(refPath, async () => {
            const cur = readNode(refPath);
            const base = cur && typeof cur === "object" ? cur : {};
            writeNode(refPath, Object.assign({}, clone(base), clone(v)));
          });
        },
        async transaction(updater) {
          return withLock(refPath, () => {
            const cur = readNode(refPath);
            const next = updater(cur === null ? null : clone(cur));
            if (next === undefined) {
              return { committed: false, snapshot: { val: () => clone(readNode(refPath)) } };
            }
            writeNode(refPath, next);
            return { committed: true, snapshot: { val: () => clone(readNode(refPath)) } };
          });
        }
      };
    },
    _store: store,
    _arm(matcher) { inject.matcher = matcher; inject.remaining = 1; },
    _disarm() { inject.matcher = null; inject.remaining = 0; }
  };
}

const proxyDb = { ref(...args) { return global.__FAKE_DB__.ref(...args); } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./firebase-admin") return { db: proxyDb };
  return origLoad.call(this, request, parent, isMain);
};
const worker = require(path.join(__dirname, "..", "fault-worker.js"));

// ---------- Fixtures ----------
let readingSeq = 0;
function freshStore() {
  const store = {
    streetlight: {
      "1": { streetlight_id: 1, node_id: "LG-01", pole_number: "P-001", barangay: "Guadalupe",
        location: "Test St", latitude: 10.31, longitude: 123.88,
        installation_date: "2026-06-01", status: "Active", last_seen: iso(NOW - 5000) }
    },
    system_config: { heartbeat_timeout_minutes: 10 },
    user: {
      u001: { user_id: "u001", first_name: "Admin", status: "Active" },
      u002: { user_id: "u002", first_name: "Tech", status: "Active" },
      u003: { user_id: "u003", first_name: "Gone", status: "Deactivated" }
    }
  };
  global.__FAKE_DB__ = makeDb(store);
  return store;
}
function setReading(store, sid, opts) {
  const key = "rk" + String(++readingSeq).padStart(3, "0");
  store.sensor_reading = store.sensor_reading || {};
  store.sensor_reading[sid] = store.sensor_reading[sid] || {};
  store.sensor_reading[sid][key] = {
    reading_id: key,
    streetlight_id: Number(sid),
    ambient_light: opts.ambient_light,
    voltage: opts.voltage,
    current: opts.current,
    light_status: opts.ambient_light === 1 ? "ON" : "OFF",
    timestamp: iso(opts.tsMs == null ? NOW - 5000 : opts.tsMs)
  };
  return key;
}
function pendingOf(store, type) {
  return Object.values(store.fault_report || {}).filter(
    (f) => f && f.status === "Pending" && (!type || f.fault_type === type)
  );
}
function faultsOf(store, type) {
  return Object.values(store.fault_report || {}).filter(
    (f) => f && f.fault_type === type
  );
}
function notifs(store, type) {
  return Object.values(store.notification || {}).filter(
    (n) => n && (!type || n.notification_type === type)
  );
}

const NIGHT = { ambient_light: 1 };

(async () => {
  console.log("== 13/14. normal -> Power / Bulb creation ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    const pend = pendingOf(store, "Power Fault");
    assert(pend.length === 1, "13 exactly one Pending Power Fault created");
    assert(pend[0] && pend[0].severity === "High", "13 severity High");
    assert(pend[0] && pend[0].description.indexOf("below 3.0 V") > 0, "13 description wording (3.0 V)");
    assert(pend[0] && pend[0].fault_id === "f501", "13 fault id follows f### convention (f501)");
    assert(pend[0] && String(pend[0].reading_id).indexOf("rk") === 0, "13 linked latest reading_id");
    assert(store.streetlight["1"].status === "Faulty", "40 fault => streetlight Faulty");
    const alerts = notifs(store, "Fault Alert");
    assert(alerts.length === 2, "36 exactly one Fault Alert per Active user (2)");
    assert(alerts.every((n) => n.user_id === "u001" || n.user_id === "u002"), "37 Deactivated user excluded");
    assert(!notifs(store).some((n) => n.user_id === "u003"), "37 no copy written for Deactivated");
    assert(alerts.every((n) => n.status === "Unread" && n.fault_id === "f501" && n.notification_id && n.sent_at),
      "14 notification fields preserved (id/fault_id/type/status/sent_at)");
    assert(store.counter && store.counter.fault === 501, "13 fault counter bootstrapped at 501");
    const hw = store.backend_state.fault.nodes["1"].hw;
    assert(hw.phase === "applied" && hw.state === "Power Fault", "13 event applied in backend_state");
  }
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.2, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    const pend = pendingOf(store, "Bulb Fault");
    assert(pend.length === 1 && pend[0].severity === "Medium", "14 one Medium Pending Bulb Fault");
    assert(pend[0].description.indexOf("below 0.50 A") > 0, "14 description wording (0.50 A)");
    assert(store.streetlight["1"].status === "Faulty", "40 bulb fault => Faulty");
  }

  console.log("== 15/16. repeated telemetry = one fault ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3, tsMs: NOW - 8000 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 2.4, current: 0.31, tsMs: NOW - 4000 });
    setReading(store, "1", { ambient_light: 1, voltage: 2.3, current: 0.32, tsMs: NOW - 2000 });
    await worker.runOnce(NOW);
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Power Fault").length === 1, "15 Power persists -> still ONE Pending fault");
    assert(Object.keys(store.fault_report || {}).length === 1, "15 no extra fault records");
    assert(notifs(store, "Fault Alert").length === 2, "38 repeated telemetry -> no duplicate alert fan-out");
  }
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.1, tsMs: NOW - 8000 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.1, tsMs: NOW - 2000 });
    await worker.runOnce(NOW);
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Bulb Fault").length === 1, "16 Bulb persists -> still ONE Pending fault");
    assert(Object.keys(store.fault_report || {}).length === 1, "16 no extra fault records");
  }

  console.log("== 17/18. Power <-> Bulb transitions ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.2, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Bulb Fault").length === 1, "17 Bulb Fault established");
    assert(pendingOf(store, "Power Fault").length === 0, "17 old Power Fault resolved");
    assert(faultsOf(store, "Power Fault")[0].status === "Resolved", "17 Power record is Resolved");
    assert(pendingOf(store).length === 1, "17 exactly one pending after transition");
    assert(store.streetlight["1"].status === "Faulty", "17 transition ends Faulty (never Active)");
    assert(notifs(store, "Resolution").length === 0, "17 no misleading Resolution during transition");
    assert(notifs(store, "Fault Alert").length === 4, "17 new Bulb alert fan-out (2 + 2)");
  }
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.2, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 2.4, current: 0.1, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Power Fault").length === 1, "18 Bulb -> Power establishes Power");
    assert(pendingOf(store, "Bulb Fault").length === 0, "18 old Bulb resolved");
    assert(store.streetlight["1"].status === "Faulty", "18 transition ends Faulty");
    assert(notifs(store, "Resolution").length === 0, "18 no Resolution mid-transition");
  }

  console.log("== 19/20. Night Normal recovery ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.8, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store).length === 0, "19 fresh NIGHT NORMAL resolves Power");
    assert(store.streetlight["1"].status === "Active", "42 recovery with no other pending -> Active");
    const res = notifs(store, "Resolution");
    assert(res.length === 2, "19 ONE Resolution fan-out per Active user (2)");
    assert(res.every((n) => n.fault_id === "f501" && n.status === "Unread"), "19 resolution tied to f501");
    await worker.runOnce(NOW); // steady normal
    assert(notifs(store, "Resolution").length === 2, "39 steady -> no duplicate Resolution");
    assert(notifs(store, "Fault Alert").length === 2, "39 steady -> no new alerts");
  }
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.2, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.9, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store).length === 0 && store.streetlight["1"].status === "Active",
      "20 Bulb -> Night Normal resolves + Active");
    assert(notifs(store, "Resolution").length === 2, "20 single Resolution fan-out");
  }

  console.log("== 21. fault + DAYLIGHT stays Pending ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    setReading(store, "1", { ambient_light: 0, voltage: 12.0, current: 0.0, tsMs: NOW - 2000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Power Fault").length === 1, "21 pending Power NOT resolved by Daylight");
    assert(store.streetlight["1"].status === "Faulty", "21 still Faulty under Daylight");
    assert(notifs(store, "Resolution").length === 0, "21 no resolution fan-out at daylight");
  }

  console.log("== 22/44/45. legacy Pending adoption + consolidated recovery ==");
  {
    const store = freshStore();
    store.fault_report = {
      f701: { fault_id: "f701", streetlight_id: "1", reading_id: null, fault_type: "Power Fault",
        description: "legacy", severity: "High", status: "Pending", detected_at: iso(NOW - 60000), resolved_at: null }
    };
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    assert(Object.keys(store.fault_report).length === 1, "44 existing Pending Power ADOPTED (no duplicate)");
    assert(store.backend_state.fault.nodes["1"].hw.adopted === true, "44 adoption recorded in backend_state");
    assert(notifs(store).length === 0, "44 adoption sends no new notifications");
  }
  {
    const store = freshStore();
    const mk = (id, ts) => ({ fault_id: id, streetlight_id: "1", reading_id: null, fault_type: "Bulb Fault",
      description: "legacy", severity: "Medium", status: "Pending", detected_at: ts, resolved_at: null });
    store.fault_report = { f601: mk("f601", iso(NOW - 60000)), f602: mk("f602", iso(NOW - 30000)) };
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.2, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(Object.keys(store.fault_report).length === 2, "22/45 duplicate Pending Bulbs adopted â€” no third copy");
    assert(store.backend_state.fault.nodes["1"].hw.adopted === true, "45 adoption recorded");
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.8, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(faultsOf(store, "Bulb Fault").every((f) => f.status === "Resolved"), "22 both duplicates resolved");
    assert(notifs(store, "Resolution").length === 2, "22 ONE consolidated Resolution fan-out (not 4)");
    assert(store.streetlight["1"].status === "Active", "22 duplicate recovery -> Active");
  }

  console.log("== 23/47. unprovisioned node (no last_seen, no readings) ==");
  {
    const store = freshStore();
    store.streetlight["5"] = { streetlight_id: 5, node_id: "LG-05", pole_number: "P-005",
      barangay: "Guadalupe", location: "New", latitude: 10.3, longitude: 123.8,
      installation_date: "2026-10-15", status: "Offline" }; // never heartbeated
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Node Offline").length === 0, "23 no Node Offline fault for never-heartbeated node");
    assert(pendingOf(store).length === 0, "47 no fault of ANY type for Node 5");
    assert(notifs(store).length === 0, "47 no notifications for Node 5");
    assert(store.streetlight["5"].status === "Offline", "23/47 status remains Offline");
    assert(store.sensor_reading === undefined, "47 no telemetry fabricated for Node 5");
  }

  console.log("== 24/25. heartbeat timeout = one Node Offline ==");
  {
    const store = freshStore();
    store.streetlight["1"].last_seen = iso(NOW - 11 * 60000); // > 10 min
    await worker.runOnce(NOW);
    const off = pendingOf(store, "Node Offline");
    assert(off.length === 1, "24 one Pending Node Offline after timeout");
    assert(store.streetlight["1"].status === "Offline", "41 timeout => status Offline");
    assert(notifs(store, "Fault Alert").length === 2, "24 Fault Alert fan-out per Active user");
    await worker.runOnce(NOW);
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Node Offline").length === 1, "25 repeated timeout -> NO duplicate");
    assert(notifs(store, "Fault Alert").length === 2, "25 no duplicate offline alerts");
    assert(Object.keys(store.fault_report || {}).length === 1, "25 single fault record total");
  }

  console.log("== 26. heartbeat recovery ==");
  {
    const store = freshStore();
    store.streetlight["1"].last_seen = iso(NOW - 11 * 60000);
    await worker.runOnce(NOW);
    store.streetlight["1"].last_seen = iso(NOW - 5000); // heartbeat back
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Node Offline").length === 0, "26 Node Offline resolved on heartbeat");
    assert(faultsOf(store, "Node Offline")[0].status === "Resolved", "26 offline record Resolved");
    assert(store.streetlight["1"].status === "Active", "42 offline recovery, no other pending -> Active");
    const res = notifs(store, "Resolution");
    assert(res.length === 2 && res[0].message.indexOf("back online") > 0, "26 Resolution fan-out with heartbeat wording");
  }

  console.log("== 27. offline -> reconnect with hardware fault ==");
  {
    const store = freshStore();
    store.streetlight["1"].last_seen = iso(NOW - 11 * 60000);
    await worker.runOnce(NOW); // Node Offline created
    store.streetlight["1"].last_seen = iso(NOW - 5000);
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.1, tsMs: NOW - 2000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Node Offline").length === 0, "27 offline resolved after reconnect");
    assert(pendingOf(store, "Bulb Fault").length === 1, "27 hardware Bulb fault created after reconnect");
    assert(store.streetlight["1"].status === "Faulty", "43 recovery with another pending -> Faulty");
    assert(notifs(store, "Resolution").length === 0, "27 no Resolution while hardware fault pending");
    assert(notifs(store, "Fault Alert").length === 4, "27 offline alert + bulb alert (2 + 2)");
  }

  console.log("== 28. stale heartbeat never becomes Power/Bulb ==");
  {
    const store = freshStore();
    store.streetlight["1"].last_seen = iso(NOW - 11 * 60000);
    setReading(store, "1", { ambient_light: 1, voltage: 2.0, current: 0.05, tsMs: NOW - 2000 });
    await worker.runOnce(NOW);
    assert(pendingOf(store, "Node Offline").length === 1, "28 offline created on stale heartbeat");
    assert(pendingOf(store, "Power Fault").length === 0 && pendingOf(store, "Bulb Fault").length === 0,
      "28 stale heartbeat does NOT become Power/Bulb");
    assert(store.streetlight["1"].status === "Offline", "28 status Offline (not Faulty)");
  }

  console.log("== 29/30. two workers, same condition = exactly one fault ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await Promise.all([worker.runOnce(NOW), worker.runOnce(NOW)]);
    assert(pendingOf(store, "Power Fault").length === 1, "29 two workers -> ONE Power fault episode");
    assert(Object.keys(store.fault_report || {}).length === 1, "29 single fault record");
    assert(notifs(store, "Fault Alert").length === 2, "29 notification fan-out NOT duplicated");
  }
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.1 });
    await Promise.all([worker.runOnce(NOW), worker.runOnce(NOW)]);
    assert(pendingOf(store, "Bulb Fault").length === 1, "30 two workers -> ONE Bulb fault episode");
    assert(notifs(store, "Fault Alert").length === 2, "30 notification fan-out NOT duplicated");
  }

  console.log("== 31/32. crash after claim, before fault write ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    const db = global.__FAKE_DB__;
    db._arm((p) => p.indexOf("fault_report/") === 0);
    const r1 = await worker.runOnce(NOW);
    assert(r1[0] && r1[0].error, "31 pass crashes as injected");
    db._disarm();
    assert(!store.fault_report, "31 NO fault written before crash");
    const hw = store.backend_state.fault.nodes["1"].hw;
    assert(hw.phase === "pending" && hw.event_key, "31 claim persisted as pending");
    const ev = store.backend_state.fault.events[hw.event_key];
    assert(ev && ev.status === "pending", "31 event recoverable");
    assert(ev.fault_record.fault_id === "f501" && store.counter.fault === 501,
      "32 fault id allocated INSIDE the claim and persisted");
    assert(store.notification === undefined && store.counter.notification === 2,
      "32 notification ids pre-allocated but nothing written yet");
    const r2 = await worker.runOnce(NOW);
    assert(!r2[0].error, "32 restart pass succeeds");
    assert(pendingOf(store, "Power Fault").length === 1 &&
      pendingOf(store, "Power Fault")[0].fault_id === "f501",
      "32 resume completed with the SAME fault id (no re-allocation)");
    assert(store.counter.fault === 501, "32 fault counter NOT advanced on retry");
    assert(store.backend_state.fault.events[hw.event_key].status === "applied", "32 event finalized after resume");
    assert(notifs(store, "Fault Alert").length === 2 && store.counter.notification === 2,
      "32 notifications written exactly once (2 ids, 1 fan-out)");
    assert(store.streetlight["1"].status === "Faulty", "32 status Faulty after resume");
  }

  console.log("== 33. crash after fault write, before notifications ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    const db = global.__FAKE_DB__;
    db._arm((p) => p.indexOf("notification/") === 0);
    const r1 = await worker.runOnce(NOW);
    assert(r1[0] && r1[0].error, "33 pass crashes at first notification write");
    db._disarm();
    assert(pendingOf(store, "Power Fault").length === 1, "33 fault WAS persisted before crash");
    assert(store.notification === undefined, "33 notifications missing after crash (bad scenario)");
    const hw = store.backend_state.fault.nodes["1"].hw;
    assert(hw.phase === "pending", "33 event still pending -> recoverable");
    const r2 = await worker.runOnce(NOW);
    assert(!r2[0].error, "33 restart completes the event");
    assert(notifs(store, "Fault Alert").length === 2, "33 notifications created on resume (not lost forever)");
    assert(store.counter.notification === 2, "33 ids NOT re-allocated on retry (no duplicates)");
    assert(store.backend_state.fault.events[hw.event_key].status === "applied", "33 event applied after resume");
    assert(pendingOf(store, "Power Fault").length === 1, "33 fault NOT duplicated by resume");
  }

  console.log("== 34. crash during resolution fan-out ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW); // power created
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.8, tsMs: NOW - 3000 });
    const db = global.__FAKE_DB__;
    db._arm((p) => p.indexOf("notification/") === 0);
    const r1 = await worker.runOnce(NOW);
    assert(r1[0] && r1[0].error, "34 pass crashes during resolution fan-out");
    db._disarm();
    assert(faultsOf(store, "Power Fault")[0].status === "Resolved", "34 fault resolved before crash");
    assert(notifs(store, "Resolution").length === 0, "34 resolution notifications not yet written");
    const hw = store.backend_state.fault.nodes["1"].hw;
    assert(hw.phase === "pending" && hw.state === "NORMAL", "34 resolution event pending -> recoverable");
    const resolvedAt = faultsOf(store, "Power Fault")[0].resolved_at;
    const r2 = await worker.runOnce(NOW);
    assert(!r2[0].error, "34 restart completes resolution");
    assert(notifs(store, "Resolution").length === 2, "34 resolution fan-out completed exactly once");
    assert(store.counter.notification === 4, "34 total ids = 2 alerts + 2 resolutions (no extra)");
    assert(faultsOf(store, "Power Fault")[0].resolved_at === resolvedAt, "34 resolved_at stable across resume");
    assert(store.streetlight["1"].status === "Active", "34 final status Active after completed resolution");
    await worker.runOnce(NOW);
    assert(notifs(store, "Resolution").length === 2, "35 applied-event replay = no dup resolution");
  }

  console.log("== 35. applied event replay = no-op ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 2.5, current: 0.3 });
    await worker.runOnce(NOW);
    const snap = () => JSON.stringify({ f: store.fault_report, n: store.notification, c: store.counter });
    const before = snap();
    await worker.runOnce(NOW); // same condition
    assert(snap() === before, "35 steady-state pass changes nothing");
    const hw = store.backend_state.fault.nodes["1"].hw;
    const ev = store.backend_state.fault.events[hw.event_key];
    const res = await worker.applyEvent(hw.event_key, JSON.parse(JSON.stringify(ev)));
    assert(res.replay === true, "35 direct replay of applied event short-circuits");
    assert(snap() === before, "35 replay wrote nothing");
  }

  console.log("== 46. healthy startup creates nothing ==");
  {
    const store = freshStore();
    setReading(store, "1", { ambient_light: 1, voltage: 12.0, current: 0.8, tsMs: NOW - 3000 });
    await worker.runOnce(NOW);
    assert(store.fault_report === undefined, "46 no fault records created");
    assert(store.notification === undefined, "46 no notifications created");
    assert(store.streetlight["1"].status === "Active", "46 status remains Active");
  }

  console.log("== 48-51. browser cutover + manual-resolve policy (source) ==");
  {
    const read = (p) => fs.readFileSync(path.join(root, "js", p), "utf8");
    const dash = read("dashboard.js");
    const fr = read("fault-records.js");
    const maint = read("maintenance.js");
    const ds = read("data-service.js");

    assert(!/evaluateHardwareFaults|classifyHardwareState|isHardwareTelemetryFresh|hwMutationLock/.test(dash),
      "17 dashboard evaluator + mutation loop fully removed (no dormant writes)");
    assert(!/HARDWARE_FAULT_TYPES|HARDWARE_VOLTAGE_FAULT_THRESHOLD|HARDWARE_CURRENT_FAULT_THRESHOLD/.test(dash),
      "17 browser hardware constants removed (logic lives in backend fault-service)");
    assert(dash.indexOf("await evaluateHardwareFaults()") === -1,
      "17 safeRefresh no longer calls the evaluator");

    assert(ds.includes('const AUTOMATIC_FAULT_TYPES = ["Power Fault", "Bulb Fault", "Node Offline"]'),
      "51 automatic fault_type ownership list in data-service (UI policy, not classification)");
    assert(ds.includes("function isAutomaticFaultType("),
      "51 isAutomaticFaultType helper exported for UI");
    assert(ds.includes("isAutomaticFaultType(linked.fault_type)"),
      "51 maintenance Completed no longer auto-resolves automatic faults");

    assert(fr.includes("DataService.isAutomaticFaultType(r.fault_type)") &&
      fr.includes("Automatic fault â€” resolves when telemetry confirms recovery."),
      "48/49/50 fault-records: automatic Resolve replaced by recovery wording");
    assert(fr.includes("onclick=\"resolveFaultRecord("),
      "51 manual/non-automatic Resolve button still present");

    assert(dash.includes("isAutomaticFaultType(latestFault.fault_type)") &&
      dash.includes("Automatic fault â€” resolves when telemetry confirms recovery."),
      "48 dashboard banner Resolve guarded for automatic faults");
    assert(dash.includes("isAutomaticFaultType(fault.fault_type)"),
      "50 dashboard detail-view resolve guarded for automatic faults");

    assert(maint.includes("isAutomaticFaultType(faultType)") &&
      maint.includes("Acknowledge (Auto Fault)"),
      "50 maintenance: automatic faults acknowledged WITHOUT resolving");
    assert(maint.includes("if (!automatic)"),
      "51 maintenance manual resolution path intact for non-automatic faults");
  }

  console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
  if (fails.length) {
    fails.forEach((f) => console.log("  FAILED: " + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});






