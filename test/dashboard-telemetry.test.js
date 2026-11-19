// Run: node --test test/dashboard-telemetry.test.js
// Real browser scripts with an in-memory query/DOM/Leaflet harness. No network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = name => fs.readFileSync(path.join(__dirname, "../js", name + ".js"), "utf8");
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const NOW = Date.parse("2026-10-22T15:15:15Z");
const CURRENT = {
  timestamp: "2026-10-22T15:15:14Z", streetlight_id: 1,
  voltage: 11.08, current: 1.273, power_consumption: 14.1,
  ambient_light: 1, light_status: "ON"
};
const LEGACY = {
  timestamp: "uptime-41992", voltage: 0, current: 0.07,
  power_consumption: 0, ambient_light: 0, light_status: "OFF"
};
function setup(history = { oldLegacy: LEGACY, current: CURRENT }, applyQuery = true) {
  const store = {
    sensor_reading: { 1: clone(history) },
    streetlight: { 1: { streetlight_id: 1, pole_number: "P-001", status: "Faulty",
      last_seen: "2026-10-22T15:15:14Z", latitude: 10.32, longitude: 123.88 } },
    system_config: { heartbeat_timeout_minutes: 10 },
    fault_report: {}
  };
  const queries = [], writes = [], listeners = [], intervals = [], errors = [], logs = [];
  const db = { ref(p) {
    const query = { path: p, calls: [] };
    const ref = {
      orderByChild(v) { query.order = v; query.calls.push(["orderByChild", v]); return ref; },
      startAt(v) { query.min = v; query.calls.push(["startAt", v]); return ref; },
      endAt(v) { query.max = v; query.calls.push(["endAt", v]); return ref; },
      limitToLast(v) { query.limit = v; query.calls.push(["limitToLast", v]); return ref; },
      async once(event) {
        query.calls.push(["once", event]); queries.push(query);
        let value = clone(p.split("/").reduce((v, key) => v?.[key], store));
        if (query.order && applyQuery) {
          const entries = Object.entries(value || {}).filter(([, r]) =>
            typeof r?.[query.order] === "string" &&
            r[query.order] >= query.min && r[query.order] <= query.max);
          entries.sort(([ka, a], [kb, b]) => {
            const av = a[query.order], bv = b[query.order];
            return av < bv ? -1 : av > bv ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0;
          });
          value = Object.fromEntries(entries.slice(-query.limit));
        }
        return { val: () => value, exists: () => value !== null };
      },
      on() { listeners.push(p); throw new Error("Unexpected Firebase listener"); },
      set() { writes.push(p); throw new Error("Unexpected write"); },
      update() { writes.push(p); throw new Error("Unexpected write"); },
      transaction() { writes.push(p); throw new Error("Unexpected write"); }
    };
    return ref;
  } };
  const html = fs.readFileSync(path.join(__dirname, "../dashboard.html"), "utf8");
  const elements = {};
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    let text = "", markup = "";
    const classes = new Set();
    elements[id] = {
      style: {}, className: "", disabled: false,
      classList: { add(...v) { v.forEach(x => classes.add(x)); },
        remove(...v) { v.forEach(x => classes.delete(x)); }, contains(v) { return classes.has(v); } },
      addEventListener() {},
      set textContent(v) { text = String(v); markup = text; }, get textContent() { return text; },
      set innerHTML(v) { markup = String(v); text = markup.replace(/<[^>]*>/g, ""); },
      get innerHTML() { return markup; }
    };
  }
  const map = { setView() { return this; }, fitBounds() {}, flyTo() {} };
  const markerList = [];
  const L = {
    map: () => map, tileLayer: () => ({ addTo() {} }), divIcon: v => v,
    latLngBounds: () => ({ pad() { return this; } }),
    marker(coords, options) {
      const marker = {
        coords, icon: options.icon, iconChanges: 0, callbacks: {},
        addTo() { return this; }, bindPopup(html) { this.popup = html; return this; },
        on(event, callback) { this.callbacks[event] = callback; return this; },
        setIcon(icon) { this.icon = icon; this.iconChanges++; },
        setPopupContent(html) { this.popup = html; }, openPopup() {}, remove() { this.removed = true; }
      };
      markerList.push(marker); return marker;
    }
  };
  const clock = { now: NOW };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    db, L, Date: FixedDate, window: {},
    document: { getElementById(id) {
      assert.ok(elements[id], "Dashboard HTML must contain " + id);
      return elements[id];
    } },
    console: { ...console, log(...args) { logs.push(args); }, error(...args) { errors.push(args); } },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }
  });
  vm.runInContext(source("utils"), context);
  vm.runInContext('requireRole = () => "admin"; paintUserChip = wireLogout = gateNavByRole = () => {};', context);
  vm.runInContext(source("telemetry-time"), context);
  vm.runInContext(source("data-service") + "\nglobalThis.DataService = DataService;", context);
  return { store, queries, writes, listeners, intervals, errors, logs, elements, markerList, clock,
    context, service: context.DataService,
    async dashboard() { await vm.runInContext(source("dashboard"), context); assert.deepEqual(errors, []); },
    async detail() { await context.showNodeDetail("1"); assert.deepEqual(errors, []); }
  };
}
test("legacy coordinates leave the dashboard usable and a later valid location can be mapped", async () => {
  const f = setup();
  f.store.streetlight[1].latitude = null;
  f.store.streetlight[1].longitude = "";
  f.store.streetlight[2] = { streetlight_id: 2, pole_number: "P-002", latitude: "10.35", longitude: "123.90" };
  await f.dashboard();
  await f.detail();
  assert.equal(f.elements.kpiTotal.textContent, "2");
  assert.equal(f.elements.detailCoords.textContent, "—");
  assert.equal(f.elements.locateOnMapBtn.disabled, true);
  assert.equal(f.markerList.length, 1);
  assert.deepEqual(clone(f.markerList[0].coords), [10.35, 123.9]);

  f.store.streetlight[1].latitude = 10.32;
  f.store.streetlight[1].longitude = 123.88;
  await f.context.refresh();
  assert.equal(f.elements.detailCoords.textContent, "10.32000, 123.88000");
  assert.equal(f.elements.locateOnMapBtn.disabled, false);
  assert.equal(f.markerList.length, 2);

  f.store.streetlight[1].latitude = 91;
  await f.context.refresh();
  assert.equal(f.markerList[1].removed, true);
  assert.equal(f.elements.detailCoords.textContent, "—");
  assert.deepEqual(f.errors, []);
});

