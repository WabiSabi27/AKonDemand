import { appendFileSync } from "node:fs";

export function trace(event: string, details: object = {}) {
  const file = process.env.AUDIT_FIXTURE_TRACE;
  if (!file || process.env.NODE_ENV !== "test") {
    throw new Error("Audit fixtures require an isolated test invocation");
  }
  appendFileSync(file, `${JSON.stringify({ event, ...details })}\n`);
}

export function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const value = current as { code?: string; cause?: unknown };
    if (value.code) return value.code;
    current = value.cause;
  }
  return undefined;
}
