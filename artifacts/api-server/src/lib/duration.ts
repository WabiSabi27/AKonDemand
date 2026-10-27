/**
 * Parse a freeform duration string from `service_options.duration` into minutes.
 *
 * Accepted formats (case-insensitive):
 *   "30 min", "45 minutes"        → 30, 45
 *   "1 hr", "2 hrs", "1 hour"     → 60, 120, 60
 *   "1.5 hrs"                     → 90
 *   "Half day"                    → 240
 *   "Full day", "All day"         → 480
 *
 * Returns `null` if the string can't be parsed; callers should default to 60.
 */
export function parseDurationToMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (s === "half day") return 240;
  if (s === "full day" || s === "all day") return 480;

  const m = /^(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(value)) return null;
  if (unit.startsWith("min")) return Math.round(value);
  return Math.round(value * 60);
}
