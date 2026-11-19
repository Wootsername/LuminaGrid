// Run separately: node --test test/dashboard-connection-browser.test.js
// Actual browser CSS/rendering with all external resources blocked.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const browser = [
  process.env.LUMINAGRID_TEST_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find(file => file && fs.existsSync(file));
const inline = source =>
  "<script>" + source.replace(/<\/script/gi, "<\\/script") + "</script>";

test("Connection stays visible across operational and connection states", {
  skip: !browser && "Set LUMINAGRID_TEST_BROWSER to a Chromium executable",
  timeout: 45000
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-connection-"));
  try {
    const css = read("css/style.css").replace(/@import[^;]*;/g, "");
    let html = read("dashboard.html")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<link\b[^>]*>/gi, "")
      .replace(/\s(?:src|srcset)="[^"]*"/gi, "");
    html = html.replace("<head>", "<head>" +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'">' +
      "<style>" + css + "</style>");
    const stubs = [
      'const fixtureNode = { streetlight_id: "1", node_id: "NODE-001", pole_number: "P-001",',
      'status: "Active", last_seen: new Date().toISOString(), latitude: 10.32, longitude: 123.88 };',
      'const DataService = { timestampAge: TelemetryTime.timestampAge, parseTelemetryTimestamp: TelemetryTime.parseTelemetryTimestamp,',
      'getStreetlights: async () => [fixtureNode], getSystemConfig: async () => ({ heartbeat_timeout_minutes: 0.25 }),',
      'getFaultReports: async () => [], getLatestReadingEntry: async () => null, isAutomaticFaultType: () => true };',
      'function requireRole() { return "admin"; }',
      'function paintUserChip() {} function wireLogout() {} function gateNavByRole() {}',
      'function formatDateTime(value) { return String(value); }',
      'window.setInterval = () => 0;',
      'const L = { map: () => ({ setView() { return this; }, fitBounds() {}, flyTo() {} }),',
      'tileLayer: () => ({ addTo() {} }), divIcon: value => value, latLngBounds: () => ({ pad() { return this; } }),',
      'marker: () => ({ addTo() { return this; }, bindPopup() { return this; }, on() { return this; },',
      'setIcon() {}, setPopupContent() {}, openPopup() {} }) };'
    ].join("\n");
    function probe() {
      (async () => {
        let result;
        try {
          const initialText = document.getElementById("detailConnection").textContent.trim();
          await refresh();
          const color = value => {
            const parts = value.match(/[\d.]+/g).map(Number);
            return [...parts.slice(0, 3), parts[3] ?? 1];
          };
          const blend = (top, bottom) =>
            bottom.map((value, i) => top[i] * top[3] + value * (1 - top[3]));
          const luminance = rgb => rgb.map(value => {
            value /= 255;
            return value <= 0.04045 ? value / 12.92 :
              Math.pow((value + 0.055) / 1.055, 2.4);
          }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
          const base = buildNodeView(fixtureNode, null, {
            nowMs: Date.now(), pollId: 1, config: { heartbeat_timeout_minutes: 0.25 }
          });
          const rows = [];
          for (const status of ["Active", "Faulty", "Offline"]) {
            for (const connection of ["ONLINE", "OFFLINE"]) {
              renderNodeDetail({ ...base, streetlight: { ...fixtureNode, status }, connection }, true);
              const cell = document.getElementById("detailConnection");
              const element = cell.querySelector(".status-pill") || cell;
              const ancestors = [];
              for (let parent = element; parent; parent = parent.parentElement) ancestors.push(parent);
              let background = [255, 255, 255];
              for (const parent of ancestors.reverse())
                background = blend(color(getComputedStyle(parent).backgroundColor), background);
              const foreground = blend(color(getComputedStyle(element).color), background);
              const a = luminance(foreground), b = luminance(background);
              const rectangle = element.getBoundingClientRect();
              rows.push({
                status, connection, text: cell.textContent.trim(),
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                visible: rectangle.width > 0 && rectangle.height > 0 && ancestors.every(parent => {
                  const style = getComputedStyle(parent);
                  return style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
                })
              });
            }
          }
          result = { initialText, rows };
        } catch (error) { result = { error: error.stack }; }
        const output = document.createElement("pre");
        output.id = "connection-browser-result";
        output.textContent = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(result))));
        document.body.append(output);
      })();
    }
    html = html.replace("</body>", inline(read("js/telemetry-time.js")) + inline(read("js/utils.js")) + inline(stubs) +
      inline(read("js/dashboard.js")) + inline("(" + probe.toString() + ")();") + "</body>");
    const fixture = path.join(directory, "fixture.html");
    fs.writeFileSync(fixture, html);
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--disable-extensions", "--disable-sync", "--no-default-browser-check",
      "--window-size=1440,1200", "--user-data-dir=" + path.join(directory, "profile"),
      "--virtual-time-budget=3000", "--dump-dom", pathToFileURL(fixture).href
    ], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const encoded = run.stdout.match(/<pre id="connection-browser-result">([A-Za-z0-9+/=]+)<\/pre>/);
    assert.ok(encoded, "Browser did not return rendering results: " + run.stderr);
    const result = JSON.parse(Buffer.from(encoded[1], "base64").toString());
    assert.ok(Array.isArray(result.rows), JSON.stringify(result));
    assert.equal(result.rows.length, 6);
    // Check contrast first so the original white-on-white defect is explained.
    for (const row of result.rows) {
      assert.equal(row.text, row.connection, JSON.stringify(row));
      assert.equal(row.visible, true, JSON.stringify(row));
      assert.ok(row.contrast >= 4.5, JSON.stringify(row));
    }
    assert.equal(result.initialText, "OFFLINE");
  } finally {
    // Only remove the unique temporary directory created above, never a computed repo path.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("lumina-connection-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
