// ============================================================
// LuminaGrid — Prototype Operating Settings (thresholds cleanup) tests
// Run: node test/thresholds-settings.test.js   (from repo root)
// ============================================================
// A/B  Modal static content: shows the REAL firmware thresholds read-only,
//      does NOT expose legacy mains/lux values as editable controls.
// C-E  DataService path: legacy system_config preserved on a heartbeat-only
//      save; voltage_threshold_low=200 / lux fields untouched; validation.
// F    Double-submit guard present in the form handler.
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

const NodeRegistration = require(path.join(root, "js", "node-registration.js"));

// ---------- A/B: modal HTML ----------
console.log("== A/B. modal content ==");
const html = fs.readFileSync(path.join(root, "node-management.html"), "utf8");
const modalStart = html.indexOf('id="configModal"');
const modalEnd = html.indexOf("</main>", modalStart);
const modal = modalStart >= 0 && modalEnd > modalStart ? html.slice(modalStart, modalEnd) : "";
// Visible content only: HTML comments are developer documentation (section 5
// REQUIRES a comment mentioning voltage_threshold_low = 200 / lux legacy
// fields) and are never rendered to the administrator.
const visible = modal.replace(/<!--[\s\S]*?-->/g, "");

assert(modal.length > 0, "configModal section located in node-management.html");
assert(modal.includes("Prototype Operating Settings"), "A: titled 'Prototype Operating Settings'");
assert(modal.includes("Current monitoring thresholds and node connectivity settings."), "A: correct subtitle");
assert(modal.includes("3.0 V"), "A: displays Power Fault cutoff 3.0 V");
assert(modal.includes("0.50 A"), "A: displays Bulb Fault cutoff 0.50 A");
assert(modal.includes("Digital LDR"), "A: displays Light Sensor Mode = Digital LDR");
assert(modal.includes("0 = Daylight"), "A: displays 0 = Daylight");
assert(modal.includes("1 = Night"), "A: displays 1 = Night");
assert(
  modal.includes("Fault thresholds are fixed in the current prototype firmware."),
  "A: firmware-fixed explanatory note present"
);
assert(modal.includes('id="cfgHeartbeat"'), "A: one editable Heartbeat Timeout field");
assert(modal.includes("Save Settings"), "A: button labeled 'Save Settings'");

assert(!modal.includes("Set Operating Thresholds"), "B: old title removed");
assert(!modal.includes("Save Thresholds"), "B: old button label removed");
assert(!modal.includes("cfgHighCurrent"), "B: no editable High Current field");
assert(!modal.includes("cfgLowCurrent"), "B: no editable Low Current field");
assert(!modal.includes("cfgDuskLux"), "B: no editable Dusk Lux field");
assert(!modal.includes("cfgDawnLux"), "B: no editable Dawn Lux field");
assert(!/lux/i.test(visible), "B: no 'lux' control text anywhere in modal (rendered)");
assert(!/\b200\b/.test(visible), "B: 200 V legacy value not displayed (rendered)");
assert(!/\b150\b/.test(visible), "B: 150 lux legacy value not displayed (rendered)");
assert(!/\bvalue="50"\b/.test(visible), "B: 50 lux legacy default not displayed (rendered)");

