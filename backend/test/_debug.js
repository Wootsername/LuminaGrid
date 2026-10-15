// Temporary debug repro (delete after investigation)
const path = require("path");
const Module = require("module");

let pass = 0;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

// Reuse the harness stub by extracting from the test file? Simpler: minimal inline copy.
function makeDb(store) {
  const locks = {};
  const withLock = (p, fn) => { locks[p] = (locks[p] || Promise.resolve()).then(fn, fn); return locks[p]; };
  const getPath = (p) => String(p == null ? "" : p).split("/").filter(Boolean);
  const readNode = (p) => { let cur = store; for (const k of getPath(p)) { if (cur == null || typeof cur !== "object") return null; cur = cur[k]; } return cur === undefined ? null : cur; };
  const writeNode = (p, val) => {
    const parts = getPath(p);
    if (parts.length === 0) { for (const k of Object.keys(store)) delete store[k]; if (val && typeof val === "object") Object.assign(store, val); return; }
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) { const k = parts[i]; if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {}; cur = cur[k]; }
    cur[parts[parts.length - 1]] = val;
  };
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    ref(p) {
      const refPath = p == null ? "" : String(p);
      return {
        orderByKey() { return { limitToLast(n) { return { async once() { const v = readNode(refPath); const keys = v && typeof v === "object" ? Object.keys(v).sort() : []; const out = {}; keys.slice(-n).forEach((k) => { out[k] = v[k]; }); return { val: () => clone(out), exists: () => keys.length > 0 }; } }; } }; },
        async once() { const v = readNode(refPath); return { val: () => clone(v), exists: () => v !== null }; },
        async set(v) { return withLock(refPath, async () => { writeNode(refPath, clone(v)); }); },
        async update(v) { return withLock(refPath, async () => { const cur = readNode(refPath); const base = cur && typeof cur === "object" ? cur : {}; writeNode(refPath, Object.assign({}, clone(base), clone(v))); }); },
        async transaction(updater) {
          return withLock(refPath, () => {
            const cur = readNode(refPath);
            const next = updater(cur == null ? null : clone(cur));
            if (next === undefined) return { committed: false, snapshot: { val: () => clone(readNode(refPath)) } };
            writeNode(refPath, next);
            return { committed: true, snapshot: { val: () => clone(readNode(refPath)) } };
          });
        }
      };
    },
    _store: store
  };
}

const store = {
  streetlight: { "1": { streetlight_id: 1, node_id: "LG-01", pole_number: "P-001", status: "Active", last_seen: iso(NOW - 5000) } },
  system_config: { heartbeat_timeout_minutes: 10 },
  user: { u001: { user_id: "u001", status: "Active" }, u002: { user_id: "u002", status: "Active" } }
};
const proxy = { ref(...a) { return global.__D__.ref(...a); } };
const orig = Module._load;
Module._load = function (r, p, m) { if (r === "./firebase-admin") return { db: proxy }; return orig.call(this, r, p, m); };
const w = require(path.join(__dirname, "..", "fault-worker.js"));
global.__D__ = makeDb(store);

(async () => {
  store.sensor_reading = { "1": { rk1: { reading_id: "rk1", streetlight_id: 1, ambient_light: 1, voltage: 2.5, current: 0.3, timestamp: iso(NOW - 5000) } } };
  const r1 = await w.runOnce(NOW);
  console.log("PASS1", JSON.stringify(r1));
  console.log("hw1", JSON.stringify(store.backend_state.fault.nodes["1"]));

  store.sensor_reading["1"].rk2 = { reading_id: "rk2", streetlight_id: 1, ambient_light: 1, voltage: 12.0, current: 0.8, timestamp: iso(NOW - 4000) };
  const r2 = await w.runOnce(NOW);
  console.log("PASS2", JSON.stringify(r2));
  console.log("faults", JSON.stringify(store.fault_report));
  console.log("hw2", JSON.stringify(store.backend_state.fault.nodes["1"]));
  console.log("status", store.streetlight["1"].status, "notifs", Object.keys(store.notification || {}).length);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