test("node text is escaped in map popups and node cards", async () => {
  const f = setup();
  Object.assign(f.store.streetlight[1], { node_id: "Node & East", pole_number: "Pole < North", location: 'East < West & "Main"' });
  await f.dashboard();
  assert.match(f.markerList[0].popup, /Node &amp; East/);
  assert.match(f.markerList[0].popup, /East &lt; West &amp; &quot;Main&quot;/);
  assert.match(f.elements.nodeList.innerHTML, /Pole &lt; North/);
  assert.match(f.elements.nodeList.innerHTML, /East &lt; West &amp; &quot;Main&quot;/);
  assert.match(f.markerList[0].popup, /showNodeDetail\(&quot;1&quot;\)/);
});

test("mixed legacy/ISO history selects the complete current row without changing return shape", async () => {
  const f = setup();
  assert.deepEqual(clone(await f.service.getLatestReading(1)), CURRENT);
  assert.deepEqual(f.queries[0], {
    path: "sensor_reading/1", order: "timestamp",
    min: "2000-01-01T00:00:00.000Z", max: "9999-12-31T23:59:59Z", limit: 20,
    calls: [["orderByChild", "timestamp"], ["startAt", "2000-01-01T00:00:00.000Z"],
      ["endAt", "9999-12-31T23:59:59Z"], ["limitToLast", 20], ["once", "value"]]
  });
  assert.deepEqual(f.writes, []);
});
test("more than 20 legacy rows cannot crowd valid data out of the query", async () => {
  const rows = { current: CURRENT };
  for (let i = 0; i < 30; i++) rows["legacy" + i] = { ...LEGACY, timestamp: "uptime-" + (41992 + i) };
  assert.deepEqual(clone(await setup(rows).service.getLatestReading(1)), CURRENT);
});
test("selection uses chronological timestamps, independent of key/insertion order", async () => {
  const f = setup({
    aaa: CURRENT,
    zzz: { ...CURRENT, timestamp: "2026-10-22T15:10:14Z" },
    lastInserted: { ...CURRENT, timestamp: "2026-10-21T23:59:59.999Z" }
  });
  assert.deepEqual(clone(await f.service.getLatestReading(1)), CURRENT);
});
test("seconds and milliseconds are accepted and sorted by actual time within the same second", async () => {
  const newest = { ...CURRENT, timestamp: "2026-10-22T15:15:14.123Z" };
  const f = setup({ milliseconds: newest, seconds: CURRENT });
  assert.deepEqual(clone(await f.service.getLatestReading(1)), newest);
  assert.equal(f.service.parseTelemetryTimestamp(CURRENT.timestamp), Date.parse(CURRENT.timestamp));
});
const invalidTimestamps = [
  undefined, null, 1792682114000, "", "uptime-41992", "not a date", "2026",
  "2026-10-22T15:15:14+00:00", "2026-10-22T23:15:14+08:00",
  "2026-10-22T15:15:14", "2026-10-22T15:15:14.12Z",
  "2026-02-30T15:15:14Z", "2026-13-22T15:15:14Z", "2026-10-22T24:00:00Z",
  "2026-10-22T15:15:60Z", "2026-10-22T15:15:14Z\n"
];
for (const timestamp of invalidTimestamps) {
  test("rejects invalid telemetry timestamp: " + String(timestamp), async () => {
    // Bypass query filtering to verify the local selector also rejects it.
    const f = setup({ invalid: { ...LEGACY, timestamp }, valid: CURRENT }, false);
    assert.ok(Number.isNaN(f.service.parseTelemetryTimestamp(timestamp)));
    assert.deepEqual(clone(await f.service.getLatestReading(1)), CURRENT);
    delete f.store.sensor_reading[1].valid;
    assert.equal(await f.service.getLatestReading(1), null);
  });
}
test("empty, legacy-only, out-of-range and impossible-date histories return null", async () => {
  for (const history of [null, {}, { legacy: LEGACY },
    { row: { timestamp: "1999-12-31T23:59:59Z" } },
    { row: { timestamp: "2026-11-31T15:15:14Z" } }]) {
    assert.equal(await setup(history).service.getLatestReading(1), null);
  }
});
test("query boundaries and leap days validate; equal times use a stable key tie-break", async () => {
  for (const timestamp of ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00Z",
    "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59Z", "2024-02-29T00:00:00Z"]) {
    assert.equal((await setup({ row: { timestamp } }).service.getLatestReading(1)).timestamp, timestamp);
  }
  const expected = { ...CURRENT, reading_id: "winner" };
  const f = setup({ z: expected, a: { ...CURRENT, timestamp: "2026-10-22T15:15:14.000Z" } });
  assert.deepEqual(clone(await f.service.getLatestReading(1)), expected);
});
test("dashboard displays current telemetry and separates ONLINE connection from Faulty status", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  const e = f.elements;
  assert.equal(e.detailCurrent.textContent, "1.27");
  assert.equal(e.detailVoltage.textContent, "11");
  assert.equal(e.detailEnergy.textContent, "14.1");
  assert.equal(e.detailAmbient.textContent, "Night");
  assert.equal(e.detailLightStatus.textContent, "ON");
  assert.equal(e.detailConnection.textContent, "ONLINE");
  assert.equal(e.detailStatus.textContent, "● Faulty");
  assert.equal(e.detailLastUpdate.textContent, f.context.formatDateTime(CURRENT.timestamp));
  assert.doesNotMatch(e.detailLastUpdate.textContent, /Jan 1|Invalid Date/);
  assert.equal(e.kpiActive.textContent, "0");
  assert.equal(e.kpiFaults.textContent, "1");
  assert.match(f.markerList[0].icon.html, /#EF4444/);
  assert.deepEqual(f.writes, []);
});
test("light status is only ON/OFF and never inherited from operational status", async () => {
  for (const status of ["Active", "Faulty", "Offline"]) {
    for (const light_status of ["ON", "OFF", "OFFLINE", null, undefined]) {
      const f = setup({ row: { ...CURRENT, light_status } });
      f.store.streetlight[1].status = status;
      await f.dashboard(); await f.detail();
      assert.equal(f.elements.detailLightStatus.textContent,
        light_status === "ON" || light_status === "OFF" ? light_status : "—");
      assert.equal(f.elements.detailStatus.textContent, "● " + status);
      assert.equal(f.elements.detailConnection.textContent, "ONLINE");
      assert.deepEqual(f.writes, []);
    }
  }
});
test("stale/future telemetry without prior valid evidence shows no data", async () => {
  for (const timestamp of ["2026-10-22T15:13:44Z", "2026-10-22T15:15:31Z"]) {
    const f = setup({ only: { ...CURRENT, timestamp } });
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailLightStatus.textContent, "—");
    assert.equal(f.elements.detailLastUpdate.textContent, "—");
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  }
  const f = setup({ only: { ...CURRENT, timestamp: "2026-10-22T15:13:45Z" } });
  await f.dashboard(); await f.detail();
  assert.equal(f.elements.detailLightStatus.textContent, "ON");
});
test("invalid timestamps cannot replace expired telemetry or display an epoch fallback", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  f.clock.now = Date.parse(CURRENT.timestamp) + 90001;
  for (const timestamp of invalidTimestamps) {
    f.store.sensor_reading[1] = { bad: { ...CURRENT, timestamp } };
    await f.intervals[0].fn();
    for (const id of ["detailCurrent", "detailVoltage", "detailEnergy", "detailAmbient",
      "detailLightStatus", "detailLastUpdate"]) assert.equal(f.elements[id].textContent, "—", id);
    assert.equal(f.context.telemetryDateTime(timestamp), "—");
  }
  assert.deepEqual(f.errors, []);
});
test("initial heartbeat freshness respects the existing configured timeout", async () => {
  for (const [timestamp, expected] of [
    ["2026-10-22T15:13:15Z", "ONLINE"], ["2026-10-22T15:13:14Z", "OFFLINE"],
    ["2026-10-22T15:15:31Z", "OFFLINE"], ["uptime-41992", "OFFLINE"], [null, "OFFLINE"]
  ]) {
    const f = setup();
    f.store.system_config.heartbeat_timeout_minutes = 2;
    f.store.streetlight[1].last_seen = timestamp;
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailConnection.textContent, expected);
    assert.equal(f.elements.detailStatus.textContent, "● Faulty");
    assert.equal(f.elements.detailLightStatus.textContent, "ON");
    assert.deepEqual(f.writes, []);
  }
});
test("poll refreshes open details/popups, counters and markers from new data without listeners", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0].ms, 2000);
  const marker = f.markerList[0];
  for (const [status, active, faulty, offline, color] of [
    ["Active", "1", "0", "0", "#22C55E"],
    ["Offline", "0", "0", "1", "#9CA3B5"],
    ["Faulty", "0", "1", "0", "#EF4444"]
  ]) {
    f.store.streetlight[1].status = status;
    f.store.sensor_reading[1].newest = { ...CURRENT, timestamp: "2026-10-22T15:15:15Z",
      current: 2, voltage: 12, power_consumption: 24, ambient_light: 0, light_status: "OFF" };
    await f.intervals[0].fn();
    assert.equal(f.elements.detailCurrent.textContent, "2.00");
    assert.equal(f.elements.detailVoltage.textContent, "12");
    assert.equal(f.elements.detailEnergy.textContent, "24.0");
    assert.equal(f.elements.detailAmbient.textContent, "Daylight");
    assert.equal(f.elements.detailLightStatus.textContent, "OFF");
    assert.equal(f.elements.detailLastUpdate.textContent, f.context.formatDateTime("2026-10-22T15:15:15Z"));
    assert.match(marker.popup, /2\.00 A/);
    assert.equal(f.elements.kpiActive.textContent, active);
    assert.equal(f.elements.kpiFaults.textContent, faulty);
    assert.equal(f.elements.kpiOffline.textContent, offline);
    assert.ok(marker.icon.html.includes(color));
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  }
  const iconChanges = marker.iconChanges;
  await f.intervals[0].fn();
  assert.equal(marker.iconChanges, iconChanges);
  assert.equal(f.markerList.length, 1);
  assert.equal(f.intervals.length, 1);
  assert.deepEqual(f.listeners, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});