// ---------- F: form handler source guards ----------
console.log("== F. double-submit guard (source) ==");
const nmSrc = fs.readFileSync(path.join(root, "js", "node-management.js"), "utf8");
assert(/if \(savingConfig\) return;/.test(nmSrc), "F: submit handler early-returns while saving");
assert(/savingConfig = true;/.test(nmSrc), "F: guard flag set before write");
assert(/finally \{\s*savingConfig = false;/m.test(nmSrc), "F: guard released in finally");
assert(/saveBtn"\)\.disabled = true|saveBtn\) saveBtn\.disabled = true/.test(nmSrc), "F: Save Settings button disabled while processing");
assert(nmSrc.includes("showNodeToast(\"Operating settings updated.\")"), "F: success toast used (no alert())");
assert(!nmSrc.includes("Operating thresholds updated successfully."), "F: legacy alert() success message removed");
assert(/cfgHighCurrent|cfgLowCurrent|cfgDuskLux|cfgDawnLux/.test(nmSrc) === false, "JS: no references to removed threshold inputs");
assert(nmSrc.includes("...current"), "JS: save spreads ALL existing config fields (preserve-all)");
assert(nmSrc.includes("heartbeat_timeout_minutes: minutes"), "JS: save changes ONLY heartbeat_timeout_minutes");

// ---------- C/D/E: real data-service + legacy system_config ----------
console.log("== C/D/E. system_config save semantics ==");

// Legacy Firebase config exactly as deployed (mains-era + lux fields kept).
const legacyConfig = {
  energy_rate_per_kwh: 13.6,
  current_threshold_high: 0.5,
  current_threshold_low: 0.1,
  voltage_threshold_low: 200,
  heartbeat_timeout_minutes: 10,
  dusk_lux_threshold: 50,
  dawn_lux_threshold: 150
};

const store = { system_config: JSON.parse(JSON.stringify(legacyConfig)) };
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
  return {
    ref(p) {
      return {
        async once() {
          const v = readNode(p);
          return { val: () => (v === null ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null };
        },
        async set(v) { writeNode(p, JSON.parse(JSON.stringify(v))); },
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
    }
  };
}

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
const DataService = vm.runInContext("DataService", context);

(async () => {
  // C. heartbeat_timeout_minutes loads the current Firebase value.
  const cfg = await DataService.getSystemConfig();
  assert(cfg.heartbeat_timeout_minutes === 10, "C: heartbeat_timeout_minutes loads current value (10)");
  assert(NodeRegistration.parseHeartbeatTimeout(cfg.heartbeat_timeout_minutes) === 10,
    "C: loaded value passes the form validation rule");

  // D. Save heartbeat 10 -> 15: ONLY heartbeat changes.
  const minutes = NodeRegistration.parseHeartbeatTimeout(15);
  assert(minutes === 15, "D: parsed new value 15");
  await DataService.updateSystemConfig({ ...cfg, heartbeat_timeout_minutes: minutes });

  const after = store.system_config;
  assert(after.heartbeat_timeout_minutes === 15, "D: heartbeat_timeout_minutes = 15 after save");
  assert(after.energy_rate_per_kwh === 13.6, "D: energy_rate_per_kwh UNCHANGED");
  assert(after.current_threshold_high === 0.5, "D: current_threshold_high UNCHANGED");
  assert(after.current_threshold_low === 0.1, "D: current_threshold_low UNCHANGED");
  assert(after.dusk_lux_threshold === 50, "D: dusk_lux_threshold UNCHANGED (not deleted)");
  assert(after.dawn_lux_threshold === 150, "D: dawn_lux_threshold UNCHANGED (not deleted)");
  // Section 8: voltage_threshold_low=200 must NOT be silently rewritten to 3.
  assert(after.voltage_threshold_low === 200, "8: voltage_threshold_low STILL 200 (not migrated)");
  // Section 11: exact 7-field schema — no fields added or removed.
  const keys = Object.keys(after).sort().join(",");
  assert(keys === "current_threshold_high,current_threshold_low,dawn_lux_threshold,dusk_lux_threshold,energy_rate_per_kwh,heartbeat_timeout_minutes,voltage_threshold_low",
    "11: exactly the original 7 schema fields (" + keys + ")");

  // E. invalid heartbeat values rejected by the shared form rule.
  assert(NodeRegistration.parseHeartbeatTimeout("0") === null, "E: 0 rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("-5") === null, "E: negative rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("abc") === null, "E: non-numeric rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("61") === null, "E: > 60 rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("10.5") === null, "E: fractional rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("") === null, "E: empty rejected");
  assert(NodeRegistration.parseHeartbeatTimeout("1") === 1, "E: minimum 1 accepted");
  assert(NodeRegistration.parseHeartbeatTimeout(" 60 ") === 60, "E: maximum 60 accepted (trimmed)");

  console.log("\nRESULT: " + pass + " passed, " + fails.length + " failed");
  if (fails.length) {
    fails.forEach((f) => console.log("  FAILED: " + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
