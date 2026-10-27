/** Convert "HH:MM" 24h string to minutes since midnight. Returns 0 on bad input. */
export function timeToMinutes(time: string | null | undefined): number {
  if (!time) return 0;
  const [hh, mm] = time.split(":").map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

/** Format minutes-since-midnight back to "HH:MM" 24h. */
export function minutesToTime(min: number): string {
  const hh = Math.floor(min / 60).toString().padStart(2, "0");
  const mm = (min % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Mirror of mobile parseDurationMinutes — accepts "30 min", "2 hrs", "Half day", etc. */
export function parseDurationMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const d = duration.trim().toLowerCase();
  if (d === "full day") return 8 * 60;
  if (d === "half day") return 4 * 60;
  if (d.includes("week") || d.includes("month") || d.includes("season")) return null;

  const m = d.match(/^(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "min";
  if (unit.startsWith("hr") || unit.startsWith("hour")) return Math.round(n * 60);
  return Math.round(n);
}
