export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
  xxxl: 48,
  huge: 64,
  giant: 80,
} as const;

export const SPACING_HALF = {
  s12: 12,
  s20: 20,
} as const;

export type SpacingKey = keyof typeof SPACING;
