const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = name => fs.readFileSync(path.join(__dirname, "../js", name + ".js"), "utf8");
const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
function setup(type = "Power Fault") {
  const store = {
    streetlight: { 1: { streetlight_id: 1, status: "Faulty", last_seen: new Date().toISOString() } },
    fault_report: { f501: { fault_id: "f501", streetlight_id: 1, fault_type: type, status: "Pending", severity: "High" } },
    maintenance_record: { m001: { maintenance_id: "m001", fault_id: "f501", repair_status: "In Progress" } },
    user: { u1: { user_id: "u1", status: "Active" } }
  };
  const writes = [];
  const db = { ref(p) {
    const keys = p.split("/");
    const read = () => keys.reduce((v, k) => v?.[k], store) ?? null;
    const write = v => { let cur = store; for (const k of keys.slice(0, -1)) cur = cur[k] ||= {}; cur[keys.at(-1)] = clone(v); writes.push(p); };
    return {
      async once() { const v = clone(read()); return { val: () => v, exists: () => v !== null }; },
      async set(v) { write(v); }, async update(v) { write({ ...read(), ...v }); },
      async transaction(fn) { const v = fn(clone(read())); write(v); return { committed: true, snapshot: { val: () => v } }; }
    };
  } };
  const elements = {};
  const document = { getElementById(id) { return elements[id] ||= {
    value: "", style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, innerHTML: ""
  }; } };
  const context = vm.createContext({ db, document, console, window: {},
    sessionStorage: { getItem: k => k === "luminagrid_role" ? "admin" : "u1" },
    requireRole: () => "admin", paintUserChip() {}, wireLogout() {}, gateNavByRole() {}, formatDateTime: () => "date"
  });
  vm.runInContext(source("utils"), context);
  vm.runInContext('requireRole = () => "admin"; paintUserChip = wireLogout = gateNavByRole = () => {}; formatDateTime = () => "date";', context);
  vm.runInContext(source("telemetry-time"), context);
  vm.runInContext(source("data-service") + "\nglobalThis.DataService = DataService;", context);
  return { store, writes, context, elements, service: context.DataService };
}
for (const type of ["Power Fault", "Bulb Fault", "Node Offline"]) {
  test(`${type}: service rejects direct Resolve and maintenance completion preserves Pending`, async () => {
    const f = setup(type);
    await assert.rejects(f.service.resolveFaultReport("f501"), /Automatic fault/);
    assert.deepEqual(f.writes, []);
    await f.service.updateMaintenanceRecord("m001", { repair_status: "Completed" });
    assert.equal(f.store.maintenance_record.m001.repair_status, "Completed");
    assert.equal(f.store.fault_report.f501.status, "Pending");
    assert.deepEqual(f.writes, ["maintenance_record/m001"]);
  });
  test(`${type}: fault table removes Resolve; maintenance logs without resolving`, async () => {
    const f = setup(type);
    vm.runInContext(source("fault-records"), f.context);
    await vm.runInContext("renderFaultTable()", f.context);
    assert.match(f.elements.faultTableBody.innerHTML, /Automatic fault/);
    assert.doesNotMatch(f.elements.faultTableBody.innerHTML, /onclick="resolveFaultRecord/);
    const maintenance = setup(type);
    vm.runInContext(source("maintenance"), maintenance.context);
    await vm.runInContext("loadMaintenanceData()", maintenance.context);
    assert.match(maintenance.elements.pendingRepairsList.innerHTML, /Log Maintenance/);
    await maintenance.context.window.quickAcknowledge("f501", 1);
    assert.equal(maintenance.store.fault_report.f501.status, "Pending");
    assert.equal(Object.keys(maintenance.store.maintenance_record).length, 2);
  });
  test(`${type}: dashboard banner disables Resolve and node action skips automatic faults`, async () => {
    const f = setup(type); const dash = source("dashboard");
    const start = dash.indexOf("async function renderFaultBanner");
    const end = dash.indexOf("// ---------- Auto-refresh", start);
    vm.runInContext('const currentRole = "admin"; async function safeRefresh() {} function showNodeDetail() {}\n' + dash.slice(start, end), f.context);
    await f.context.renderFaultBanner(await f.service.getFaultReports({ status: "Pending" }), await f.service.getStreetlights());
    assert.equal(f.elements.bannerResolveBtn.disabled, true);
    assert.equal(f.elements.bannerResolveBtn.onclick, null);
    assert.match(f.elements.bannerResolveBtn.textContent, /telemetry confirms recovery/);
    await vm.runInContext("resolveNodeFault(1)", f.context);
    assert.deepEqual(f.writes, []);
  });
}
test("manual faults retain UI Resolve and maintenance resolution", async () => {
  const f = setup("Wiring Damage"); vm.runInContext(source("fault-records"), f.context);
  await vm.runInContext("renderFaultTable()", f.context);
  assert.match(f.elements.faultTableBody.innerHTML, /onclick="resolveFaultRecord/);
  await f.service.updateMaintenanceRecord("m001", { repair_status: "Completed" });
  assert.equal(f.store.fault_report.f501.status, "Resolved");
  assert.equal(Object.values(f.store.notification).length, 1);
  assert.equal(f.store.streetlight[1].status, "Faulty"); // worker owns status reconciliation
});
test("fault table renders a missing severity and displays plain text labels", async () => {
  const f = setup("Wiring Damage");
  delete f.store.fault_report.f501.severity;
  f.store.streetlight[1].pole_number = "Pole < East & West";
  vm.runInContext(source("fault-records"), f.context);
  await vm.runInContext("renderFaultTable()", f.context);
  assert.match(f.elements.faultTableBody.innerHTML, /Pole &lt; East &amp; West/);
  assert.match(f.elements.faultTableBody.innerHTML, /severity-">—<\/span>/);
  assert.match(f.elements.faultTableBody.innerHTML, /resolveFaultRecord\(&quot;f501&quot;\)/);
});

test("dashboard refresh is display-only, no dormant evaluator or simulation writers", () => {
  const dash = source("dashboard");
  assert.doesNotMatch(dash, /evaluateHardwareFaults|evaluateNodeHardwareFaults|classifyHardwareState|isHardwareTelemetryFresh|hwMutationLock|reportFault/);
  assert.doesNotMatch(source("data-service"), /function (reportFault|tickHeartbeat|markNodeActive)/);
  assert.match(dash, /resolveBtn.disabled = manual.length === 0/);
  assert.doesNotMatch(dash + source("data-service"), /db\.ref\(["\'`]backend_state/);
});
test("browser displays stored backend status even when heartbeat returns before worker recovery", async () => {
  const f = setup("Node Offline"); f.store.streetlight[1].status = "Offline";
  assert.equal((await f.service.getStreetlight(1)).status, "Offline"); assert.deepEqual(f.writes, []);
});
