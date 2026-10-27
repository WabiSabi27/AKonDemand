/**
 * AK On Demand — locked brand palette and surface rule.
 *
 * These five colors are the canonical brand. Any new UI code in the mobile
 * app should reference `BRAND.*` rather than re-typing the hex literal so a
 * future re-skin only changes this file.
 *
 *   GOLD          #FFB300   Money / premium / admin                 (Material Amber 600)
 *   NAVY (deep)   #0F1B2D   App background, body text on light surfaces
 *   NAVY (light)  #1A1F2E   Card/sheet/modal surfaces on the dark background
 *   INDIGO        #5C6BC0   Service-Provider (SP) surfaces & CTAs   (Material Indigo 400)
 *   RED-VIOLET    #AB47BC   Customer surfaces & CTAs                (Material Purple 400)
 *
 * SURFACE RULE — assign accents by audience, not by personal preference:
 *   • SP screens (business-tabs, business-dashboard, business-portal,
 *     business-earnings, the SP application wizard, payment-return):
 *     primary accent = INDIGO.
 *   • Customer screens (tabs/, service/[id], checkout, messages,
 *     cancel-booking, refund-request, review, BookingCard, customer
 *     notifications): primary accent = RED-VIOLET. These screens import
 *     `BRAND.redViolet` directly — they do NOT use `colors.accent`
 *     (which defaults to indigo to keep SP-leaning legacy components
 *     unchanged).
 *   • Admin screens (admin-tabs, admin-audit-log, admin-stripe-webhooks)
 *     AND any money value or premium badge anywhere (fees, earnings,
 *     payouts, plan cost): GOLD.
 *
 * Status colors (success/danger/warning) live in `SEMANTIC` and are NOT
 * brand-bound — they should look the same on every surface so users learn
 * them once.
 */
export const BRAND = {
  gold: "#FFB300",
  navyDeep: "#0F1B2D",
  navyLight: "#1A1F2E",
  indigo: "#5C6BC0",
  redViolet: "#AB47BC",
} as const;

export type BrandColor = keyof typeof BRAND;

/**
 * Common semantic shades that pair with the brand palette. These are NOT
 * brand colors but are reused enough to centralize.
 */
export const SEMANTIC = {
  success: "#B39DDB", // Light violet — used for "approved/completed/active" states
  successDeep: "#7E57C2", // Deep purple — darker companion to SEMANTIC.success
  danger: "#F44336",
  warning: "#FFB300", // alias of BRAND.gold (warnings share gold)
  white: "#FFFFFF",
  textMuted: "rgba(255,255,255,0.6)",
  textSubtle: "rgba(255,255,255,0.35)",
  surfaceBorder: "rgba(255,255,255,0.12)",
  surfaceFill: "rgba(255,255,255,0.06)",
} as const;

/**
 * Legacy shadcn-style palette retained for any component that already imports
 * `colors.light.*`. New code should prefer `BRAND` / `SEMANTIC`. The accent
 * tokens here have been re-pointed at the locked brand palette so the legacy
 * surface stays in sync with the rebrand.
 */
const colors = {
  light: {
    text: BRAND.navyDeep,
    // `tint` historically maps to the SP/indigo accent because most legacy
    // shared components live on SP-leaning surfaces. Customer screens
    // override the active-tint with BRAND.redViolet at the call site.
    tint: BRAND.indigo,

    background: "#FAFAF8",
    foreground: BRAND.navyDeep,

    card: "#FFFFFF",
    cardForeground: BRAND.navyDeep,

    primary: BRAND.navyDeep,
    primaryForeground: "#FFFFFF",

    secondary: "#F0F4F8",
    secondaryForeground: BRAND.navyDeep,

    muted: "#F0F4F8",
    mutedForeground: "#6B7A8D",

    // `accent` defaults to INDIGO so legacy SP-leaning components keep
    // their look without code changes. Customer screens MUST NOT use
    // `colors.accent` — import `BRAND.redViolet` and reference it
    // explicitly so the SURFACE RULE is enforced. See top-of-file comment.
    accent: BRAND.indigo,
    accentForeground: "#FFFFFF",

    destructive: SEMANTIC.danger,
    destructiveForeground: "#FFFFFF",

    border: "#E8EDF2",
    input: "#E8EDF2",

    star: BRAND.gold,
    success: SEMANTIC.success,
    overlay: "rgba(15,27,45,0.55)",
  },
  radius: 12,
};

export default colors;
