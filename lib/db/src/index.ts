import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// Claims stay open while recovery handlers use the normal pool. Keep their
// connection budget separate so claims cannot starve the queries they await.
// The caller must also bound admission before opening a transaction, rather
// than queue retries behind these long-lived connections.
export const DEAD_LETTER_CLAIM_LIMIT = 2;
export const deadLetterClaimPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: DEAD_LETTER_CLAIM_LIMIT,
  connectionTimeoutMillis: 5_000,
});
export const deadLetterClaimDb = drizzle(deadLetterClaimPool, { schema });

export * from "./schema";
