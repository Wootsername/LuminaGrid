// Pure input validation and allowlisted diagnostics. No Firebase or environment reads.
const { timestampAge } = require("../js/telemetry-time");

const scalar = value => value == null ? null :
  ["string", "number", "boolean"].includes(typeof value) ? value : "[non-scalar]";

function inspectEnergyInputs(state, readings, nowMs, maxGapMs) {
  const stateTime = timestampAge(state && state.last_timestamp, nowMs);
  const stateUsable = !!state && Number.isFinite(stateTime.effectiveAgeMs) &&
    Number.isFinite(state.last_power_w) && state.last_power_w >= 0;
  const fields = {
    state_exists: !!state,
    state_last_reading_id: scalar(state && state.last_reading_id),
    state_last_timestamp: scalar(state && state.last_timestamp),
    state_last_timestamp_valid: Number.isFinite(stateTime.parsedMs),
    state_timestamp_usable: Number.isFinite(stateTime.effectiveAgeMs),
    state_baseline_usable: stateUsable,
    state_last_power_w: scalar(state && state.last_power_w),
    candidate_count: (readings || []).length, valid_candidate_count: 0,
    rejected_candidate_count: 0, invalid_timestamp_count: 0,
    legacy_timestamp_count: 0, future_timestamp_count: 0,
    invalid_power_count: 0, duplicate_or_old_count: 0,
    gap_over_60s_count: 0, zero_energy_interval_count: 0,
    new_readings_after_cursor: 0,
    oldest_candidate_timestamp: null, newest_candidate_timestamp: null
  };
  const valid = [];
  for (const r of readings || []) {
    const time = timestampAge(r && r.timestamp, nowMs);
    if (!Number.isFinite(time.parsedMs)) {
      fields.invalid_timestamp_count++;
      if (typeof r?.timestamp === "string" && r.timestamp.startsWith("uptime-")) fields.legacy_timestamp_count++;
    } else if (!Number.isFinite(time.effectiveAgeMs)) {
      fields.future_timestamp_count++;
    } else if (!Number.isFinite(r.power_consumption) || r.power_consumption < 0) {
      fields.invalid_power_count++;
    } else {
      valid.push({ ...r, ts: time.parsedMs });
    }
  }
  valid.sort((a, b) => a.ts - b.ts);
  fields.valid_candidate_count = valid.length;
  fields.rejected_candidate_count = fields.candidate_count - valid.length;
  fields.oldest_candidate_timestamp = valid[0]?.timestamp ?? null;
  fields.newest_candidate_timestamp = valid.at(-1)?.timestamp ?? null;
  // With no usable cursor, the worker must establish a baseline, not replay history.
  let prevTs = stateUsable ? stateTime.parsedMs : null;
  let prevPower = stateUsable ? state.last_power_w : null;
  for (const r of valid) {
    if (Number.isFinite(stateTime.parsedMs) && r.ts > stateTime.parsedMs) fields.new_readings_after_cursor++;
    if (prevTs !== null) {
      if (r.ts <= prevTs) { fields.duplicate_or_old_count++; continue; }
      if (r.ts - prevTs > maxGapMs) fields.gap_over_60s_count++;
      else if (prevPower === 0 && r.power_consumption === 0) fields.zero_energy_interval_count++;
    }
    prevTs = r.ts;
    prevPower = r.power_consumption;
  }
  return { stateUsable, stateTime, valid, fields };
}

module.exports = { inspectEnergyInputs };
