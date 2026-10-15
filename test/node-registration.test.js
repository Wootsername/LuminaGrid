// ============================================================
// LuminaGrid — Admin Node Registration regression tests
// Run: node test/node-registration.test.js   (from repo root)
// ============================================================
// Part A exercises the pure helpers in js/node-registration.js (sid
// generation, validation, record shape).
// Part B loads the REAL js/data-service.js inside a vm context backed by an
// in-memory RTDB stub and registers LG-05 / P-005 against existing keys
// 1,2,3,4 — asserting exactly one streetlight/5 write, correct record
// content, rejected duplicates / invalid coordinates, no fabricated
// telemetry, and no side records (sensor_reading, energy, fault,
// device_authz).
// ============================================================
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

let pass = 0;
const fails = [];
function assert(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fails.push(label); console.log("  FAIL " + label); }
}

// ---------- In-memory RTDB stub with set-once tracking ----------
function makeDb(store) {
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
  const setCounts = {};
  return {
    ref(p) {
      return {
        async once() {
          const v = readNode(p);
          return {
            val: () => (v === null ? null : JSON.parse(JSON.stringify(v))),
            exists: () => v !== null
          };
        },
        async set(v) {
          setCounts[p] = (setCounts[p] || 0) + 1;
          writeNode(p, JSON.parse(JSON.stringify(v)));
        },
        async update(v) {
          const cur = readNode(p) || {};
          writeNode(p, { ...cur, ...JSON.parse(JSON.stringify(v)) });
        },
        async transaction(updater) {
          const cur = readNode(p);
          const next = updater(cur === null ? null : JSON.parse(JSON.stringify(cur)));
          if (next === undefined) return { committed: false };
          writeNode(p, JSON.parse(JSON.stringify(next)));
          return { committed: true };
        }
      };
    },
    _setCounts: setCounts
  };
}

const NodeRegistration = require(path.join(root, "js", "node-registration.js"));