test("overlapping poll is skipped and a failed read does not disable future polling", async () => {
  const f = setup(); await f.dashboard();
  const original = f.service.getStreetlights;
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  f.service.getStreetlights = async () => { calls++; await blocked; return original(); };
  const first = f.intervals[0].fn();
  await f.intervals[0].fn();
  assert.equal(calls, 1);
  release(); await first;
  f.service.getStreetlights = original;
  const read = f.service.getLatestReadingEntry;
  f.service.getLatestReadingEntry = async () => { throw new Error("temporary read failure"); };
  await f.intervals[0].fn(); assert.equal(f.errors.length, 1);
  f.service.getLatestReadingEntry = read;
  await f.intervals[0].fn(); assert.equal(f.errors.length, 1);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.listeners, []);
});
test("valid timestamp with missing sensor fields renders safely and does not block polling", async () => {
  const f = setup({ row: { timestamp: CURRENT.timestamp } });
  await f.dashboard(); await f.detail(); await f.intervals[0].fn();
  for (const id of ["detailCurrent", "detailVoltage", "detailEnergy", "detailAmbient", "detailLightStatus"]) {
    assert.equal(f.elements[id].textContent, "—");
  }
  assert.deepEqual(f.errors, []);
});

for (const skew of [7000, 14000, 15000, 15001, 16000, 3600000, -30000]) {
  test("browser heartbeat and sensor clock skew: " + skew, async () => {
    const f = setup();
    const accepted = skew <= 15000;
    const timestamp = new Date(NOW + skew).toISOString();
    f.store.streetlight[1].last_seen = timestamp;
    f.store.sensor_reading[1] = { row: { ...CURRENT, timestamp, light_status: "OFF", voltage: 0 } };
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailConnection.textContent, accepted ? "ONLINE" : "OFFLINE");
    assert.equal(f.elements.detailLightStatus.textContent, accepted ? "OFF" : "—");
    assert.equal(f.elements.detailStatus.textContent, "● Faulty");
    assert.equal(f.elements.kpiFaults.textContent, "1");
    assert.match(f.markerList[0].icon.html, /#EF4444/);
    assert.equal(f.service.timestampAge(timestamp).rawAgeMs, -skew);
    assert.deepEqual(f.writes, []);
  });
}
test("five-second polls keep connection ONLINE through partial day-night-day updates", async () => {
  const f = setup();
  f.store.streetlight[1].status = "Active";
  f.store.streetlight[1].last_seen = new Date(NOW + 7000).toISOString();
  f.store.sensor_reading[1] = { row: { ...CURRENT, ambient_light: 0, light_status: "OFF" } };
  await f.dashboard(); await f.detail();
  for (const patch of [
    { timestamp: new Date(NOW + 14000).toISOString() },
    { ambient_light: 1 }, { light_status: "ON" }, { current: 1, voltage: 11 },
    { timestamp: new Date(NOW + 35000).toISOString() },
    { light_status: "OFF" }, { ambient_light: 0 }, { current: 0 }
  ]) {
    Object.assign(f.store.sensor_reading[1].row, patch);
    f.clock.now += 5000;
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
    assert.equal(f.elements.detailStatus.textContent, "● Active");
    assert.equal(f.elements.kpiActive.textContent, "1");
    assert.match(f.markerList[0].icon.html, /#22C55E/);
  }
  // Missing/stale/genuinely future sensor data cannot invalidate the heartbeat.
  for (const timestamp of [null, "uptime-41992",
    new Date(NOW - 120000).toISOString(), new Date(f.clock.now + 3600000).toISOString()]) {
    f.store.sensor_reading[1] = { row: { ...CURRENT, timestamp } };
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  }
  const seenMs = Date.parse(f.store.streetlight[1].last_seen);
  f.clock.now = seenMs + 600000;
  await f.intervals[0].fn(); assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  f.clock.now++;
  await f.intervals[0].fn(); assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
  // Connection expiry never synthesizes worker-owned operational status.
  assert.equal(f.elements.detailStatus.textContent, "● Active");
  assert.equal(f.intervals.length, 1); assert.deepEqual(f.listeners, []);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});
test("energy lamp freshness shares bounded skew without altering its 60-second window", () => {
  const f = setup();
  const energy = source("energy-data");
  vm.runInContext(energy.slice(energy.indexOf("const TELEMETRY_FRESH_MS"), energy.indexOf("function fmt(")), f.context);
  for (const [offset, expected] of [[7000, true], [14000, true], [15000, true], [15001, false],
    [16000, false], [3600000, false], [-60000, true], [-60001, false]]) {
    assert.equal(f.context.lampIsOn({ timestamp: new Date(NOW + offset).toISOString(), light_status: "ON" }), expected);
  }
  assert.equal(f.context.lampIsOn({ timestamp: "uptime-41992", light_status: "ON" }), false);
});
test("every browser DataService consumer loads the one shared timestamp policy first", () => {
  const root = path.join(__dirname, "..");
  for (const file of fs.readdirSync(root).filter(name => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    const service = html.indexOf('<script src="js/data-service.js"');
    if (service < 0) continue;
    const shared = html.indexOf('<script src="js/telemetry-time.js"');
    assert.ok(shared >= 0 && shared < service, file);
    assert.equal(html.match(/src="js\/telemetry-time.js"/g).length, 1, file);
  }
});

test("one poll reads each node/reading/config once and selection performs no reads", async () => {
  const f = setup(); await f.dashboard(); await f.detail(); f.queries.length = 0;
  await f.intervals[0].fn();
  for (const p of ["streetlight", "system_config", "fault_report", "sensor_reading/1"]) {
    assert.equal(f.queries.filter(q => q.path === p).length, 1, p);
  }
  assert.equal(f.queries.filter(q => q.path === "streetlight/1").length, 0);
  const count = f.queries.length;
  await f.context.showNodeDetail("1");
  assert.equal(f.queries.length, count);
});
test("transient null and future samples retain one coherent fresh reading and heartbeat", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  for (const candidate of [null, { ...CURRENT, reading_id: "future", timestamp: new Date(NOW + 20000).toISOString(),
    current: 9, power_consumption: 99, light_status: "OFF" }]) {
    f.store.sensor_reading[1] = candidate ? { future: candidate } : {};
    f.store.streetlight[1].last_seen = candidate ? candidate.timestamp : null;
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
    assert.equal(f.elements.detailLightStatus.textContent, "ON");
    assert.equal(f.elements.detailCurrent.textContent, "1.27");
    assert.equal(f.elements.detailEnergy.textContent, "14.1");
    assert.equal(f.elements.detailLastUpdate.textContent, f.context.formatDateTime(CURRENT.timestamp));
    assert.equal(f.elements.detailLastSeen.textContent, f.context.formatDateTime(CURRENT.timestamp));
  }
  assert.deepEqual(f.writes, []);
});
test("telemetry read failure retains data briefly but never beyond the sample freshness window", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  const method = f.service.getLatestReadingEntry ? "getLatestReadingEntry" : "getLatestReading";
  const original = f.service[method];
  f.service[method] = async () => { throw new Error("temporary sensor failure"); };
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  assert.equal(f.elements.detailLightStatus.textContent, "ON");
  f.clock.now = Date.parse(CURRENT.timestamp) + 90001;
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  assert.equal(f.elements.detailLightStatus.textContent, "—");
  assert.equal(f.elements.detailCurrent.textContent, "—");
  f.service[method] = original;
  f.store.sensor_reading[1].next = { ...CURRENT, timestamp: new Date(f.clock.now).toISOString(), current: 1.6 };
  await f.intervals[0].fn();
  assert.equal(f.elements.detailLightStatus.textContent, "ON");
  assert.equal(f.elements.detailCurrent.textContent, "1.60");
});
test("streetlight request failure retains valid connection only until the configured timeout", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  f.service.getStreetlights = async () => { throw new Error("temporary node failure"); };
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  f.clock.now = Date.parse(CURRENT.timestamp) + 600001;
  f.store.sensor_reading[1].next = { ...CURRENT, timestamp: new Date(f.clock.now).toISOString() };
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
  assert.equal(f.elements.detailLightStatus.textContent, "ON");
  assert.equal(f.elements.detailStatus.textContent, "● Faulty");
});
test("a late older refresh cannot overwrite a newer completed refresh or poison retained data", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  const original = f.service.getStreetlights;
  let release;
  const captured = await original();
  f.service.getStreetlights = () => new Promise(resolve => { release = () => resolve(captured); });
  const older = f.context.refresh();
  await Promise.resolve(); // let the old fetch capture its response before starting the newer poll
  f.service.getStreetlights = original;
  f.store.streetlight[1].status = "Active";
  f.store.sensor_reading[1].next = { ...CURRENT, timestamp: new Date(NOW).toISOString(), current: 2 };
  await f.context.refresh();
  release(); await older;
  assert.equal(f.elements.detailStatus.textContent, "● Active");
  assert.equal(f.elements.kpiActive.textContent, "1");
  assert.match(f.markerList[0].icon.html, /#22C55E/);
  assert.equal(f.elements.detailCurrent.textContent, "2.00");
});
test("100 two-second polls with five-second heartbeats have no false Offline transitions", async () => {
  const f = setup();
  f.store.system_config.heartbeat_timeout_minutes = 0.25;
  f.store.streetlight[1].status = "Active";
  await f.dashboard(); await f.detail();
  for (let i = 1; i <= 100; i++) {
    f.clock.now = NOW + i * 2000;
    const heartbeatMs = NOW + Math.floor((f.clock.now - NOW) / 5000) * 5000;
    f.store.streetlight[1].last_seen = i % 11 === 0 ? null : new Date(heartbeatMs).toISOString();
    const timestamp = new Date(f.clock.now).toISOString();
    f.store.sensor_reading[1] = i % 7 === 0 ? {} :
      { ["row" + i]: { ...CURRENT, timestamp, current: 1.5 + i / 100 } };
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent, "ONLINE", "poll " + i);
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Active", "poll " + i);
    assert.equal(f.elements.detailLightStatus.textContent, "ON", "poll " + i);
    if (i % 7 !== 0) {
      const view = vm.runInContext("nodeViews.get('1')", f.context);
      assert.equal(view.reading.timestamp, timestamp, "chronological two-second reading " + i);
    }
  }
  assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0].ms, 2000);
  assert.deepEqual(f.listeners, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});

