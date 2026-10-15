// ============================================================
// LuminaGrid — Node Registration helpers (pure, DOM-free)
// ------------------------------------------------------------
// Shared by js/node-management.js (Admin > Register Monitoring Node)
// and the stubbed test harness test/node-registration.test.js.
// Deliberately free of Firebase, DOM and DataService references so the
// registration rules can be unit-tested outside the browser.
//
// Scope reminder: this module only builds NODE METADATA records for the
// Firebase streetlight/{sid} node. It never provisions a physical ESP32
// Firebase Auth account — device provisioning stays a trusted-backend step.
// ============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NodeRegistration = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Prototype-wide default barangay for newly registered nodes (no barangay
  // field on the existing form — kept internal per the registration spec).
  const DEFAULT_BARANGAY = "Guadalupe";

  // Current Asia/Manila calendar date as "YYYY-MM-DD".
  // Intl with the Manila timezone is exact year-round (PH has no DST), so a
  // registration made just before/after UTC midnight always records the
  // correct LOCAL installation date.
  function manilaDateKey(nowMs) {
    const ms = nowMs == null ? Date.now() : nowMs;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ms));
  }

  // Next numeric streetlight id = max existing numeric id + 1.
  // Derived from the ids actually present (never array length + 1), so a
  // sparse key set (1, 2, 4) can never collide with an existing record.
  // Non-numeric ids are ignored; with no usable id the first key is 1.
  function nextStreetlightId(existingNodes) {
    let max = 0;
    for (const node of existingNodes || []) {
      if (!node) continue;
      const id = Number(node.streetlight_id);
      if (Number.isInteger(id) && id >= 1 && id > max) max = id;
    }
    return max + 1;
  }

  // Validate the raw Register Node form values against the existing nodes.
  // Returns { ok: true, values } with TRIMMED values, or
  //         { ok: false, errors: [...] } — never throws.
  function validateRegistration(input, existingNodes) {
    const src = input || {};
    const errors = [];

    const node_id = String(src.node_id == null ? "" : src.node_id).trim();
    const pole_number = String(src.pole_number == null ? "" : src.pole_number).trim();
    const location = String(src.location == null ? "" : src.location).trim();
    const latRaw = String(src.latitude == null ? "" : src.latitude).trim();
    const lngRaw = String(src.longitude == null ? "" : src.longitude).trim();

    if (!node_id) errors.push("Node ID is required.");
    if (!pole_number) errors.push("Pole Number is required.");
    if (!location) errors.push("Location Description is required.");

    // Uniqueness (case-insensitive) among existing streetlight records.
    const rows = (existingNodes || []).filter(Boolean);
    const lc = (v) => String(v == null ? "" : v).trim().toLowerCase();
    if (node_id && rows.some((n) => lc(n.node_id) === lc(node_id))) {
      errors.push('Node ID "' + node_id + '" is already registered.');
    }
    if (pole_number && rows.some((n) => lc(n.pole_number) === lc(pole_number))) {
      errors.push('Pole Number "' + pole_number + '" is already registered.');
    }

    let latitude = NaN;
    if (!latRaw) {
      errors.push("Latitude is required.");
    } else {
      latitude = Number(latRaw);
      if (!Number.isFinite(latitude)) {
        errors.push("Latitude must be a number.");
      } else if (latitude < -90 || latitude > 90) {
        errors.push("Latitude must be between -90 and 90.");
      }
    }

    let longitude = NaN;
    if (!lngRaw) {
      errors.push("Longitude is required.");
    } else {
      longitude = Number(lngRaw);
      if (!Number.isFinite(longitude)) {
        errors.push("Longitude must be a number.");
      } else if (longitude < -180 || longitude > 180) {
        errors.push("Longitude must be between -180 and 180.");
      }
    }

    if (errors.length > 0) return { ok: false, errors: errors };

    return {
      ok: true,
      values: { node_id, pole_number, location, latitude, longitude }
    };
  }

  // Build the Firebase streetlight record for a NEW node.
  //   - streetlight_id numeric (Firebase key = String(sid))
  //   - status "Offline": no physical device has reported a heartbeat yet,
  //     so the node must never start out Active/Working.
  //   - NO last_seen (a fabricated heartbeat timestamp would be a lie).
  //   - Creates exactly this one record — no sensor_reading, no energy data,
  //     no fault records, no device_authz entry.
  function buildStreetlightRecord(values, sid, dateKey) {
    return {
      streetlight_id: Number(sid),
      node_id: values.node_id,
      pole_number: values.pole_number,
      barangay: values.barangay || DEFAULT_BARANGAY,
      location: values.location,
      latitude: Number(values.latitude),
      longitude: Number(values.longitude),
      installation_date: dateKey || manilaDateKey(),
      status: "Offline"
    };
  }

  // Parse/validate the ONE editable Prototype Operating Settings field:
  // Heartbeat Timeout (minutes). Valid = whole number 1..60 (inclusive).
  // Returns the parsed integer, or null when the input is missing /
  // non-numeric / fractional / out of range. DOM-free so the settings
  // harness can exercise the exact rule the form uses.
  function parseHeartbeatTimeout(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (!Number.isInteger(n)) return null;
    if (n < 1 || n > 60) return null;
    return n;
  }

  return {
    DEFAULT_BARANGAY,
    manilaDateKey,
    nextStreetlightId,
    validateRegistration,
    buildStreetlightRecord,
    parseHeartbeatTimeout
  };
});