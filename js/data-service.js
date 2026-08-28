// ============================================================
// LuminaGrid — Data Service
// ------------------------------------------------------------
// Every page reads and writes data through the functions below,
// never through raw fetch()/Firebase calls directly. Right now
// each function reads from data/mock-nodes.json and mutates an
// in-memory copy. Once the ESP32 nodes are live, replace the
// *internals* of these functions with real Firebase Realtime
// Database calls — the function names and return shapes should
// stay the same so dashboard.js, energy-analytics.js, etc. don't
// need to change.
//
// Field names throughout match the finalized ERD (Figure 29)
// exactly: fault_id (not report_id), detected_at/resolved_at,
// description, severity, ambient_light, power_consumption,
// light_status, repair_date/repair_status/remarks, user_id FK
// on both maintenance_record and notification.
// ============================================================

const DataService = (() => {
  let _cache = null;

  async function _load() {
    if (_cache) return _cache;
    const res = await fetch("data/mock-nodes.json");
    _cache = await res.json();
    return _cache;
  }

  // ---------- Streetlights ----------

  // Simulated "now" for the mock dataset: the newest last_seen among nodes
  // represents the current instant in the simulated timeline, so heartbeat
  // staleness stays consistent regardless of the viewer's wall clock.
  // With a live backend this is replaced by Date.now() / Firebase server time.
  function _mockNow(data) {
    const vals = Object.values(data.streetlights || {})
      .map((s) => s.last_seen && new Date(s.last_seen).getTime())
      .filter((t) => !isNaN(t));
    if (vals.length === 0) return new Date().toISOString();
    return new Date(Math.max(...vals)).toISOString();
  }

  // Effective status rule:
  //   1. No heartbeat within heartbeat_timeout_minutes  -> "Offline" (transient, auto-recovers)
  //   2. Pending hardware fault or stored "Faulty" flag  -> "Faulty" (needs manual Resolve)
  //   3. Otherwise                                      -> "Active"
  // "Node Offline" fault reports are treated as connectivity (rule 1), never
  // as a hardware defect, so a resumed heartbeat clears them automatically.
  function _enrich(node, data) {
    const cfg = data.system_config || {};
    if (!node) return null;
    const timeoutMin = cfg.heartbeat_timeout_minutes || 10;
    const nowMs = new Date(_mockNow(data)).getTime();
    const seenMs = node.last_seen ? new Date(node.last_seen).getTime() : NaN;

    let status;
    if (isNaN(seenMs) || nowMs - seenMs > timeoutMin * 60 * 1000) {
      status = "Offline";
    } else {
      const pendingHardware = Object.values(data.fault_reports || {}).some(
        (r) => r.streetlight_id === node.streetlight_id && r.status === "Pending" && r.fault_type !== "Node Offline"
      );
      status = pendingHardware || node.status === "Faulty" ? "Faulty" : "Active";
    }
    return Object.assign({}, node, { status });
  }

  // Compose the canonical "Fault Alert" message for a fault report + node pair.
  // Always derives the node identity from the live node record so the text can
  // never go stale (e.g. pole_number changed after the alert was first sent).
  function _faultAlertMessage(fault, node) {
    const label = node && node.node_id
      ? `${node.node_id} (${node.pole_number || "—"})`
      : (fault ? fault.streetlight_id : "—");
    return `Fault detected at Node ${label} — ${fault.fault_type}. ${fault.description || ""}`;
  }

  // Rewrite every "Fault Alert" notification tied to one of this node's fault
  // reports so the message reflects the node's CURRENT identity. Called when a
  // node is edited (node_id / pole_number changed) or when a fault recurs, so
  // the notification feed never carries a stale node/pole label.
  function _refreshNodeAlertMessages(data, node) {
    Object.values(data.notifications || {}).forEach((n) => {
      if (n.notification_type !== "Fault Alert") return;
      const fault = n.fault_id && data.fault_reports[n.fault_id];
      if (fault && fault.streetlight_id === node.streetlight_id) {
        n.message = _faultAlertMessage(fault, node);
      }
    });
  }

  // Compose the "Resolution" message for a node that has just returned ONLINE.
  function _resolutionMessage(fault, node) {
    const label = node && node.node_id
      ? `${node.node_id} (${node.pole_number || "—"})`
      : (fault ? fault.streetlight_id : "—");
    if (fault && fault.fault_type === "Node Offline") {
      return `Node ${label} is back online. Heartbeat resumed and the offline alert has been cleared.`;
    }
    return `Fault ${fault ? fault.fault_id : "—"} at Node ${label} has been resolved. The node is back online.`;
  }

  // Fan out one Unread "Resolution" notification per active user when a fault
  // is cleared and the node returns ONLINE -- mirrors the seeded n905 pattern
  // so the notification feed always records the node's recovery.
  function _dispatchResolutionNotifications(data, fault, node) {
    if (!fault) return;
    const notifNums = Object.keys(data.notifications || {})
      .map((id) => parseInt(id.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    let nextNotifNum = notifNums.length ? Math.max(...notifNums) : 900;
    const sentAt = new Date(
      new Date(fault.resolved_at || new Date().toISOString()).getTime() + 1000
    ).toISOString();
    Object.values(data.users || {}).forEach((u) => {
      if (u.status !== "Active") return;
      nextNotifNum += 1;
      data.notifications["n" + nextNotifNum] = {
        notification_id: "n" + nextNotifNum,
        fault_id: fault.fault_id,
        user_id: u.user_id,
        notification_type: "Resolution",
        message: _resolutionMessage(fault, node),
        status: "Unread",
        sent_at: sentAt
      };
    });
  }

  async function getStreetlights() {
    const data = await _load();
    return Object.values(data.streetlights || {}).map((n) => _enrich(n, data));
  }

  async function getStreetlight(streetlightId) {
    const data = await _load();
    return _enrich(data.streetlights[streetlightId], data);
  }

  async function upsertStreetlight(node) {
    const data = await _load();
    const prev = data.streetlights[node.streetlight_id];
    data.streetlights[node.streetlight_id] = node;
    // If the node's displayed identity (node_id / pole_number) changed, refresh
    // the stored fault-alert messages so they never reference a stale label.
    if (prev && (prev.node_id !== node.node_id || prev.pole_number !== node.pole_number)) {
      _refreshNodeAlertMessages(data, node);
    }
    return node;
    // Firebase equivalent: db.ref("streetlights/" + node.streetlight_id).set(node)
  }

  // Simulate the ESP32 node reporting a fresh heartbeat (power restored).
  // Refreshes last_seen and auto-resolves any pending "Node Offline" fault so
  // the node returns to ONLINE on its own -- no manual step required.
  async function tickHeartbeat(streetlightId) {
    const data = await _load();
    const node = data.streetlights[streetlightId];
    if (!node) return null;
    const now = _mockNow(data);
    node.last_seen = now;
    if (node.status !== "Faulty") node.status = "Active";
    Object.values(data.fault_reports || {}).forEach((r) => {
      if (r.streetlight_id === streetlightId && r.status === "Pending" && r.fault_type === "Node Offline") {
        r.status = "Resolved";
        r.resolved_at = now;
        // Node is back online on its own -- record the recovery for every
        // active user so the notification feed reflects the updated state.
        _dispatchResolutionNotifications(data, r, node);
      }
    });
    return _enrich(node, data);
  }

  // Force-clear a stored hardware defect (used when a simulated fault has no
  // matching fault report yet, or after a manual inspection confirms the node).
  async function markNodeActive(streetlightId) {
    const data = await _load();
    const node = data.streetlights[streetlightId];
    if (!node) return null;
    node.status = "Active";
    return _enrich(node, data);
  }

  // ---------- Sensor readings ----------
  async function getLatestReading(streetlightId) {
    const data = await _load();
    const readings = Object.values(data.sensor_readings[streetlightId] || {});
    if (readings.length === 0) return null;
    return readings.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  }

  async function getAllReadings() {
    const data = await _load();
    const rows = [];
    Object.entries(data.sensor_readings || {}).forEach(([streetlightId, readings]) => {
      Object.values(readings).forEach((r) => rows.push(r));
    });
    return rows;
  }

  // ---------- Fault reports ----------
  async function getFaultReports({ status } = {}) {
    const data = await _load();
    let reports = Object.values(data.fault_reports || {});
    if (status) reports = reports.filter((r) => r.status === status);
    return reports.sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
  }

  async function resolveFaultReport(faultId) {
    const data = await _load();
    const report = data.fault_reports[faultId];
    if (report) {
      const wasPending = report.status === "Pending";
      report.status = "Resolved";
      report.resolved_at = report.resolved_at || new Date().toISOString();
      // Now that this defect is resolved, restore the node to Active unless it
      // still carries another pending hardware fault.
      const sid = report.streetlight_id;
      const stillPending = Object.values(data.fault_reports || {}).some(
        (r) => r.streetlight_id === sid && r.status === "Pending" && r.fault_type !== "Node Offline"
      );
      const node = data.streetlights && data.streetlights[sid];
      if (node && !stillPending && node.status === "Faulty") {
        node.status = "Active";
      }
      // The node is back online -- update the notification feed: refresh any
      // stale Fault Alert label for this node and fan out a Resolution notice
      // to every active user (only on the actual Pending -> Resolved move so
      // repeated resolves never duplicate entries).
      if (wasPending && node) {
        _refreshNodeAlertMessages(data, node);
        _dispatchResolutionNotifications(data, report, node);
      }
    }
    return report;
  }

  // Simulation / node-reporting path: mimics the ESP32 firmware filing a
  // hardware fault. Creates a Pending fault report, persists the "Faulty"
  // defect flag on the node, and fans out a "Fault Alert" notification to
  // every active user -- exactly what the seeded dataset models. This is what
  // the dashboard "Simulate Faults" button calls so the fault banner, Fault
  // Records, and Notifications pages all reflect the new fault immediately.
  async function reportFault(streetlightId, overrides = {}) {
    const data = await _load();
    const node = data.streetlights[streetlightId];
    if (!node) return null;

    // Next sequential fault id (f501, f502, ... whatever is already seeded).
    const faultNums = Object.keys(data.fault_reports || {})
      .map((id) => parseInt(id.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    const faultId = "f" + ((faultNums.length ? Math.max(...faultNums) : 500) + 1);

    // Attach the newest reading so the report links to a real reading_id.
    const readings = Object.values(data.sensor_readings[streetlightId] || {})
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latest = readings[0] || null;

    // Derive a believable hardware fault from live readings; fall back to a
    // random one when no readings exist yet.
    const templates = [
      {
        type: "Bulb Failure",
        severity: "High",
        desc: "No current draw detected while light is expected ON (nighttime, LDR confirms dark)."
      },
      {
        type: "Overcurrent",
        severity: "Medium",
        desc: "Current draw exceeded threshold of 0.5A. Possible wiring issue."
      },
      {
        type: "Voltage Fluctuation",
        severity: "Low",
        desc: "Supply voltage dropped below 200V for more than 5 minutes."
      },
      {
        type: "Sensor Malfunction",
        severity: "Low",
        desc: "Ambient light sensor reporting inconsistent readings."
      }
    ];
    let tpl;
    if (latest) {
      if ((latest.current || 0) <= 0.02 && (latest.ambient_light || 0) < 200) {
        tpl = templates[0]; // Dark + zero draw -> burnt bulb
      } else if ((latest.current || 0) > 0.5) {
        tpl = templates[1]; // Current spike -> wiring issue
      } else {
        tpl = templates[Math.floor(Math.random() * templates.length)];
      }
    } else {
      tpl = templates[Math.floor(Math.random() * templates.length)];
    }
    const faultType = overrides.fault_type || tpl.type;
    const severity = overrides.severity || tpl.severity;
    const description = overrides.description || ("Simulated fault — " + tpl.desc);

    const detectedAt = _mockNow(data); // keep inside the simulated timeline

    const report = {
      fault_id: faultId,
      streetlight_id: streetlightId,
      reading_id: latest ? latest.reading_id : null,
      fault_type: faultType,
      description,
      severity,
      status: "Pending",
      detected_at: detectedAt,
      resolved_at: null
    };
    data.fault_reports[faultId] = report;

    // Persist the hardware defect so the node keeps the Faulty status even
    // across recomputes (resolveFaultReport clears this later).
    node.status = "Faulty";

    // Fan out one Unread "Fault Alert" per active user, like the seeded data.
    const notifNums = Object.keys(data.notifications || {})
      .map((id) => parseInt(id.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    let nextNotifNum = notifNums.length ? Math.max(...notifNums) : 900;
    const sentAt = new Date(new Date(detectedAt).getTime() + 1000).toISOString();
    // Re-occurrence on the same node: refresh any earlier Fault Alert messages
    // for this node so the feed never carries a stale node/pole label.
    _refreshNodeAlertMessages(data, node);
    Object.values(data.users || {}).forEach((u) => {
      if (u.status !== "Active") return;
      nextNotifNum += 1;
      data.notifications["n" + nextNotifNum] = {
        notification_id: "n" + nextNotifNum,
        fault_id: faultId,
        user_id: u.user_id,
        notification_type: "Fault Alert",
        message: _faultAlertMessage(report, node),
        status: "Unread",
        sent_at: sentAt
      };
    });

    return report;
  }

  // ---------- Maintenance records ----------
  async function getMaintenanceRecords() {
    const data = await _load();
    return Object.values(data.maintenance_records || {});
  }

  async function addMaintenanceRecord(record) {
    const data = await _load();
    const id = "m" + String(Object.keys(data.maintenance_records).length + 1).padStart(3, "0");
    record.maintenance_id = id;
    data.maintenance_records[id] = record;
    return record;
  }

  async function updateMaintenanceRecord(id, updates) {
    const data = await _load();
    if (data.maintenance_records[id]) {
      Object.assign(data.maintenance_records[id], updates);
    }
    return data.maintenance_records[id];
  }

  // ---------- Notifications ----------
  async function getNotifications(userId) {
    const data = await _load();
    let items = Object.values(data.notifications || {});
    if (userId) items = items.filter((n) => n.user_id === userId);
    return items.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
  }

  async function markNotificationRead(notificationId) {
    const data = await _load();
    if (data.notifications[notificationId]) {
      data.notifications[notificationId].status = "Read";
    }
    return data.notifications[notificationId];
  }

  async function getUnreadCount(userId) {
    const notifs = await getNotifications(userId);
    return notifs.filter((n) => n.status === "Unread").length;
  }

  // ---------- Users ----------
  async function getUsers() {
    const data = await _load();
    return Object.values(data.users || {});
  }

  async function getUserByEmail(email) {
    const data = await _load();
    return Object.values(data.users || {}).find((u) => u.email === email) || null;
  }

  async function addUser(user) {
    const data = await _load();
    const id = "u" + String(Object.keys(data.users).length + 1).padStart(3, "0");
    user.user_id = id;
    user.created_at = new Date().toISOString();
    user.status = "Active";
    data.users[id] = user;
    return user;
  }

  async function deactivateUser(userId) {
    const data = await _load();
    if (data.users[userId]) data.users[userId].status = "Deactivated";
    return data.users[userId];
  }

  async function getUserById(userId) {
    const data = await _load();
    return data.users[userId] || null;
  }

  // Partial update of an existing user's own profile. Only the caller's own
  // record should ever be passed here (enforced by js/profile.js using the
  // user_id stored in sessionStorage at login).
  // Firebase equivalent:
  //   db.ref("users/" + userId).update(updates)
  async function updateUser(userId, updates) {
    const data = await _load();
    if (data.users[userId]) {
      Object.assign(data.users[userId], updates);
    }
    return data.users[userId] || null;
  }

  // ---------- Energy aggregation ----------
  async function getTotalKwhToday() {
    const readings = await getAllReadings();
    const totalWatts = readings.reduce((sum, r) => sum + (r.power_consumption || 0), 0);
    return totalWatts / 1000; // rough placeholder until real interval-based accumulation exists
  }

  async function getMonthlyEnergy() {
    const data = await _load();
    return data.energy_monthly || {};
  }

  // ---------- System config ----------
  async function getSystemConfig() {
    const data = await _load();
    return data.system_config || {};
  }

  async function updateSystemConfig(updates) {
    const data = await _load();
    Object.assign(data.system_config, updates);
    return data.system_config;
  }

  return {
    getStreetlights, getStreetlight, upsertStreetlight, tickHeartbeat, markNodeActive,
    getLatestReading, getAllReadings,
    getFaultReports, reportFault, resolveFaultReport,
    getMaintenanceRecords, addMaintenanceRecord, updateMaintenanceRecord,
    getNotifications, markNotificationRead, getUnreadCount,
    getUsers, getUserByEmail, getUserById, addUser, deactivateUser, updateUser,
    getTotalKwhToday, getMonthlyEnergy,
    getSystemConfig, updateSystemConfig
  };
})();