test("opt-in diagnostics identify rejected input and the retained rendered reading", async () => {
  const f = setup(); f.context.window.LUMINAGRID_DEBUG = true;
  await f.dashboard(); await f.detail(); f.logs.length = 0;
  f.store.streetlight[1].last_seen = new Date(NOW + 20000).toISOString();
  f.store.sensor_reading[1] = { future: { ...CURRENT, timestamp: new Date(NOW + 20000).toISOString(),
    token: "SECRET_TOKEN", user: "SECRET_USER" } };
  await f.intervals[0].fn();
  assert.equal(f.logs.length, 1);
  const d = f.logs[0][1];
  assert.equal(d.heartbeat_reason, "future");
  assert.equal(d.sensor_reason, "future");
  assert.equal(d.heartbeat_raw_age_ms, -20000);
  assert.equal(d.selected_reading_id, "current");
  assert.equal(d.candidate_reading_id, "future");
  assert.equal(d.connection_decision, "ONLINE");
  assert.equal(d.rendered_connection, "ONLINE");
  assert.equal(d.rendered_light_status, "ON");
  assert.equal(d.reading_source, "retained");
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|token|user/);
  const quiet = setup(); await quiet.dashboard(); assert.deepEqual(quiet.logs, []);
});

test("day-night-day renders all telemetry fields and Last Update from one immutable reading", async () => {
  const f = setup(); f.store.streetlight[1].status = "Active";
  f.store.system_config.heartbeat_timeout_minutes = 0.25;
  await f.dashboard(); await f.detail();
  for (const [ambient_light, light_status, current] of [[0, "OFF", 0], [1, "ON", 1.6], [0, "OFF", 0]]) {
    f.clock.now += 2000;
    const timestamp = new Date(f.clock.now).toISOString();
    f.store.streetlight[1].last_seen = new Date(NOW + Math.floor((f.clock.now - NOW) / 5000) * 5000).toISOString();
    const key = "sample" + f.clock.now;
    f.store.sensor_reading[1] = { [key]: { ...CURRENT, timestamp, ambient_light, light_status,
      current, voltage: 11, power_consumption: current * 11 } };
    await f.intervals[0].fn();
    assert.equal(f.elements.detailCurrent.textContent, current.toFixed(2));
    assert.equal(f.elements.detailVoltage.textContent, "11");
    assert.equal(f.elements.detailEnergy.textContent, (current * 11).toFixed(1));
    assert.equal(f.elements.detailAmbient.textContent, ambient_light ? "Night" : "Daylight");
    assert.equal(f.elements.detailLightStatus.textContent, light_status);
    assert.equal(f.elements.detailLastUpdate.textContent, f.context.formatDateTime(timestamp));
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
    const view = vm.runInContext("nodeViews.get('1')", f.context);
    assert.equal(view.readingKey, key);
    assert.ok(Object.isFrozen(view) && Object.isFrozen(view.reading) &&
      Object.isFrozen(view.streetlight) && Object.isFrozen(view.timestampState));
  }
});
test("a still-pending network request cannot keep expired heartbeat or telemetry fresh", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  const original = f.service.getStreetlights;
  let release;
  const rows = await original();
  f.service.getStreetlights = () => new Promise(resolve => { release = () => resolve(rows); });
  const pending = f.intervals[0].fn();
  await Promise.resolve();
  f.clock.now = Date.parse(CURRENT.timestamp) + 600001;
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
  assert.equal(f.elements.detailLightStatus.textContent, "—");
  release(); await pending;
  assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
});
test("per-node evidence and user selection are isolated while a refresh is pending", async () => {
  const f = setup();
  f.store.streetlight[2] = { ...f.store.streetlight[1], streetlight_id: 2, pole_number: "P-002" };
  f.store.sensor_reading[2] = { off: { ...CURRENT, light_status: "OFF", current: 0, power_consumption: 0 } };
  await f.dashboard(); await f.detail();
  const original = f.service.getLatestReadingEntry;
  let release;
  f.service.getLatestReadingEntry = async sid => {
    const entry = await original(sid);
    if (String(sid) === "1") await new Promise(resolve => { release = resolve; });
    return entry;
  };
  const pending = f.intervals[0].fn();
  while (!release) await Promise.resolve();
  f.context.showNodeDetail("2");
  assert.equal(f.elements.detailLightStatus.textContent, "OFF");
  release(); await pending;
  assert.equal(f.elements.detailPoleNo.textContent, "P-002");
  assert.equal(f.elements.detailLightStatus.textContent, "OFF");
  assert.equal(f.elements.detailCurrent.textContent, "0.00");
});

