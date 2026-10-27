/**
 * Mobile-side helpers for the cancellation policy (Phase 3 #7). Mirrors the
 * server-side `lib/cancellation.ts` logic, but kept separate to avoid pulling
 * a server lib into the mobile bundle. Only used for display — the
 * authoritative refund math is computed server-side and returned by
 * GET /bookings/{id}/cancellation-quote.
 */

export interface CancellationPolicy {
  fullRefundHours: number;
  partialRefundHours: number;
  partialRefundPercent: number;
}

const DEFAULT_POLICY: CancellationPolicy = {
  fullRefundHours: 24,
  partialRefundHours: 2,
  partialRefundPercent: 50,
};

/** Pull the policy off a Business object, falling back to defaults. */
export function policyFromBusiness(b: {
  cancellationFullRefundHours?: number | null;
  cancellationPartialRefundHours?: number | null;
  cancellationPartialRefundPercent?: number | null;
} | null | undefined): CancellationPolicy {
  return {
    fullRefundHours: b?.cancellationFullRefundHours ?? DEFAULT_POLICY.fullRefundHours,
    partialRefundHours: b?.cancellationPartialRefundHours ?? DEFAULT_POLICY.partialRefundHours,
    partialRefundPercent: b?.cancellationPartialRefundPercent ?? DEFAULT_POLICY.partialRefundPercent,
  };
}

function fmtHours(h: number): string {
  if (h >= 24 && h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? "1 day" : `${d} days`;
  }
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** Single-line summary suitable for service detail / checkout. */
export function describePolicy(p: CancellationPolicy): string {
  if (p.partialRefundPercent === 0 || p.partialRefundHours >= p.fullRefundHours) {
    return `Free cancellation up to ${fmtHours(p.fullRefundHours)} before. No refund inside that window.`;
  }
  return `Free cancellation ${fmtHours(p.fullRefundHours)}+ before · ${p.partialRefundPercent}% refund within ${fmtHours(p.fullRefundHours)} · No refund within ${fmtHours(p.partialRefundHours)}.`;
}

/** Multi-line, bullet-style breakdown for the cancel-confirmation screen. */
export function policyBullets(p: CancellationPolicy): { tier: "full" | "partial" | "none"; label: string }[] {
  const out: { tier: "full" | "partial" | "none"; label: string }[] = [
    { tier: "full", label: `${fmtHours(p.fullRefundHours)} or more before — Full refund` },
  ];
  if (p.partialRefundPercent > 0 && p.partialRefundHours < p.fullRefundHours) {
    out.push({
      tier: "partial",
      label: `Within ${fmtHours(p.fullRefundHours)} of start — ${p.partialRefundPercent}% refund`,
    });
  }
  out.push({
    tier: "none",
    label: `Within ${fmtHours(p.partialRefundHours)} of start — No refund`,
  });
  return out;
}
