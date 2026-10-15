// ============================================================
// LuminaGrid — Data Service
// ------------------------------------------------------------
// Every page reads and writes data through the functions below,
// never through raw fetch()/Firebase calls directly. Since Steps
// 4-12 ALL of the internals call Firebase Realtime Database
// (streetlight, sensor_reading, fault_report, notification,
// maintenance_record, user, system_config, energy_monthly) and
// Firebase Authentication (Email/Password) — no runtime mock backend
// remains. The function names and return shapes stay the same so
// dashboard.js, energy-analytics.js, etc. never need to change.
//
// Field names throughout match the finalized ERD (Figure 29)
// exactly: fault_id (not report_id), detected_at/resolved_at,
// description, severity, ambient_light, power_consumption,
// light_status, repair_date/repair_status/remarks, user_id FK
// on both maintenance_record and notification.
// ============================================================

const DataService = (() => {
  // ---------- Streetlights ----------

  // Historical test-clock helper from the mock era: it returned the newest
  // last_seen among data.streetlights, or wall-clock now when none exist.
  // Step 12 removed the mock callers; _enrich() still calls it, but its
  // Firebase enrichment contexts never contain streetlights, so it now
  // always resolves to the real current time.
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
    // Only apply the heartbeat/offline check when last_seen is present and
    // parseable.  Firebase streetlight records may not carry last_seen (it is
    // not part of the ERD), so a missing value must never force Offline.
    if (node.last_seen && !isNaN(seenMs) && nowMs - seenMs > timeoutMin * 60 * 1000) {
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
    const label = node
      ? (node.node_id ? `${node.node_id} (${node.pole_number || "—"})` : (node.pole_number || node.streetlight_id))
      : (fault ? fault.streetlight_id : "—");
    return `Fault detected at Node ${label} — ${fault.fault_type}. ${fault.description || ""}`;
  }

  // Rewrite every "Fault Alert" notification tied to one of this node's fault
  // reports so the message reflects the node's CURRENT identity. Called when a
  // node is edited (node_id / pole_number changed), so the notification feed
  // never carries a stale node/pole label. Step 13 FINAL: reads Firebase
  // /fault_report + /notification and updates ONLY the message field of the
  // matching records via RECORD-LEVEL writes — notification_id, fault_id,
  // user_id, notification_type, status and sent_at are never touched.
  async function _refreshNodeAlertMessages(node) {
    const [faultsSnap, notifsSnap] = await Promise.all([
      db.ref("fault_report").once("value"),
      db.ref("notification").once("value")
    ]);
    const faults = faultsSnap.val() || {};
    const messageUpdates = [];
    Object.entries(notifsSnap.val() || {}).forEach(([key, n]) => {
      if (!n || n.notification_type !== "Fault Alert") return;
      const fault = n.fault_id && faults[n.fault_id];
      if (fault && String(fault.streetlight_id) === String(node.streetlight_id)) {
        messageUpdates.push([key, _faultAlertMessage(fault, node)]);
      }
    });
    // Step 13 FINAL: record-level writes only — the candidate rules contain
    // no /notification parent .write; message changes are authorized per
    // record at notification/{id} (admin/electrician lifecycle branch).
    for (const [key, message] of messageUpdates) {
      await db.ref("notification/" + key).update({ message });
    }
  }

  // Compose the "Resolution" message for a node that has just returned ONLINE.
  function _resolutionMessage(fault, node) {
    const label = node
      ? (node.node_id ? `${node.node_id} (${node.pole_number || "—"})` : (node.pole_number || node.streetlight_id))
      : (fault ? fault.streetlight_id : "—");
    if (fault && fault.fault_type === "Node Offline") {
      return `Node ${label} is back online. Heartbeat resumed and the offline alert has been cleared.`;
    }
    return `Fault ${fault ? fault.fault_id : "—"} at Node ${label} has been resolved. The node is back online.`;
  }

  // (Step 12 retired _dispatchResolutionNotifications(): the mock
  // tickHeartbeat path is gone and every Resolution notification is now
  // emitted exclusively by resolveFaultReport() through
  // _dispatchFirebaseNotifications().)

  // Highest numeric portion among existing Firebase notification ids (n001,
  // n002, ...). Step 13 REVISION: ids come from an internal Firebase counter
  // (counter/notification) incremented with a transaction — never from reading
  // notification records — so computing an id never exposes another user's
  // notification content to electricians. Candidate rules validate the counter
  // as a number advancing by exactly +1; it is bootstrapped from the highest
  // existing n### suffix before publication (live node currently empty -> 0).
  // Safe initial creation: a missing counter starts at 1 (-> n001).
  async function _nextNotificationNum() {
    const counterRef = db.ref("counter/notification");
    const result = await counterRef.transaction((current) => {
      if (typeof current === "number") return current + 1;
      return 1;
    });
    if (!result || !result.committed) {
      throw new Error("Could not allocate a notification id from counter/notification.");
    }
    return result.snapshot.val();
  }

  // Fan out one Unread notification per ACTIVE user to Firebase
  // notification/{n###}. The recipient list is read from the Firebase
  // /user node. All records are written in a single multi-path update.
  async function _dispatchFirebaseNotifications(fault, notificationType, message) {
    if (!fault) return [];
    const activeUsers = (await getUsers()).filter(
      (user) => user && user.status === "Active"
    );
    if (activeUsers.length === 0) return [];

    const sentAt = new Date().toISOString();
    const created = [];

    // Step 13 FINAL: one counter transaction + one RECORD-LEVEL set() per
    // notification — the candidate rules have no /notification parent .write,
    // so each create is authorized at notification/{id} itself (admin/
    // electrician lifecycle branch). Duplicate prevention: every id comes
    // from a committed counter transaction immediately before its own set(),
    // so ids stay unique even if the loop is interrupted mid fan-out.
    for (const user of activeUsers) {
      const nextNum = await _nextNotificationNum();
      const notificationId = "n" + String(nextNum).padStart(3, "0");
      const notification = {
        notification_id: notificationId,
        fault_id: fault.fault_id,
        user_id: user.user_id,
        notification_type: notificationType,
        message,
        status: "Unread",
        sent_at: sentAt
      };
      await db.ref("notification/" + notificationId).set(notification);
      created.push(notification);
    }

    return created;
  }

  async function getStreetlights() {
    // Step 10: streetlight, fault_report and system_config are read in
    // parallel straight from Firebase — getStreetlights() no longer touches
    // data/mock-nodes.json at all (energy_monthly migrated to Firebase in
    // Step 11, so no data entity reads mock-nodes.json anymore).
    const [snapshot, faultsSnap, configSnap] = await Promise.all([
      db.ref("streetlight").once("value"),
      db.ref("fault_report").once("value"),
      db.ref("system_config").once("value")
    ]);
    const raw = snapshot.val() || {};

    // Firebase numeric keys (1, 2, 3, 4) may produce an array-like object
    // with an empty index 0 — filter(Boolean) strips those nulls out.
    const nodes = Object.values(raw)
      .filter(Boolean)
      .map((node) => ({
        ...node,
        streetlight_id: String(node.streetlight_id)
      }));

    const enrichData = {
      fault_reports: faultsSnap.val() || {},
      system_config: configSnap.val() || {}
    };

    return nodes.map((n) => _enrich(n, enrichData));
  }

  async function getStreetlight(streetlightId) {
    // Step 10: the node, its fault reports and the system configuration are
    // read in parallel from Firebase — no mock-nodes.json load remains here.
    const [snapshot, faultsSnap, configSnap] = await Promise.all([
      db.ref("streetlight/" + streetlightId).once("value"),
      db.ref("fault_report").once("value"),
      db.ref("system_config").once("value")
    ]);

    const node = snapshot.val();

    if (!node) {
      return null;
    }

    const enriched = {
      ...node,
      streetlight_id: String(node.streetlight_id)
    };

    const enrichData = {
      fault_reports: faultsSnap.val() || {},
      system_config: configSnap.val() || {}
    };

    return _enrich(enriched, enrichData);
  }

  // Step 12: registration/edit now writes straight to Firebase
  // streetlight/{streetlightId} with set() — the same whole-record
  // replacement the mock implementation performed. The caller's object is
  // stored verbatim (including optional node_id/location/last_seen supplied
  // by the existing form); streetlight_id, latitude and longitude are
  // coerced to numbers to match the existing Firebase records.
  async function upsertStreetlight(node) {
    const prevSnap = await db
      .ref("streetlight/" + node.streetlight_id)
      .once("value");
    const prev = prevSnap.val();

    const record = { ...node, streetlight_id: Number(node.streetlight_id) };
    if (record.latitude != null) record.latitude = Number(record.latitude);
    if (record.longitude != null) record.longitude = Number(record.longitude);

    await db.ref("streetlight/" + node.streetlight_id).set(record);

    // If the node's displayed identity (node_id / pole_number) changed, refresh
    // the stored fault-alert messages so they never reference a stale label.
    if (prev && (prev.node_id !== node.node_id || prev.pole_number !== node.pole_number)) {
      await _refreshNodeAlertMessages(node);
    }
    return node;
  }

  // Simulate the ESP32 node reporting a fresh heartbeat (power restored).
  // Step 12: refreshes last_seen on the Firebase streetlight record with a
  // real timestamp (the old mock test-clock only existed for the fixed mock
  // timeline) and resolves any pending "Node Offline" fault through the
  // existing resolveFaultReport() lifecycle — the single source of truth for
  // fault status changes, resolved_at, restoring streetlight Active and
  // emitting exactly one Resolution notification per active user (its
  // wasPending guard prevents duplicates on repeat recoveries).
  async function tickHeartbeat(streetlightId) {
    const nodeSnap = await db.ref("streetlight/" + streetlightId).once("value");
    const node = nodeSnap.val();
    if (!node) return null;

    const now = new Date().toISOString();
    const patch = { last_seen: now };
    if (node.status !== "Faulty") patch.status = "Active";
    await db.ref("streetlight/" + streetlightId).update(patch);

    // Reconnect recovery: resolve every pending "Node Offline" fault for this
    // node via the shared Firebase fault lifecycle (no local status writes).
    const faultsSnap = await db.ref("fault_report").once("value");
    const offlineFaultIds = Object.entries(faultsSnap.val() || {})
      .filter(([, r]) =>
        r &&
        String(r.streetlight_id) === String(streetlightId) &&
        r.status === "Pending" &&
        r.fault_type === "Node Offline"
      )
      .map(([key]) => key);
    for (const faultId of offlineFaultIds) {
      await resolveFaultReport(faultId);
    }

    // Same return shape as before: the enriched node (live faults + config).
    return getStreetlight(streetlightId);
  }

  // Force-clear a stored hardware defect (used when a simulated fault has no
  // matching fault report yet, or after a manual inspection confirms the node).
  // Step 12: operates entirely on Firebase. Pending "Node Offline" fault(s)
  // are resolved through the existing resolveFaultReport() lifecycle; other
  // pending hardware faults are preserved — the stored status is only set to
  // Active when no unresolved hardware defect remains, so this can never
  // force an unresolved bulb/current fault to Active (while one is pending
  // the stored Faulty flag stays and _enrich keeps deriving Faulty).
  async function markNodeActive(streetlightId) {
    const nodeSnap = await db.ref("streetlight/" + streetlightId).once("value");
    const node = nodeSnap.val();
    if (!node) return null;

    const faultsSnap = await db.ref("fault_report").once("value");
    const faults = Object.entries(faultsSnap.val() || {});

    // Connectivity recovery: resolve pending "Node Offline" fault(s) only.
    const offlineFaultIds = faults
      .filter(([, r]) =>
        r &&
        String(r.streetlight_id) === String(streetlightId) &&
        r.status === "Pending" &&
        r.fault_type === "Node Offline"
      )
      .map(([key]) => key);
    for (const faultId of offlineFaultIds) {
      await resolveFaultReport(faultId);
    }

    // Preserve any pending hardware fault (never force it Active).
    const hardwarePending = faults.some(
      ([, r]) =>
        r &&
        String(r.streetlight_id) === String(streetlightId) &&
        r.status === "Pending" &&
        r.fault_type !== "Node Offline"
    );
    if (!hardwarePending) {
      await db.ref("streetlight/" + streetlightId + "/status").set("Active");
    }

    // Same return shape as before: the enriched node (live faults + config).
    return getStreetlight(streetlightId);
  }

  // ---------- Sensor readings ----------
  // Newest reading is decided ONLY by the record's `timestamp` field.
  // Reading keys look like r_<millis>_<random> (e.g. r_76594_adc2c836), so
  // lexicographical Firebase key order is NOT chronological order and must
  // never be used here. Records with a missing/unparseable timestamp sort to
  // the oldest instead of producing NaN comparisons.
  async function getLatestReading(streetlightId) {
    const snapshot = await db
      .ref("sensor_reading/" + streetlightId)
      .once("value");

    const raw = snapshot.val() || {};

    const readings = Object.values(raw)
      .filter(Boolean);

    if (readings.length === 0) {
      return null;
    }

    const tsMs = (reading) => {
      const ms = Date.parse((reading && reading.timestamp) || "");
      return isNaN(ms) ? 0 : ms;
    };

    return readings.sort((a, b) => tsMs(b) - tsMs(a))[0];
  }

  async function getAllReadings() {
    const snapshot = await db
      .ref("sensor_reading")
      .once("value");

    const raw = snapshot.val() || {};

    const rows = [];

    Object.values(raw)
      .filter(Boolean)
      .forEach((readings) => {

        Object.values(readings)
          .filter(Boolean)
          .forEach((reading) => {
            rows.push(reading);
          });

      });

    return rows;
  }

  // ---------- Fault reports ----------
  async function getFaultReports({ status } = {}) {
    const snapshot = await db.ref("fault_report").once("value");
    const raw = snapshot.val() || {};
    let reports = Object.values(raw).filter(Boolean);
    if (status) reports = reports.filter((r) => r.status === status);
    return reports.sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
  }

  async function resolveFaultReport(faultId) {
    const snapshot = await db.ref("fault_report/" + faultId).once("value");
    const report = snapshot.val();

    if (!report) return null;

    // Only a genuine Pending -> Resolved transition may emit a Resolution
    // notification; re-resolving an already Resolved fault must not.
    const wasPending = report.status === "Pending";

    report.status = "Resolved";
    report.resolved_at = report.resolved_at || new Date().toISOString();

    // Update fault report in Firebase
    await db.ref("fault_report/" + faultId).set(report);

    const sid = report.streetlight_id;

    // Check if there are other pending hardware faults for this streetlight
    const allFaultsSnap = await db.ref("fault_report").once("value");
    const allFaults = Object.values(allFaultsSnap.val() || {}).filter(Boolean);
    const stillPending = allFaults.some(
      (r) => String(r.streetlight_id) === String(sid) && r.status === "Pending" && r.fault_type !== "Node Offline"
    );

    if (!stillPending) {
      await db.ref("streetlight/" + sid + "/status").set("Active");

      // Node is back to Active -- notify every active user (Firebase).
      if (wasPending) {
        try {
          const nodeSnap = await db.ref("streetlight/" + sid).once("value");
          const node = nodeSnap.val() || null;
          await _dispatchFirebaseNotifications(
            report,
            "Resolution",
            _resolutionMessage(report, node)
          );
        } catch (err) {
          console.error("Failed to create Resolution notifications:", err);
        }
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
    const node = await getStreetlight(streetlightId);
    if (!node) return null;

    const latest = await getLatestReading(streetlightId);

    // Next sequential fault id
    const faultsSnap = await db.ref("fault_report").once("value");
    const faultNums = Object.keys(faultsSnap.val() || {})
      .map((id) => parseInt(id.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    const faultId = "f" + ((faultNums.length ? Math.max(...faultNums) : 500) + 1);

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
        desc: "Supply voltage dropped below the configured operating threshold."
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
        tpl = templates[0];
      } else if ((latest.current || 0) > 0.5) {
        tpl = templates[1];
      } else {
        tpl = templates[Math.floor(Math.random() * templates.length)];
      }
    } else {
      tpl = templates[Math.floor(Math.random() * templates.length)];
    }
    const faultType = overrides.fault_type || tpl.type;
    const severity = overrides.severity || tpl.severity;
    const description = overrides.description || ("Simulated fault — " + tpl.desc);

    const detectedAt = new Date().toISOString();

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

    // Write report to Firebase
    await db.ref("fault_report/" + faultId).set(report);

    // Update node status
    await db.ref("streetlight/" + streetlightId + "/status").set("Faulty");

    // Fan out a "Fault Alert" notification to every active user (Firebase).
    // A notification failure must not undo the already-persisted fault.
    try {
      await _dispatchFirebaseNotifications(
        report,
        "Fault Alert",
        _faultAlertMessage(report, node)
      );
    } catch (err) {
      console.error("Failed to create Fault Alert notifications:", err);
    }

    return report;
  }

  // ---------- Maintenance records ----------
  // Firebase node name is exactly "maintenance_record" (singular, per the ERD).
  // The mock dataset kept the same records under "maintenance_records"; the
  // working field names and the m### id convention are preserved unchanged:
  //   maintenance_id, fault_id, streetlight_id, user_id,
  //   repair_status, repair_date, remarks, acknowledged_at
  const MAINTENANCE_FIELDS = [
    "maintenance_id", "fault_id", "streetlight_id", "user_id",
    "repair_status", "repair_date", "remarks", "acknowledged_at"
  ];

  // Terminal (completion) repair status used by this application: the only
  // value present in the mock dataset, the value the maintenance history table
  // compares against ("resolved" pill) and the first option of the log form.
  const MAINTENANCE_COMPLETED_STATUS = "Completed";

  // Next m### id derived purely from the existing Firebase keys, preserving the
  // m001/m002... convention (no Firebase push IDs). Empty node -> "m001".
  async function _nextMaintenanceId() {
    const snapshot = await db.ref("maintenance_record").once("value");
    const nums = Object.keys(snapshot.val() || {})
      .map((id) => parseInt(String(id).replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return "m" + String(next).padStart(3, "0");
  }

  async function getMaintenanceRecords() {
    const snapshot = await db.ref("maintenance_record").once("value");

    const raw = snapshot.val() || {};

    // The current application passes no filter arguments and applies no
    // explicit sort, so none are invented here: records are returned as stored
    // (Firebase orders children by key — m001, m002, ... — which matches the
    // chronological m### sequence the mock dataset used).
    return Object.values(raw)
      .filter(Boolean);
  }

  async function addMaintenanceRecord(record) {
    const maintenanceId = await _nextMaintenanceId();
    record.maintenance_id = maintenanceId;

    // Persist only the known maintenance schema fields.
    const saved = {};
    MAINTENANCE_FIELDS.forEach((field) => {
      if (record[field] !== undefined) saved[field] = record[field];
    });

    // The referenced fault lives in Firebase fault_report; this function only
    // stores the fault_id link (the current app never read faults from mock
    // data here). Fault/user resolution is handled by the maintenance page via
    // the Firebase-backed getFaultReports()/getStreetlight() helpers.
    await db.ref("maintenance_record/" + maintenanceId).set(saved);

    return saved;
  }

  async function updateMaintenanceRecord(id, updates) {
    const ref = db.ref("maintenance_record/" + id);

    const snapshot = await ref.once("value");

    if (!snapshot.exists()) {
      return null;
    }

    const previous = snapshot.val() || {};

    // Apply only the fields the application actually supports.
    const patch = {};
    MAINTENANCE_FIELDS.forEach((field) => {
      if (updates && updates[field] !== undefined) patch[field] = updates[field];
    });

    if (Object.keys(patch).length) {
      await ref.update(patch);
    }

    const updated = { ...previous, ...patch };

    // Only a real transition into the terminal "Completed" status may resolve
    // the linked fault. resolveFaultReport() is the existing Firebase-aware
    // lifecycle (status, resolved_at, streetlight status, pending-hardware
    // check, Resolution notifications) — it is reused, never duplicated.
    const wasCompleted = previous.repair_status === MAINTENANCE_COMPLETED_STATUS;
    const isCompleted = updated.repair_status === MAINTENANCE_COMPLETED_STATUS;
    if (!wasCompleted && isCompleted && updated.fault_id) {
      try {
        await resolveFaultReport(updated.fault_id);
      } catch (err) {
        console.error("Failed to resolve fault for completed maintenance record:", err);
      }
    }

    return updated;
  }

  // ---------- Notifications ----------
  // Step 13 (notification privacy): never whole-node read /notification from a
  // non-admin session — the candidate hardened rules require non-admin reads
  // to be a Firebase query (orderByChild("user_id").equalTo(...)). No argument
  // resolves the target from the signed-in session: admins keep the full feed
  // (System Logs / full Notifications view); everyone else reads only their
  // own copies (the fan-out model already gives every active user a personal
  // record per event, so no content is lost). Return shape (array) and the
  // sent_at descending sort are unchanged.
  async function getNotifications(userId) {
    let target = userId || null;
    if (!target) {
      try {
        const role = sessionStorage.getItem("luminagrid_role");
        if (role && role !== "admin") {
          target = sessionStorage.getItem("luminagrid_user_id") || null;
        }
      } catch (_) {
        target = null; // no session context (tools/tests): legacy full read
      }
    }

    let snapshot;
    if (target) {
      snapshot = await db
        .ref("notification")
        .orderByChild("user_id")
        .equalTo(String(target))
        .once("value");
    } else {
      snapshot = await db.ref("notification").once("value");
    }

    const raw = snapshot.val() || {};

    let items = Object.values(raw)
      .filter(Boolean);

    if (target) {
      items = items.filter(
        (n) => String(n.user_id) === String(target)
      );
    }

    return items.sort(
      (a, b) =>
        new Date(b.sent_at) -
        new Date(a.sent_at)
    );
  }

  async function markNotificationRead(notificationId) {
    const ref = db.ref(
      "notification/" + notificationId
    );

    const snapshot = await ref.once("value");

    if (!snapshot.exists()) {
      return null;
    }
    const current = snapshot.val();
    // Step 13 revision: the candidate owner-write rule only permits the
    // Unread -> Read transition, so an already-Read record needs no write.
    if (current.status === "Read") {
      return current;
    }

    await ref.update({
      status: "Read"
    });

    return {
      ...current,
      status: "Read"
    };
  }

  // Step 13 revision: Mark-All-As-Read operates on the CURRENT user's own
  // notification copies only — even for admin (the sidebar badge / mark-all
  // must never touch another user's copies, only the full-feed admin VIEW
  // does that). It resolves the logged-in logical user_id from the session,
  // queries the user's own records via the same orderByChild path
  // getNotifications() uses, then flips each still-"Unread" copy to "Read"
  // with an individual RECORD-LEVEL write that changes ONLY status. Reuses
  // markNotificationRead() so all other fields (notification_id, fault_id,
  // notification_type, message, sent_at) are preserved exactly and already-Read
  // records are skipped. Returns the number of records updated (0 if none).
  async function markAllNotificationsRead(userId) {
    let target = userId || null;
    if (!target) {
      try {
        target = sessionStorage.getItem("luminagrid_user_id") || null;
      } catch (_) {
        target = null; // no session (tools/tests): nothing to mark
      }
    }
    if (!target) return 0;

    const notifs = await getNotifications(target);
    const unread = notifs.filter((n) => n.status === "Unread");
    let updated = 0;
    for (const n of unread) {
      await markNotificationRead(n.notification_id);
      updated += 1;
    }
    return updated;
  }

  async function getUnreadCount(userId) {
    let target = userId || null;
    if (!target) {
      // Step 13 revision: the badge is ALWAYS scoped to the current user's own
      // copies for EVERY role, including admin. Even though admin can read the
      // full feed, the unread badge must never count other users' copies.
      try {
        target = sessionStorage.getItem("luminagrid_user_id") || null;
      } catch (_) {
        target = null; // no session (tools/tests): fall back to full-feed read
      }
    }
    const notifs = await getNotifications(target);
    return notifs.filter((n) => n.status === "Unread").length;
  }

  // ---------- Users ----------
  // Firebase /user is keyed by the LuminaGrid LOGICAL user id (u001, u002, ...).
  // The Firebase Auth UID is stored separately as auth_uid and must never
  // replace the logical id referenced by notification.user_id and
  // maintenance_record.user_id. Passwords are NEVER stored here — credentials
  // exist only in Firebase Authentication.
  const USER_FIELDS = Object.freeze([
    "user_id", "auth_uid", "email", "first_name", "last_name",
    "role", "contact_number", "status", "created_at"
  ]);
  const USER_ACTIVE_STATUS = "Active";
  const USER_DEACTIVATED_STATUS = "Deactivated";

  // Copy only the allowed profile fields from a source object. Acts as the
  // single choke point that guarantees a "password" property (or any other
  // unknown field) can never be written to Realtime Database.
  function _pickUserFields(source) {
    const picked = {};
    USER_FIELDS.forEach((field) => {
      if (source && Object.prototype.hasOwnProperty.call(source, field)) {
        picked[field] = source[field];
      }
    });
    return picked;
  }

  // Next logical user id (u###) derived from existing FIREBASE /user keys
  // only: highest numeric suffix + 1, so gaps are handled correctly
  // (u001, u003 -> u004) and an empty node starts at u001. Never
  // keys.length + 1 and never a Firebase push id.
  function _nextUserId(raw) {
    const keys = Array.isArray(raw) ? raw : Object.keys(raw || {});
    let max = 0;
    keys.forEach((key) => {
      const match = /^u(\d+)$/i.exec(String(key));
      if (match) max = Math.max(max, parseInt(match[1], 10));
    });
    return "u" + String(max + 1).padStart(3, "0");
  }

  // SECONDARY Firebase app used solely to create accounts for other users.
  // The DEFAULT app's auth instance must never call
  // createUserWithEmailAndPassword — that would sign the currently
  // signed-in administrator out and sign in as the newly created user.
  // Prototype-only convenience: client-side account creation is NOT a
  // server-side admin-only security boundary (that would require the
  // Firebase Admin SDK / Cloud Functions, which this project does not have).
  const _CREATOR_APP_NAME = "UserCreator";
  function _getCreatorAuth() {
    const existing = firebase.apps.find((app) => app.name === _CREATOR_APP_NAME);
    const app = existing || firebase.initializeApp(firebaseConfig, _CREATOR_APP_NAME);
    return app.auth();
  }

  async function getUsers() {
    const snapshot = await db.ref("user").once("value");
    const raw = snapshot.val() || {};
    return Object.values(raw).filter(Boolean);
  }

  async function getUserByEmail(email) {
    const snapshot = await db.ref("user").once("value");
    const raw = snapshot.val() || {};
    const target = String(email || "").trim().toLowerCase();
    return (
      Object.values(raw).find(
        (user) => user && String(user.email || "").trim().toLowerCase() === target
      ) || null
    );
  }

  // Step 13 revision: read the internal authorization record for a Firebase
  // Auth UID — authz/{uid} = { user_id, role, status }. Rules-support node only.
  // Login/session use it to resolve auth.uid -> logical user_id -> user record
  // WITHOUT a whole-/user scan, which the candidate /user rules no longer grant
  // to every active user. Under hardened rules a missing or Deactivated entry
  // is read-DENIED; callers must treat a thrown error (PERMISSION_DENIED) as
  // "not provisioned / not active" and fall back or reject accordingly.
  async function getAuthz(authUid) {
    if (!authUid) return null;
    const snapshot = await db.ref("authz/" + String(authUid)).once("value");
    return snapshot.exists() ? snapshot.val() : null;
  }

  // Find a profile by its Firebase Auth UID link (the auth_uid field). This
  // is the primary key used to resolve a signed-in Firebase Auth user to the
  // LuminaGrid logical profile.
  async function getUserByAuthUid(authUid) {
    if (!authUid) return null;
    const snapshot = await db.ref("user").once("value");
    const raw = snapshot.val() || {};
    const target = String(authUid);
    return (
      Object.values(raw).find(
        (user) => user && String(user.auth_uid || "") === target
      ) || null
    );
  }

  // Persist the link between a Firebase Auth UID and the logical user id.
  // Used when a pre-existing profile signs in for the first time (profiles
  // created before Step 9 have no auth_uid yet). Best-effort and non-fatal.
  async function setAuthUid(userId, authUid) {
    const snapshot = await db.ref("user/" + String(userId)).once("value");
    if (!snapshot.exists()) return null;
    await db.ref("user/" + String(userId) + "/auth_uid").set(String(authUid));
    return { ...snapshot.val(), auth_uid: String(authUid) };
  }

  // Create BOTH a Firebase Authentication account and a /user profile.
  // The password is consumed ONLY by Firebase Auth (secondary "UserCreator"
  // app) and is never written to Realtime Database — see _pickUserFields.
  // The DEFAULT auth instance (the current administrator's session) is never
  // touched, so the signed-in admin stays signed in. If the profile write
  // fails after the Auth account was created, the new Auth user is deleted
  // again so no orphaned credential is left behind.
  async function addUser(user) {
    const input = user || {};
    const password = input.password;
    if (!password) {
      throw new Error("A password is required to create a sign-in account.");
    }

    // Generate the logical id from existing FIREBASE /user keys only.
    const existingSnapshot = await db.ref("user").once("value");
    const userId = _nextUserId(existingSnapshot.val() || {});

    const record = _pickUserFields(input);
    record.user_id = userId;
    record.status = record.status || USER_ACTIVE_STATUS;
    record.created_at = record.created_at || new Date().toISOString();
    if (!record.email) {
      throw new Error("An email address is required to create an account.");
    }

    const creatorAuth = _getCreatorAuth();
    let cred = null;
    try {
      cred = await creatorAuth.createUserWithEmailAndPassword(record.email, password);
      record.auth_uid = cred.user.uid;
    } catch (err) {
      // Firebase Auth rejected the request (email in use, weak password, ...).
      // Nothing was written to /user — sign the secondary instance out and
      // surface the failure.
      try { await creatorAuth.signOut(); } catch (_) { /* secondary was never signed in */ }
      throw err;
    }

    try {
      // Step 13: one atomic multi-path update provisions the /user profile AND
      // the internal /authz authorization record (rules-support only — the
      // logical u### id, all eight application schemas and the primary admin
      // session stay untouched). authz holds exactly {user_id, role, status};
      // the password never reaches Realtime Database. If this update fails the
      // existing rollback below still deletes the just-created Auth account.
      const writes = {};
      writes["user/" + userId] = record;
      writes["authz/" + record.auth_uid] = {
        user_id: userId,
        role: record.role,
        status: record.status
      };
      await db.ref().update(writes);
    } catch (err) {
      // Partial failure: the Auth account exists but the profile save failed.
      // Roll the Auth account back, sign the secondary instance out, then
      // report the failure clearly instead of pretending the user exists.
      try { if (cred && cred.user) await cred.user.delete(); } catch (_) { /* best effort */ }
      try { await creatorAuth.signOut(); } catch (_) { /* ignore */ }
      throw new Error(
        "The sign-in account was created, but the user profile could not be saved, so the account was rolled back. Please try again."
      );
    }

    // Always leave the secondary auth instance signed out; the primary
    // administrator session (DEFAULT auth instance) remains unchanged.
    try { await creatorAuth.signOut(); } catch (_) { /* ignore */ }
    return record;
  }

  // Soft-deactivate a profile: set /user/{userId}/status to the
  // application's inactive label. The profile itself, and every historical
  // notification/maintenance reference to it, is preserved (never deleted).
  // LIMITATION: the Firebase browser client SDK cannot disable another
  // account in Firebase Authentication — that requires the Admin SDK, which
  // this project does not have. Enforcement therefore happens in the app:
  // login rejects Deactivated profiles and session checks do the same.
  async function deactivateUser(userId) {
    const snapshot = await db.ref("user/" + String(userId)).once("value");
    if (!snapshot.exists()) return null;
    const profile = snapshot.val();
    // Step 13: mirror the status flip into /authz in the SAME atomic update as
    // the profile. The authz record is never deleted (historical references
    // stay intact) — only its status changes. Profiles that predate the
    // auth_uid link have no authz entry to mirror; the profile still flips and
    // the skipped sync is reported via console.warn.
    const writes = {};
    writes["user/" + String(userId) + "/status"] = USER_DEACTIVATED_STATUS;
    if (profile.auth_uid) {
      writes["authz/" + profile.auth_uid + "/status"] = USER_DEACTIVATED_STATUS;
    } else {
      console.warn(
        "[authz] status sync skipped for " + userId + ": profile has no auth_uid."
      );
    }
    await db.ref().update(writes);
    return { ...profile, status: USER_DEACTIVATED_STATUS };
  }

  async function getUserById(userId) {
    const snapshot = await db.ref("user/" + String(userId)).once("value");
    return snapshot.exists() ? snapshot.val() : null;
  }

  // Partial update of an existing user's own profile. Only the caller's own
  // record should ever be passed here (enforced by js/profile.js using the
  // user_id stored in sessionStorage at login).
  // Allowlist: only the profile fields the current application actually
  // edits. "password" is never allowed (not a profile field — Firebase Auth
  // owns credentials), and "email" is excluded because writing it to /user
  // alone would desync the Firebase Auth login email (changing another
  // account's Auth email requires the Admin SDK — see migration report).
  async function updateUser(userId, updates) {
    const snapshot = await db.ref("user/" + String(userId)).once("value");
    if (!snapshot.exists()) return null;
    const current = snapshot.val();
    const patch = {};
    ["first_name", "last_name", "contact_number"].forEach((field) => {
      if (updates && Object.prototype.hasOwnProperty.call(updates, field)) {
        patch[field] = updates[field];
      }
    });
    if (Object.keys(patch).length > 0) {
      await db.ref("user/" + String(userId)).update(patch);
    }
    return { ...current, ...patch };
  }

  // ---------- Energy aggregation ----------
  // power_consumption is INSTANTANEOUS power in Watts — it is NOT kWh. The
  // correct, integrated daily energy is computed by the trusted Admin SDK
  // backend worker (backend/energy-worker.js), which stores today's running
  // total at energy_monthly/{YYYY-MM}/today/{YYYY-MM-DD}. That lives INSIDE the
  // current monthly record — an existing CLIENT-READABLE aggregate — so the
  // browser never touches the private backend_state node nor a forbidden
  // energy_daily path (both are default-deny under the deployed rules). If no
  // daily aggregate exists yet this returns 0; it never fabricates a value.
  async function getTotalKwhToday() {
    const now = Date.now();
    const monthKey = _manilaMonthKey(now);
    const dayKey = _manilaDayKey(now);
    const snap = await db
      .ref("energy_monthly/" + monthKey + "/today/" + dayKey)
      .once("value");
    const val = snap.val();
    return typeof val === "number" ? val : 0;
  }

  // Asia/Manila calendar day key (YYYY-MM-DD) for a given epoch ms.
  function _manilaDayKey(ms) {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const p = Object.fromEntries(
      dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}`;
  }

  // Asia/Manila calendar month key (YYYY-MM) for a given epoch ms.
  function _manilaMonthKey(ms) {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit"
    });
    const p = Object.fromEntries(
      dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}`;
  }

  // Public: current (or given) Asia/Manila billing month key, e.g. "2026-10".
  function getManilaMonthKey(ms) {
    return _manilaMonthKey(ms == null ? Date.now() : ms);
  }

  // Step 11: the final data node. energy_monthly is read-only seeded
  // history — the exact dataset formerly served by data/mock-nodes.json
  // now lives at the Firebase /energy_monthly node (flat object keyed by
  // "YYYY-MM", each record { month, total_kwh, cost }, numeric types
  // preserved). No filtering, sorting or transformation is applied, and
  // no mock fallback remains.
  async function getMonthlyEnergy() {
    const snapshot = await db.ref("energy_monthly").once("value");
    return snapshot.val() || {};
  }

  // ---------- System config ----------
  // Step 10: /system_config lives in Firebase Realtime Database as a FLAT
  // object — the exact field names, values and types of the former
  // data/mock-nodes.json "system_config" block are preserved unchanged
  // (no wrapper object, no per-user/per-streetlight nesting).
  const SYSTEM_CONFIG_FIELDS = [
    "energy_rate_per_kwh",
    "current_threshold_high",
    "current_threshold_low",
    "voltage_threshold_low",
    "heartbeat_timeout_minutes",
    "dusk_lux_threshold",
    "dawn_lux_threshold"
  ];

  // Read the complete config from Firebase. When the node is absent the
  // same safe fallback as before is returned ({}), and every caller applies
  // its own already-documented default (e.g. _enrich() falls back to
  // heartbeat_timeout_minutes = 10, energy-data.js to 13.60 per kWh, the
  // thresholds modal keeps its HTML defaults). Never falls back to
  // mock-nodes.json after Step 10.
  async function getSystemConfig() {
    const snapshot = await db.ref("system_config").once("value");
    return snapshot.val() || {};
  }

  // Merge `updates` into the stored config and return the complete updated
  // object — same signature and return behavior as the mock implementation.
  // Allowlist: only known configuration fields are written; unknown keys are
  // ignored, so UI input can never invent new config fields. A multi-path
  // update() touches only the provided allowlisted keys, so unrelated config
  // values are never overwritten, and values are written exactly as supplied
  // (number/boolean/string types preserved — numbers never become strings).
  async function updateSystemConfig(updates) {
    const snapshot = await db.ref("system_config").once("value");
    const current = snapshot.val() || {};
    const patch = {};
    SYSTEM_CONFIG_FIELDS.forEach((field) => {
      if (updates && Object.prototype.hasOwnProperty.call(updates, field)) {
        patch[field] = updates[field];
      }
    });
    if (Object.keys(patch).length > 0) {
      await db.ref("system_config").update(patch);
    }
    return { ...current, ...patch };
  }

  return {
    getStreetlights, getStreetlight, upsertStreetlight, tickHeartbeat, markNodeActive,
    getLatestReading, getAllReadings,
    getFaultReports, reportFault, resolveFaultReport,
    getMaintenanceRecords, addMaintenanceRecord, updateMaintenanceRecord,
    getNotifications, markNotificationRead, markAllNotificationsRead, getUnreadCount,
    getUsers, getUserByEmail, getUserById, getUserByAuthUid, setAuthUid, getAuthz,
    addUser, deactivateUser, updateUser,
    getTotalKwhToday, getMonthlyEnergy,
    getManilaMonthKey,
    getSystemConfig, updateSystemConfig
  };
})();
