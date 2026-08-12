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
  async function getStreetlights() {
    const data = await _load();
    return Object.values(data.streetlights || {});
  }

  async function getStreetlight(streetlightId) {
    const data = await _load();
    return data.streetlights[streetlightId] || null;
  }

  async function upsertStreetlight(node) {
    const data = await _load();
    data.streetlights[node.streetlight_id] = node;
    return node;
    // Firebase equivalent: db.ref("streetlights/" + node.streetlight_id).set(node)
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
    if (data.fault_reports[faultId]) {
      data.fault_reports[faultId].status = "Resolved";
      data.fault_reports[faultId].resolved_at = new Date().toISOString();
    }
    return data.fault_reports[faultId];
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
    getStreetlights, getStreetlight, upsertStreetlight,
    getLatestReading, getAllReadings,
    getFaultReports, resolveFaultReport,
    getMaintenanceRecords, addMaintenanceRecord, updateMaintenanceRecord,
    getNotifications, markNotificationRead, getUnreadCount,
    getUsers, getUserByEmail, addUser, deactivateUser,
    getTotalKwhToday, getMonthlyEnergy,
    getSystemConfig, updateSystemConfig
  };
})();
