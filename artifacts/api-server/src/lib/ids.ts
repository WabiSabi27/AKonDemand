import { randomBytes } from "node:crypto";

/**
 * Generate a short unique id with a typed prefix, e.g. `bk_abc123def456`.
 * Uses crypto-random base36 — collision probability with 10 chars is ~1 in 3.6e15.
 */
export function genId(prefix: string): string {
  const random = randomBytes(8).toString("hex").slice(0, 12);
  return `${prefix}_${random}`;
}