test("late sensor response cannot replace newer displayed or retained telemetry", async () => {
  const f = setup(); await f.dashboard(); await f.detail();
  const original = f.service.getLatestReadingEntry;
  let release;
  f.service.getLatestReadingEntry = async sid => {
    const captured = await original(sid);
    await new Promise(resolve => { release = resolve; });
    return captured;
  };
  const older = f.context.refresh();
  while (!release) await Promise.resolve();
  f.service.getLatestReadingEntry = original;
  f.store.sensor_reading[1].newer = { ...CURRENT, timestamp: new Date(NOW).toISOString(), current: 2 };
  await f.context.refresh(); release(); await older;
  assert.equal(f.elements.detailCurrent.textContent, "2.00");
  f.store.sensor_reading[1] = {};
  await f.intervals[0].fn();
  assert.equal(f.elements.detailCurrent.textContent, "2.00");
});
test("partial node/config snapshots retain evidence but still expire at the last confirmed timeout", async () => {
  const f = setup();
  f.store.system_config.heartbeat_timeout_minutes = 2;
  f.store.streetlight[2] = { ...f.store.streetlight[1], streetlight_id: 2 };
  await f.dashboard(); await f.detail();
  delete f.store.streetlight[1];
  f.store.system_config = {};
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "ONLINE");
  f.clock.now = Date.parse(CURRENT.timestamp) + 120001;
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
  assert.equal(f.elements.detailLightStatus.textContent, "—");
});

