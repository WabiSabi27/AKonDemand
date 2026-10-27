export const SPECIALTY_OPTIONS: Record<string, string[]> = {
  landscaping: ["Garden Design", "Landscape Design", "Lawn Care", "Seasonal Planting", "Tree Trimming", "Irrigation", "Snow Removal", "Hardscaping"],
  cleaning: ["Residential Cleaning", "Commercial Cleaning", "Deep Clean", "Move-In/Out Clean", "Post-Construction", "Window Washing", "Carpet Cleaning"],
  painting: ["Interior Painting", "Exterior Painting", "Cabinet Refinishing", "Deck Staining", "Texture Coating", "Mural Work", "Pressure Washing"],
  fence: ["Wood Fencing", "Chain Link", "Vinyl Fencing", "Gate Installation", "Fence Repair", "Privacy Screening", "Electric Gates"],
  roof: ["Leak Repair", "Shingle Replacement", "Flat Roofing", "Metal Roofing", "Storm Damage", "Gutters", "Skylight Install"],
  moving: ["Local Moving", "Long Distance", "Packing Services", "Furniture Assembly", "Storage", "Piano Moving", "Commercial Moving"],
};

export const FALLBACK_SPECIALTIES = [
  "General Services", "Consultation", "Emergency Services", "Maintenance", "Installation", "Repair", "Inspection",
];

export function getSpecialtiesForCategory(categoryId: string | undefined | null): string[] {
  if (!categoryId) return FALLBACK_SPECIALTIES;
  return SPECIALTY_OPTIONS[categoryId] ?? FALLBACK_SPECIALTIES;
}

// Parse a service-option duration string ("2 hrs", "Half day", "45 min", etc.) into minutes.
// Returns null for ongoing services (weekly/monthly/seasonal).
export function parseDurationMinutes(d: string | undefined): number | null {
  if (!d) return null;
  const dur = d.toLowerCase().trim();
  if (dur.includes("full day")) return 480;
  if (dur.includes("half day")) return 240;
  if (dur.includes("monthly") || dur.includes("weekly") || dur.includes("seasonal")) return null;
  const rangeHr = dur.match(/^(\d+)-\d+\s*hr/);
  if (rangeHr) return parseInt(rangeHr[1], 10) * 60;
  const hrMatch = dur.match(/(\d+\.?\d*)\s*hr/);
  if (hrMatch) return Math.round(parseFloat(hrMatch[1]) * 60);
  const minMatch = dur.match(/(\d+)\s*min/);
  if (minMatch) return parseInt(minMatch[1], 10);
  return null;
}

// Convert "8:00 AM" / "12:30 PM" → "08:00" / "12:30" (24-hour HH:MM).
export function to24Hour(t: string): string {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = (m[3] ?? "").toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/**
 * Per-option slot collapsing for the customer's time-picker.
 *
 * The server returns the full 30-min grid for a SERVICE (because services may
 * have a mix of short + long options). On the customer side we narrow that
 * grid down to what's reasonable for the SPECIFIC option the customer just
 * picked:
 *
 *   - If the option has an explicit pinned start (its own `defaultStartTime`,
 *     or "08:00" implicitly for ≥8h "Full day" options), keep just that slot.
 *   - Otherwise, if the option has a finite duration, collapse to two slots:
 *     the first slot in the morning (< 12:00) and the first slot at-or-after
 *     12:00 — i.e. an AM and a PM choice. Booking a 2-hour or 4-hour job
 *     doesn't need an eleven-pill 30-minute grid; AM-or-PM is enough granularity.
 *   - Otherwise (ongoing / no duration), keep the raw list unchanged.
 *
 * `optionPinnedStart` is "HH:MM" 24-hour or null. `slots` items must have a
 * 24-hour `time` field — anything else this helper does not own.
 */
export function pickCustomerSlots<T extends { time: string }>(
  rawSlots: readonly T[],
  durationMin: number | null,
  optionPinnedStart: string | null,
): T[] {
  if (optionPinnedStart) {
    return rawSlots.filter((s) => s.time === optionPinnedStart);
  }
  if (durationMin === null) {
    return [...rawSlots];
  }
  const NOON = 12 * 60;
  const am = rawSlots.find((s) => timeStrToMinutes(s.time) < NOON);
  const pm = rawSlots.find((s) => timeStrToMinutes(s.time) >= NOON);
  // De-dupe in case the SP only opens after noon (no AM) or closes by noon
  // (no PM) — return whichever one(s) exist, in chronological order.
  const picked: T[] = [];
  if (am) picked.push(am);
  if (pm && pm !== am) picked.push(pm);
  return picked;
}

/**
 * Canonical customer-facing date format for the app: `MM-DD-YY` (with dashes).
 *
 * Accepts either a `YYYY-MM-DD` plain-date string (the format `scheduledDate`
 * is stored in on the server, and the format `availability.date` query params
 * use) or anything `new Date()` will parse (ISO timestamps, etc.). The fast
 * path for `YYYY-MM-DD` is important: `new Date("2025-10-15")` parses as UTC
 * midnight, which renders as the previous day in negative-offset US timezones
 * — splitting the string ourselves avoids that footgun for the *very* case
 * where it bites the most (booking dates for an Alaska-based marketplace).
 *
 * Returns the input unchanged if it can't be parsed, so a malformed value
 * never silently becomes "NaN-NaN-NaN" on the screen.
 */
export function formatDateMMDDYY(input: string): string {
  const ymd = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[2]}-${ymd[3]}-${ymd[1].slice(2)}`;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}-${dd}-${yy}`;
}

// "08:30" → 510 (minutes since midnight)
export function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

// 510 → "08:30"
export function minutesToTimeStr(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 510 → "8:30 AM"
export function minutesToTimeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}
