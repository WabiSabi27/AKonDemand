import { buildApplicantPaymentReport, type StripeMode } from "./applicantPaymentReport";
import { drizzle } from "drizzle-orm/node-postgres";

let timedOut = false;

// Only these application-owned messages and exact codes may cross the CLI
// boundary. Never interpolate SDK messages, URLs, queries, parameters or stacks.
class UsageError extends Error {}
class AuditFailure extends Error {
  constructor(phase: string, code: string, detail = "operation failed.") {
    super(`${phase}: ${detail} [${code}]`);
  }
}

const allowedCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "28P01", "28000", "3D000", "42P01", "42501", "25006", "57014",
  "53300", "57P01", "08001", "08006",
  "api_key_expired", "invalid_api_key", "authentication_required",
  "rate_limit", "resource_missing", "parameter_invalid_integer",
]);

function safeErrorCode(error: unknown): string {
  // Drizzle wraps pg errors in cause. Bound traversal, including cyclic causes.
  try {
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string" && allowedCodes.has(code)) return code;
      current = cause;
    }
  } catch {
    // Even a throwing diagnostic property must not bypass sanitization.
  }
  return "AUDIT_OPERATION_FAILED";
}

async function auditPhase<T>(phase: string, operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuditFailure) throw error;
    throw new AuditFailure(phase, safeErrorCode(error));
  }
}

function timeoutSetting(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) ||
      Number(value) > 2_147_483_647) {
    throw new UsageError(`${name} must be a positive integer in milliseconds (at most 2147483647).`);
  }
  return Number(value);
}

// Keep the timer referenced so even a promise with no active handles fails
// explicitly. Clear it on either outcome; never leave a background deadline.
async function bounded<T>(operation: PromiseLike<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new AuditFailure(phase, "AUDIT_TIMEOUT", `timed out after ${milliseconds}ms.`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const usage = `Read-only historical applicant payment reconciliation.
Usage: pnpm --filter @workspace/scripts reconcile-applicant-payments --mode test|live [--inspect-payments]
Writes a complete JSON report to stdout; errors go to stderr with a nonzero exit.
Uses the existing Stripe connector and configured database. Mode must match the connector.
Does not initialize the API server, replay webhooks, write records, or issue refunds.
Optional --inspect-payments reads PaymentIntents, all charge/dispute pages and refund pages per charge.
Normally costs at least 4 extra Stripe reads per session, plus pages/charges; manual review remains required.
AUDIT_DATABASE_TIMEOUT_MS bounds connection and receipt snapshot waits (default 30000).
AUDIT_SHUTDOWN_TIMEOUT_MS bounds pool shutdown (default 5000).
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage);
    return;
  }
  if ((args.length !== 2 && args.length !== 3) || args[0] !== "--mode" ||
      !["test", "live"].includes(args[1]) ||
      (args.length === 3 && args[2] !== "--inspect-payments")) {
    throw new UsageError(usage);
  }
  const mode = args[1] as StripeMode;
  const databaseTimeout = timeoutSetting("AUDIT_DATABASE_TIMEOUT_MS", 30_000);
  const shutdownTimeout = timeoutSetting("AUDIT_SHUTDOWN_TIMEOUT_MS", 5_000);
  // Import only after explicit invocation with a valid mode; --help needs no credentials.
  const stripe = await auditPhase("Stripe connection", async () => {
    const { getUncachableStripeClient } = await import("./stripeClient");
    return getUncachableStripeClient();
  });
  // Balance is a read-only way to confirm mode even when the session list is empty.
  const balance = await auditPhase("Stripe mode check", () => stripe.balance.retrieve());
  if (balance.livemode !== (mode === "live")) {
    throw new AuditFailure("Stripe mode check", "AUDIT_MODE_MISMATCH",
      "Requested mode does not match the existing Stripe connection.");
  }
  const { pool, bizAccountsTable } = await auditPhase("Database initialization", () => import("@workspace/db"));
  const { sql } = await import("drizzle-orm");
  let report: Awaited<ReturnType<typeof buildApplicantPaymentReport>>;
  try {
    // This process is the audit, not API startup. Also let pg cancel a pending
    // physical connection; the deadline below covers even a stuck driver.
    pool.options.connectionTimeoutMillis = databaseTimeout;
    // Apply at connection startup as well, so BEGIN and read-only setup are
    // protected before the transaction-local setting can be installed.
    pool.options.statement_timeout = databaseTimeout;
    let acceptingConnection = true;
    const connectionAttempt = auditPhase("Database connection", () => pool.connect());
    let client: Awaited<typeof connectionAttempt>;
    try {
      client = await auditPhase("Database connection", () => bounded(connectionAttempt.then(connection => {
        if (!acceptingConnection) {
          connection.release(true);
          throw new Error("Audit connection arrived after its deadline.");
        }
        return connection;
      }), databaseTimeout, "Database connection"));
    } finally {
      acceptingConnection = false;
    }
    const scanStartedAt = new Date();
    let snapshotComplete = false;
    const accounts = await auditPhase("Database receipt snapshot", async () => {
      try {
        const accounts = await bounded(drizzle(client).transaction(async tx => {
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
          // A socket close alone may not interrupt a server-side wait promptly.
          // Bound statements on the server too, scoped to this transaction.
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${databaseTimeout}ms'`));
          return tx.select({
            id: bizAccountsTable.id,
            stripeSessionId: bizAccountsTable.stripeSessionId,
            paidAt: bizAccountsTable.paidAt,
            applicationPaidAmountCents: bizAccountsTable.applicationPaidAmountCents,
            applicationPaidCurrency: bizAccountsTable.applicationPaidCurrency,
            onboardingSessionId: bizAccountsTable.onboardingSessionId,
            onboardingPaidAt: bizAccountsTable.onboardingPaidAt,
            onboardingPaidAmountCents: bizAccountsTable.onboardingPaidAmountCents,
            onboardingPaidCurrency: bizAccountsTable.onboardingPaidCurrency,
          }).from(bizAccountsTable);
        }), databaseTimeout, "Database receipt snapshot");
        snapshotComplete = true;
        return accounts;
      } finally {
        // Destroying a timed-out connection cancels in-flight queries and lets
        // PostgreSQL roll back the read-only transaction. Do not queue ROLLBACK
        // behind a query that may never respond.
        client.release(!snapshotComplete);
      }
    });
    report = await auditPhase("Stripe payment scan", () => buildApplicantPaymentReport(
      { list: params => stripe.checkout.sessions.list(params) },
      accounts, mode, scanStartedAt,
      args.includes("--inspect-payments") ? {
        retrievePaymentIntent: id => stripe.paymentIntents.retrieve(id),
        listCharges: params => stripe.charges.list(params),
        listRefunds: params => stripe.refunds.list(params),
        listDisputes: params => stripe.disputes.list(params),
      } : undefined,
    ));
  } finally {
    await auditPhase("Database pool shutdown", () =>
      bounded(pool.end(), shutdownTimeout, "Database pool shutdown"));
  }
  // Cleanup is part of successful completion too. A failed pool shutdown must
  // not leave JSON on stdout alongside a failing exit status.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.exitCode = 1;
  const diagnostic = error instanceof UsageError || error instanceof AuditFailure
    ? error.message
    : new AuditFailure("Audit execution", safeErrorCode(error)).message;
  process.stderr.write(`Reconciliation failed: ${diagnostic}\n`, () => {
    // A broken driver may retain sockets even after cancellation and bounded
    // cleanup. Flush the failure before terminating this CLI, never the API.
    if (timedOut) process.exit(1);
  });
});
