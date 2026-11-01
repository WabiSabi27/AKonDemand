import { pool as actualPool, bizAccountsTable } from "@workspace/db";
import { databaseErrorCode, trace } from "./audit-trace";
import { credentialError, privateDiagnostics } from "./audit-errors";

trace("database-loaded");
const namespace = process.env.AUDIT_FIXTURE_SCHEMA ?? "";
if (!/^audit_cli_[a-f0-9]{32}$/.test(namespace)) {
  throw new Error("Invalid disposable fixture namespace");
}
const fixtureCase = process.env.AUDIT_FIXTURE_CASE;
const client = await actualPool.connect();
// Persistent disposable table, NOT a PostgreSQL TEMP table: READ ONLY permits
// writes to TEMP tables, which would make a write-rejection test misleading.
const table = ["db-read-failure", "db-read-and-cleanup-failure", "db-read-failure-cleanup-stall"]
  .includes(fixtureCase ?? "") ? "receipt_fixture" : "biz_accounts";
try {
  await client.query(`CREATE SCHEMA "${namespace}"`);
  await client.query(`CREATE TABLE "${namespace}"."${table}" (
    id text PRIMARY KEY,
    stripe_session_id text, paid_at timestamptz,
    application_paid_amount_cents integer, application_paid_currency text,
    onboarding_session_id text, onboarding_paid_at timestamptz,
    onboarding_paid_amount_cents integer, onboarding_paid_currency text,
    password_hash text, email text, meeting_notes text
  )`);
  await client.query(`INSERT INTO "${namespace}"."${table}"
    (id, stripe_session_id, paid_at, application_paid_amount_cents,
     application_paid_currency, password_hash, email, meeting_notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    "fixture_account", "cs_fixture_receipt", new Date("2026-10-23T12:00:00Z"),
    100, "usd", "DO_NOT_READ_PASSWORD", "DO_NOT_READ_EMAIL", "DO_NOT_READ_NOTES",
  ]);
  // No public fallback: a missing fixture table must never read real accounts.
  await client.query(`SET search_path TO "${namespace}"`);
  await client.query("SELECT set_config('application_name', $1, false)", [namespace]);
  const path = await client.query("SHOW search_path");
  if (path.rows[0].search_path.replaceAll('"', "") !== namespace) {
    throw new Error("Fixture search path was not isolated");
  }
  trace("fixture-ready");
} catch (error) {
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  } finally {
    client.release();
    await actualPool.end();
  }
  throw error;
}

export { bizAccountsTable };
let released = false;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let keepAlive: ReturnType<typeof setInterval> | undefined;
let lateConnection: Promise<typeof auditClient> | undefined;
const auditClient = new Proxy(client, {
  get(target, property, receiver) {
    if (property === "release") return (destroy?: boolean) => {
      trace("client-release", { destroy: !!destroy });
      released = true;
      client.release(destroy);
    };
    if (property === "query") return new Proxy(client.query, {
      async apply(queryMethod, _thisArg, args) {
        const query = typeof args[0] === "string" ? args[0] : args[0].text;
        trace("audit-sql", { query });
        try {
          if (fixtureCase === "db-private-read" && /^select /i.test(query)) {
            throw new Error(privateDiagnostics.join(" "), { cause: credentialError("28P01") });
          }
          const stall = (["db-read-stall", "db-read-and-cleanup-stall"].includes(fixtureCase ?? "") && /^select .* from "biz_accounts"$/i.test(query)) ||
            (fixtureCase === "db-begin-stall" && /^begin$/i.test(query)) ||
            (fixtureCase === "db-read-only-stall" && /SET TRANSACTION READ ONLY/i.test(query)) ||
            (fixtureCase === "db-commit-stall" && /^commit$/i.test(query));
          if (stall) {
            trace("query-stall");
            // A real server-side wait, not an unreferenced unresolved promise:
            // releasing with destroy must cancel it and roll back the snapshot.
            await client.query("SELECT pg_sleep(60)");
          }
          const result = await Reflect.apply(queryMethod, client, args);
          if (fixtureCase === "write-attempt" && /SET TRANSACTION READ ONLY/i.test(query)) {
            try {
              await client.query(`INSERT INTO "${namespace}"."${table}" (id) VALUES ('forbidden_write')`);
            } catch (error) {
              trace("write-rejected", { code: databaseErrorCode(error) });
              throw error;
            }
          }
          return result;
        } catch (error) {
          trace("database-error", { code: databaseErrorCode(error) });
          throw error;
        }
      },
    });
    return Reflect.get(target, property, receiver);
  },
});

export const pool = {
  options: { connectionTimeoutMillis: 0, statement_timeout: 0 },
  async query(query: string, params: number[]) {
    if (query !== "SELECT pg_cancel_backend($1)" || params.length !== 1) {
      trace("forbidden-cancel-query");
      throw new Error("Only audit backend cancellation is allowed");
    }
    trace("backend-cancel-start");
    const result = await actualPool.query(query, params);
    trace("backend-cancel-done", { cancelled: result.rows[0].pg_cancel_backend });
    return result;
  },
  async connect() {
    trace("pool-connect");
    // This fixture acquired its disposable connection during setup. Mirror the
    // pg startup parameter that the CLI sets before acquiring a real connection.
    await client.query(`SET statement_timeout = '${pool.options.statement_timeout}ms'`);
    if (fixtureCase === "db-connect-failure" || fixtureCase === "db-connect-and-cleanup-failure") {
      throw credentialError("ECONNREFUSED");
    }
    if (fixtureCase === "db-private-unknown-code" || fixtureCase === "db-and-cleanup-unknown-code") {
      throw credentialError(privateDiagnostics.join("\n"));
    }
    if (fixtureCase === "db-private-non-error") {
      throw privateDiagnostics.join(" ");
    }
    if (fixtureCase === "db-connect-stall") {
      keepAlive = setInterval(() => {}, 1_000);
      return new Promise<typeof auditClient>(() => {});
    }
    if (fixtureCase === "db-connect-late") {
      lateConnection = new Promise(resolve => {
        connectionTimer = setTimeout(() => {
          trace("late-connection");
          resolve(auditClient);
        }, 300);
      });
      return lateConnection;
    }
    return auditClient;
  },
  async end() {
    trace("pool-end-start");
    if (fixtureCase === "stripe-scan-late-reply") {
      trace("shutdown-pending");
      const { deliverLateCheckoutPageDuringShutdown } = await import("./audit-stripe");
      await deliverLateCheckoutPageDuringShutdown();
      trace("shutdown-resumed");
    }
    if (fixtureCase === "cleanup-open-stall") {
      trace("shutdown-stall");
      // Keep the real fixture pool open: the interruption deadline must close
      // this child's database sockets even when graceful shutdown never starts.
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    clearInterval(keepAlive);
    if (lateConnection) await lateConnection;
    clearTimeout(connectionTimer);
    if (!released) {
      client.release(true);
      released = true;
    }
    const verifier = await actualPool.connect();
    try {
      const rows = await verifier.query(`SELECT id, stripe_session_id,
        application_paid_amount_cents FROM "${namespace}"."${table}" ORDER BY id`);
      trace("fixture-final-rows", { rows: rows.rows });
      await verifier.query(`DROP SCHEMA "${namespace}" CASCADE`);
    } finally {
      verifier.release();
      await actualPool.end();
      trace("pool-end-done");
    }
    if (["cleanup-stall", "db-read-and-cleanup-stall", "db-read-failure-cleanup-stall", "stripe-page-cleanup-stall"]
      .includes(fixtureCase ?? "")) {
      trace("shutdown-stall");
      // Retain a handle to prove the CLI exits itself, not because Node has no
      // work left. The child process must not need the parent's safety timeout.
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    if (fixtureCase === "db-and-cleanup-unknown-code") {
      throw credentialError(privateDiagnostics.join("\n"));
    }
    if (["cleanup-failure", "db-connect-and-cleanup-failure", "db-read-and-cleanup-failure",
      "stripe-and-cleanup-failure"].includes(fixtureCase ?? "")) {
      throw credentialError("ECONNRESET");
    }
  },
};