for (const [age, expected] of [[14900, "ONLINE"], [15000, "ONLINE"], [15100, "OFFLINE"]]) {
  test("fractional prototype timeout renders heartbeat age " + age + " as " + expected, async () => {
    const f = setup();
    f.store.system_config.heartbeat_timeout_minutes = 0.25;
    f.store.streetlight[1].last_seen = new Date(NOW - age).toISOString();
    f.store.streetlight[1].status = "Active";
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailConnection.textContent, expected);
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Active"); // worker-owned
    assert.deepEqual(f.writes, []);
  });
}
for (const status of ["Faulty", "Active"]) {
  test("prototype reconnect renders ONLINE with worker-owned " + status, async () => {
    const f = setup();
    f.store.system_config.heartbeat_timeout_minutes = 0.25;
    f.store.streetlight[1].last_seen = new Date(NOW - 15100).toISOString();
    f.store.streetlight[1].status = "Offline";
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailConnection.textContent, "OFFLINE");
    f.store.streetlight[1].last_seen = new Date(NOW).toISOString();
    f.store.streetlight[1].status = status;
    f.store.sensor_reading[1] = { next: { ...CURRENT, timestamp: new Date(NOW).toISOString(),
      light_status: status === "Faulty" ? "OFF" : "ON", voltage: status === "Faulty" ? 0 : 11 } };
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent, "ONLINE");
    assert.equal(f.elements.detailStatus.textContent, "\u25cf " + status);
    assert.equal(f.elements.detailLightStatus.textContent, status === "Faulty" ? "OFF" : "ON");
    assert.deepEqual(f.writes, []);
  });
}

