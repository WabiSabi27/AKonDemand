/**
 * TD-4 — Vitest global setup.
 *
 * Boots a smoke check against the shared dev/CI Postgres so a missing schema
 * fails LOUDLY at the top of the run instead of as a confusing "relation does
 * not exist" deep inside a test. We rely on the api-server workflow's own
 * boot migrations (see `src/index.ts`) to have created the tables — the test
 * harness intentionally does NOT re-run them so we never accidentally mutate
 * production schema in a CI environment.
 *
 * Test isolation strategy: every test inserts data with id/email prefixes
 * starting with `TEST_PREFIX`, and `helpers.ts::cleanupTestData()` deletes by
 * that prefix in afterAll. We do NOT use per-test transactions because the
 * Express handlers open their own connections via the singleton `db` and
 * we'd have to rewire the entire app to thread a tx around.
 */

import { beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { cleanupTestData, TEST_PREFIX } from "./helpers";

// Ensure SESSION_SECRET is present before importing anything that touches auth.
if (!process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET must be set for the test harness (the api-server workflow needs it too).",
  );
}

beforeAll(async () => {
  // Smoke-check that the schema exists. If the api-server workflow has never
  // run against this DB, these tables won't be there and every test would
  // fail with a confusing pg error.
  const requiredTables = [
    "users",
    "businesses",
    "categories",
    "stripe_webhook_dead_letter",
  ];
  for (const t of requiredTables) {
    const r = await db.execute(
      sql`SELECT to_regclass(${`public.${t}`})::text AS exists`,
    );
    const row = r.rows[0] as { exists: string | null } | undefined;
    if (!row || row.exists === null) {
      throw new Error(
        `Required table public.${t} is missing. Start the api-server workflow at least once to run boot migrations, then re-run the tests.`,
      );
    }
  }
  // Pre-clean any leftovers from a previously-aborted run.
  await cleanupTestData();
  // eslint-disable-next-line no-console
  console.log(`[test-setup] schema OK; using TEST_PREFIX=${TEST_PREFIX}`);
});

afterAll(async () => {
  await cleanupTestData();
});