(async () => {
  // ================= Part A: pure helpers =================

  console.log("== A. helpers ==");
  {
    // String ids (what getStreetlights() actually returns after enrichment)
    const rows = [
      { streetlight_id: "1" }, { streetlight_id: "2" },
      { streetlight_id: "3" }, { streetlight_id: "4" }
    ];
    assert(NodeRegistration.nextStreetlightId(rows) === 5, "keys 1..4 -> next sid 5");
    assert(
      NodeRegistration.nextStreetlightId([{ streetlight_id: 1 }, { streetlight_id: 2 }, { streetlight_id: 4 }]) === 5,
      "sparse keys 1,2,4 -> next sid 5 (never length+1)"
    );
    assert(NodeRegistration.nextStreetlightId([]) === 1, "no nodes -> sid 1");
    assert(
      NodeRegistration.nextStreetlightId([{ node_id: "x" }, { streetlight_id: "abc" }, null]) === 1,
      "non-numeric/missing ids ignored"
    );

    const dateKey = NodeRegistration.manilaDateKey();
    assert(/^\d{4}-\d{2}-\d{2}$/.test(dateKey), "manilaDateKey is YYYY-MM-DD (" + dateKey + ")");

    const baseInput = {
      node_id: "  LG-05 ", pole_number: " P-005 ", location: " Vicente Rama Ave. near Chapel ",
      latitude: " 10.30880 ", longitude: " 123.89010 "
    };
    const existing = [
      { node_id: "LG-01", pole_number: "P-001" },
      { node_id: "LG-02", pole_number: "P-002" },
      { node_id: "LG-03", pole_number: "P-003" },
      { node_id: "LG-04", pole_number: "P-004" }
    ];

    const ok = NodeRegistration.validateRegistration(baseInput, existing);
    assert(ok.ok === true, "valid LG-05 / P-005 input accepted");
    assert(ok.values.node_id === "LG-05" && ok.values.pole_number === "P-005", "values trimmed");
    assert(ok.values.location === "Vicente Rama Ave. near Chapel", "location trimmed");
    assert(typeof ok.values.latitude === "number" && typeof ok.values.longitude === "number", "lat/lng parsed to numbers");

    // Duplicate Node ID
    assert(
      NodeRegistration.validateRegistration(
        { ...baseInput, pole_number: "P-999", node_id: "lg-01" }, existing
      ).ok === false,
      "duplicate Node ID rejected (case-insensitive)"
    );
    // Duplicate Pole Number
    assert(
      NodeRegistration.validateRegistration(
        { ...baseInput, node_id: "LG-999", pole_number: "P-002" }, existing
      ).ok === false,
      "duplicate Pole Number rejected (case-insensitive)"
    );
    // Missing fields
    assert(
      NodeRegistration.validateRegistration(
        { ...baseInput, location: "   " }, existing
      ).ok === false,
      "missing Location rejected"
    );
    // Invalid latitude
    assert(
      NodeRegistration.validateRegistration({ ...baseInput, latitude: "91" }, existing).ok === false,
      "latitude 91 rejected (out of range)"
    );
    assert(
      NodeRegistration.validateRegistration({ ...baseInput, latitude: "abc" }, existing).ok === false,
      "latitude 'abc' rejected (not numeric)"
    );
    // Invalid longitude
    assert(
      NodeRegistration.validateRegistration({ ...baseInput, longitude: "-181" }, existing).ok === false,
      "longitude -181 rejected (out of range)"
    );
    assert(
      NodeRegistration.validateRegistration({ ...baseInput, longitude: "" }, existing).ok === false,
      "missing longitude rejected"
    );

    // Record shape (section 4 of the spec)
    const rec = NodeRegistration.buildStreetlightRecord(ok.values, 5, dateKey);
    assert(rec.streetlight_id === 5 && typeof rec.streetlight_id === "number", "record streetlight_id numeric 5");
    assert(rec.node_id === "LG-05" && rec.pole_number === "P-005", "record node_id / pole_number");
    assert(rec.barangay === "Guadalupe", "record barangay defaults to Guadalupe");
    assert(rec.location === "Vicente Rama Ave. near Chapel", "record location");
    assert(rec.latitude === 10.3088 && rec.longitude === 123.8901, "record lat/lng numeric");
    assert(rec.installation_date === dateKey, "record installation_date = Manila date");
    assert(rec.status === "Offline", "record initial status Offline");
    assert(!("last_seen" in rec), "record has NO last_seen");
  }

  // ================= Part B: real data-service + stub RTDB =================

  console.log("== B. registration against real data-service.js ==");

  const store = {};
  // Existing keys 1..4 (fresh heartbeats -> Active, like live records).
  const nowIso = new Date().toISOString();
  store.streetlight = {
    "1": { streetlight_id: 1, node_id: "LG-01", pole_number: "P-001", barangay: "Guadalupe", location: "Ramon Duterte St", latitude: 10.3101, longitude: 123.8845, installation_date: "2026-06-01", status: "Active", last_seen: nowIso },
    "2": { streetlight_id: 2, node_id: "LG-02", pole_number: "P-002", barangay: "Guadalupe", location: "Vicente Rama Ave", latitude: 10.3115, longitude: 123.8862, installation_date: "2026-06-01", status: "Active", last_seen: nowIso },
    "3": { streetlight_id: 3, node_id: "LG-03", pole_number: "P-003", barangay: "Guadalupe", location: "Golden Success", latitude: 10.3130, longitude: 123.8875, installation_date: "2026-06-01", status: "Active", last_seen: nowIso },
    "4": { streetlight_id: 4, node_id: "LG-04", pole_number: "P-004", barangay: "Guadalupe", location: "Chapel side", latitude: 10.3142, longitude: 123.8890, installation_date: "2026-06-01", status: "Active", last_seen: nowIso }
  };
  const snapshotBefore = JSON.parse(JSON.stringify(store.streetlight));

  const db = makeDb(store);
  const context = {
    console,
    db,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  const dsSrc = fs.readFileSync(path.join(root, "js", "data-service.js"), "utf8");
  vm.runInContext(dsSrc, context, { filename: "data-service.js" });
  // Top-level `const DataService = ...` lives in the context's lexical scope,
  // not on the context object — retrieve it with a follow-up script.
  const DataService = vm.runInContext("DataService", context);

  // -- Happy path: register LG-05 / P-005 exactly like the form handler --
  const existingNodes = await DataService.getStreetlights();
  assert(existingNodes.length === 4, "Dashboard receives 4 streetlights before registration");

  const check = NodeRegistration.validateRegistration(
    {
      node_id: "LG-05", pole_number: "P-005",
      location: "Vicente Rama Ave. near Chapel",
      latitude: "10.30880", longitude: "123.89010"
    },
    existingNodes
  );
  assert(check.ok === true, "form input for LG-05 / P-005 validates");

  const sid = NodeRegistration.nextStreetlightId(existingNodes);
  assert(sid === 5, "next sid from live data = 5");

  const record = NodeRegistration.buildStreetlightRecord(check.values, sid, NodeRegistration.manilaDateKey());
  await DataService.upsertStreetlight(record);

  assert(db._setCounts["streetlight/5"] === 1, "streetlight/5 created exactly once");
  const totalSets = Object.values(db._setCounts).reduce((s, n) => s + n, 0);
  assert(totalSets === 1, "exactly ONE Firebase write in the whole registration (got " + totalSets + ")");

  const created = store.streetlight["5"];
  assert(!!created, "Firebase path streetlight/5 exists");
  assert(created.streetlight_id === 5 && typeof created.streetlight_id === "number", "streetlight_id = numeric 5");
  assert(created.status === "Offline", "stored status = Offline");
  assert(typeof created.latitude === "number" && typeof created.longitude === "number", "stored lat/lng numeric");
  assert(created.latitude === 10.3088 && created.longitude === 123.8901, "stored lat/lng = supplied coordinates");
  assert(created.node_id === "LG-05" && created.pole_number === "P-005", "stored node_id / pole_number");
  assert(created.barangay === "Guadalupe", "stored barangay Guadalupe");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(created.installation_date), "stored installation_date YYYY-MM-DD");
  assert(!("last_seen" in created), "no last_seen written");

  // -- No side effects anywhere else in the database --
  assert(store.sensor_reading === undefined, "no sensor_reading/5 (no fake telemetry node)");
  assert(store.energy_monthly === undefined, "no energy data created");
  assert(store.fault_report === undefined, "no fault record created");
  assert(store.device_authz === undefined, "no device_authz record created");
  assert(store.energy_data === undefined && store.backend_state === undefined, "no energy aggregates / backend state");
  const unchanged = JSON.stringify(store.streetlight["1"]) === JSON.stringify(snapshotBefore["1"])
    && JSON.stringify(store.streetlight["2"]) === JSON.stringify(snapshotBefore["2"])
    && JSON.stringify(store.streetlight["3"]) === JSON.stringify(snapshotBefore["3"])
    && JSON.stringify(store.streetlight["4"]) === JSON.stringify(snapshotBefore["4"]);
  assert(unchanged, "existing nodes 1-4 untouched");

  // -- Duplicate submission of the SAME data is rejected by validation --
  const again = await DataService.getStreetlights();
  const dupCheck = NodeRegistration.validateRegistration(
    { node_id: "LG-05", pole_number: "P-005", location: "x", latitude: "10.3", longitude: "123.8" },
    again
  );
  assert(dupCheck.ok === false && dupCheck.errors.length >= 2, "re-submitting LG-05 + P-005 rejected (both duplicates)");
  assert(db._setCounts["streetlight/5"] === 1, "rejected duplicate performs NO additional write");

  // -- Dashboard / map integration --
  const after = await DataService.getStreetlights();
  assert(after.length === 5, "Dashboard receives 5 streetlights after registration");

  const n5 = after.find((n) => String(n.streetlight_id) === "5");
  assert(!!n5, "node 5 present in getStreetlights() output");
  assert(n5.status === "Offline", "enriched status stays Offline (never counted as Working)");
  assert(isFinite(Number(n5.latitude)) && isFinite(Number(n5.longitude)), "map marker input coords numeric -> L.marker([lat, lng])");

  // Dashboard counter semantics (same counting as dashboard.js renderNodes)
  let active = 0, faulty = 0, offline = 0;
  for (const n of after) {
    if (n.status === "Active") active++;
    else if (n.status === "Faulty") faulty++;
    else if (n.status === "Offline") offline++;
  }
  assert(after.length === 5 && active === 4 && offline === 1 && faulty === 0,
    "counters: Total 5 / Working 4 (unchanged) / Faulty 0 / Offline +1");

  // -- No fabricated telemetry for the new node --
  const latest = await DataService.getLatestReading("5");
  assert(latest === null, "getLatestReading(5) = null -> details show em-dash (not fake numbers)");
  const allReadings = await DataService.getAllReadings();
  assert(Array.isArray(allReadings) && allReadings.length === 0, "no sensor readings exist anywhere in the stub");
  const plain5 = (await db.ref("streetlight/5").once("value")).val();
  assert(plain5 && plain5.status === "Offline", "raw Firebase record readable and Offline");

  console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
  if (fails.length) {
    fails.forEach((f) => console.log("  FAILED: " + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});


