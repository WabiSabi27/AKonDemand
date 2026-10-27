/**
 * AK On Demand — locked type scale.
 *
 * Five sizes only. Pick the closest semantic role and use the named token
 * instead of a raw `fontSize: N` literal so the scale stays tight as the
 * app grows.
 *
 *   display   28   Hero numbers, splash titles, big in-screen totals
 *   h1        22   Screen titles, primary section headers
 *   h2        18   Card titles, sub-section headers
 *   body      15   Default running text, list-row primary content
 *   caption   12   Meta text, labels, badges, helper / muted copy
 *
 * Existing StyleSheet objects use raw numbers — those have been snapped to
 * the scale via a one-time sweep. Any NEW UI code should reference these
 * constants:
 *
 *   import { TYPE } from "@/constants/typography";
 *   const styles = StyleSheet.create({
 *     title:   { fontSize: TYPE.h1,   fontWeight: "800" },
 *     body:    { fontSize: TYPE.body, fontWeight: "500" },
 *     caption: { fontSize: TYPE.caption, color: colors.mutedForeground },
 *   });
 *
 * Snap rule when in doubt: round to the NEAREST scale value, preferring
 * down for values that fall exactly between two steps.
 */
export const TYPE = {
  display: 28,
  h1: 22,
  h2: 18,
  body: 15,
  caption: 12,
} as const;

export type TypeSize = keyof typeof TYPE;

/**
 * Suggested line-heights paired with each size. Use when a Text needs
 * tight or loose leading; React Native does not auto-derive lineHeight
 * from fontSize.
 */
export const LINE_HEIGHT = {
  display: 34,
  h1: 28,
  h2: 24,
  body: 21,
  caption: 16,
} as const;

/**
 * Common font-weight values used across the app, named for clarity.
 * (React Native takes string weights.)
 *
 * WEIGHT RULE — keep the hierarchy legible:
 *   • `WEIGHT.black` ("900") is reserved for HERO titles only — i.e.
 *     `TYPE.display`-sized text on a splash, role-select hero card, or
 *     dashboard top-bar that owns the screen. There should only be one
 *     "900" per screen at most.
 *   • Every other heading (h1/h2 screen titles, card titles, money
 *     values, badges) uses `WEIGHT.bold` ("700") or lighter. Using "900"
 *     everywhere flattens hierarchy and makes the hero feel ordinary.
 *   • `WEIGHT.heavy` ("800") is fine for emphasis inside body copy or for
 *     primary CTA labels — sparingly.
 */
export const WEIGHT = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  heavy: "800",
  black: "900",
} as const;
