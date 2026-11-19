// Shared ESP32 wall-clock policy for browser displays and the fault worker.
// Freshness windows belong to callers; this only validates and measures time.
const TelemetryTime = (() => {
  const CLOCK_SKEW_TOLERANCE_MS = 15000;

  function parseTelemetryTimestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return NaN;
    const canonical = value.length === 20 ? value.slice(0, -1) + ".000Z" : value;
    return new Date(ms).toISOString() === canonical ? ms : NaN;
  }

  function timestampAge(value, nowMs = Date.now()) {
    const parsedMs = parseTelemetryTimestamp(value);
    const rawAgeMs = nowMs - parsedMs;
    // Only a bounded future skew becomes age zero. Invalid or far-future
    // timestamps remain unusable; past ages and timeout boundaries are intact.
    const effectiveAgeMs = Number.isFinite(rawAgeMs) && rawAgeMs >= -CLOCK_SKEW_TOLERANCE_MS
      ? Math.max(0, rawAgeMs) : NaN;
    return { parsedMs, rawAgeMs, effectiveAgeMs };
  }

  return Object.freeze({ CLOCK_SKEW_TOLERANCE_MS, parseTelemetryTimestamp, timestampAge });
})();

if (typeof module !== "undefined" && module.exports) module.exports = TelemetryTime;