function prototypeConnectionFixture() {
  const f = setup();
  f.store.system_config.heartbeat_timeout_minutes = 0.25;
  f.store.streetlight[1].last_seen = new Date(NOW).toISOString();
  return f;
}
test("retained heartbeat expires at 15 seconds without any new Firebase reads", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  const reads = f.queries.length;
  for (const [age, expected] of [[0, "ONLINE"], [10000, "ONLINE"], [14900, "ONLINE"],
    [15000, "ONLINE"], [15100, "OFFLINE"], [90000, "OFFLINE"]]) {
    f.clock.now = NOW + age;
    f.context.expireDisplayedSamples();
    assert.equal(f.elements.detailConnection.textContent.trim(), expected, "age " + age);
    assert.equal(f.queries.length, reads, "expiry does not fetch");
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
  }
  assert.deepEqual(f.writes, []);
});
for (const heartbeat of [undefined, null, "", "uptime-41992", "malformed"]) {
  test("Connection is OFFLINE with no retained evidence for heartbeat " + String(heartbeat), async () => {
    const f = prototypeConnectionFixture(); f.store.streetlight[1].last_seen = heartbeat;
    await f.dashboard(); await f.detail();
    assert.equal(f.elements.detailConnection.textContent.trim(), "OFFLINE");
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
    assert.deepEqual(f.writes, []);
  });
}
test("Connection expires before the first slow poll starts, without waiting for another tick", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  const nodes = await f.service.getStreetlights();
  let release;
  f.service.getStreetlights = () => new Promise(resolve => { release = () => resolve(nodes); });
  f.clock.now = NOW + 15100;
  const pending = f.intervals[0].fn();
  try {
    await Promise.resolve();
    assert.equal(f.elements.detailConnection.textContent.trim(), "OFFLINE");
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
  } finally { release(); await pending; }
  assert.deepEqual(f.writes, []);
});
test("failed polls retain ONLINE only through the inclusive configured timeout", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  for (const method of ["getStreetlights", "getSystemConfig", "getFaultReports", "getLatestReadingEntry"]) {
    f.service[method] = async () => { throw new Error("simulated read failure"); };
  }
  for (const [age, expected] of [[10000, "ONLINE"], [14900, "ONLINE"], [15000, "ONLINE"], [15100, "OFFLINE"]]) {
    f.clock.now = NOW + age;
    await f.intervals[0].fn();
    assert.equal(f.elements.detailConnection.textContent.trim(), expected);
    assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
  }
  assert.deepEqual(f.writes, []);
});
test("expired Connection stays OFFLINE even if refresh throws unexpectedly", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  f.context.refresh = async () => { throw new Error("simulated refresh failure"); };
  f.clock.now = NOW + 15100;
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent.trim(), "OFFLINE");
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.writes, []);
});
test("Connection final renderer always uses one of its two visible states", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  const view = vm.runInContext("nodeViews.get('1')", f.context);
  for (const connection of ["", null, undefined, "UNKNOWN", "OFFLINE", "ONLINE"]) {
    f.context.renderNodeDetail({ ...view, connection }, true);
    assert.equal(f.elements.detailConnection.textContent.trim(), connection === "ONLINE" ? "ONLINE" : "OFFLINE");
  }
  assert.deepEqual(f.writes, []);
});
test("heartbeat expiry and reconnect keep operational status worker-owned", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  f.clock.now = NOW + 15100;
  f.context.expireDisplayedSamples();
  assert.equal(f.elements.detailConnection.textContent.trim(), "OFFLINE");
  assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
  f.store.streetlight[1].status = "Offline"; // next worker result arrives
  await f.intervals[0].fn();
  assert.equal(f.elements.detailStatus.textContent, "\u25cf Offline");
  f.clock.now = NOW + 20000;
  f.store.streetlight[1].last_seen = new Date(f.clock.now).toISOString();
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent.trim(), "ONLINE");
  assert.equal(f.elements.detailStatus.textContent, "\u25cf Offline");
  f.store.streetlight[1].status = "Faulty"; // worker confirms ongoing hardware fault
  await f.intervals[0].fn();
  assert.equal(f.elements.detailConnection.textContent.trim(), "ONLINE");
  assert.equal(f.elements.detailStatus.textContent, "\u25cf Faulty");
  assert.deepEqual(f.writes, []);
});

test("a retained-evidence render error cannot prevent subsequent recovery polls", async () => {
  const f = prototypeConnectionFixture(); await f.dashboard(); await f.detail();
  const expire = f.context.expireDisplayedSamples, read = f.service.getStreetlights;
  let expiryCalls = 0, reads = 0;
  f.context.expireDisplayedSamples = () => {
    if (++expiryCalls === 1) throw new Error("simulated display failure");
    return expire();
  };
  f.service.getStreetlights = async () => { reads++; return read(); };
  f.clock.now = NOW + 15100;
  await f.intervals[0].fn();
  assert.equal(reads, 1);
  assert.equal(f.elements.detailConnection.textContent.trim(), "OFFLINE");
  await f.intervals[0].fn();
  assert.equal(reads, 2);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.writes, []);
});
