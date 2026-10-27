/**
 * Cancellation policy math (Phase 3 #7).
 *
 * Three tiers, evaluated against hours-until-scheduled at the moment the
 * customer cancels:
 *   hoursUntil >= fullRefundHours    → 100% refund
 *   hoursUntil >= partialRefundHours → partialRefundPercent% refund
 *   else                             → 0% refund
 *
 * The booking row carries a SNAPSHOT of the policy from the time it was
 * created, so SP edits don't retroactively change refund amounts on
 * in-flight bookings. Legacy bookings (snapshot fields null) fall back to
 * the business's current policy at compute time.
 */

const TZ = "America/Juneau";

/** UTC epoch ms for "YYYY-MM-DD" + "HH:MM" interpreted in America/Juneau. */
export function juneauWallClockToEpochMs(dateYMD: string, timeHM: string | null): number {
  const [y, m, d] = dateYMD.split("-").map(Number);
  const [hh, mm] = (timeHM ?? "00:00").split(":").map(Number);
  // Build a guess in UTC, then correct for Juneau's offset at that moment.
  // Juneau observes AKST (UTC-9) and AKDT (UTC-8); we ask Intl what the
  // offset actually is on this date instead of hard-coding DST rules.
  const guessUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  // Intl returns the wall-clock-as-string in the target TZ for an instant.
  // Diff between (the-instant-as-it-reads-in-Juneau) and (the-instant-as-UTC)
  // gives us the offset in minutes for that instant.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(guessUtc));
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  const asJuneauUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour) % 24,
    Number(byType.minute),
  );
  const offsetMs = guessUtc - asJuneauUtc; // how far Juneau is BEHIND UTC
  return guessUtc + offsetMs;
}

export interface CancellationPolicy {
  fullRefundHours: number;
  partialRefundHours: number;
  partialRefundPercent: number;
}

export type CancellationTier = "full" | "partial" | "none";

export interface CancellationQuote {
  refundCents: number;
  tier: CancellationTier;
  hoursUntilScheduled: number;
  policy: CancellationPolicy;
}

/**
 * Resolve the policy that applies to a booking. Prefers the booking's
 * snapshot; falls back to the business's live policy when the snapshot is
 * null (pre-Phase-3-#7 rows).
 */
export function resolvePolicy(args: {
  bookingFullRefundHours: number | null;
  bookingPartialRefundHours: number | null;
  bookingPartialRefundPercent: number | null;
  businessFullRefundHours: number;
  businessPartialRefundHours: number;
  businessPartialRefundPercent: number;
}): CancellationPolicy {
  return {
    fullRefundHours: args.bookingFullRefundHours ?? args.businessFullRefundHours,
    partialRefundHours: args.bookingPartialRefundHours ?? args.businessPartialRefundHours,
    partialRefundPercent: args.bookingPartialRefundPercent ?? args.businessPartialRefundPercent,
  };
}

/**
 * Pure cancellation math. Caller supplies the totalCents (full price the
 * customer paid) and the policy. `now` defaults to Date.now() — pass an
 * explicit value in tests for determinism.
 */
export function computeCancellationQuote(args: {
  scheduledDate: string;
  scheduledTime: string | null;
  totalCents: number;
  policy: CancellationPolicy;
  now?: Date;
}): CancellationQuote {
  const now = args.now ?? new Date();
  const scheduledMs = juneauWallClockToEpochMs(args.scheduledDate, args.scheduledTime);
  const hoursUntilScheduled = (scheduledMs - now.getTime()) / 3_600_000;

  let tier: CancellationTier = "none";
  let refundCents = 0;

  if (hoursUntilScheduled >= args.policy.fullRefundHours) {
    tier = "full";
    refundCents = args.totalCents;
  } else if (hoursUntilScheduled >= args.policy.partialRefundHours) {
    tier = "partial";
    // Floor so we never refund more than the percentage allows. Stripe rejects
    // partial-refund amounts greater than the original charge.
    refundCents = Math.floor((args.totalCents * args.policy.partialRefundPercent) / 100);
  }

  return {
    refundCents,
    tier,
    hoursUntilScheduled,
    policy: args.policy,
  };
}

/** Human-readable one-liner for service detail / checkout screens. */
export function describePolicy(p: CancellationPolicy): string {
  const fmtH = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24}d` : `${h}h`);
  if (p.partialRefundPercent === 0 || p.partialRefundHours >= p.fullRefundHours) {
    return `Free cancellation up to ${fmtH(p.fullRefundHours)} before — no refund inside that window.`;
  }
  return `Free cancellation up to ${fmtH(p.fullRefundHours)} before · ${p.partialRefundPercent}% refund within ${fmtH(p.fullRefundHours)} · No refund within ${fmtH(p.partialRefundHours)}.`;
}
