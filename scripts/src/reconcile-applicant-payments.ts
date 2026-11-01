import { buildApplicantPaymentReport, type StripeMode } from "./applicantPaymentReport";
import { drizzle } from "drizzle-orm/node-postgres";
import { AuditDeadline, AuditFailure, type AuditReadOptions } from "./auditDeadline";

let timedOut = false;
const cancellation = new AbortController();
let interruption: AuditFailure | undefined;
let interruptionDeadline: ReturnType<typeof setTimeout> | undefined;
let interruptionTimeout = 5_000;
let failureReported = false;

function interrupt(signal: NodeJS.Signals) {
  if (interruption) return; // Repeated signals must not restart the cleanup budget.
  interruption = new AuditFailure("Audit interruption", "AUDIT_INTERRUPTED", `cancelled by ${signal}.`);
  interruptionDeadline = setTimeout(() => fail(interruption!), interruptionTimeout);
  cancellation.abort();
}

function removeInterruptHandlers() {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  clearTimeout(interruptionDeadline);
}

async function interruptible<T>(operation: () => PromiseLike<T>): Promise<T> {
  if (interruption) throw interruption;
  let rejectInterrupted: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        rejectInterrupted = () => reject(interruption);
        cancellation.signal.addEventListener("abort", rejectInterrupted, { once: true });
      }),
      operation(),
    ]);
  } finally {
    cancellation.signal.removeEventListener("abort", rejectInterrupted);
  }
}

// Only these application-owned messages and exact codes may cross the CLI
// boundary. Never interpolate SDK messages, URLs, queries, parameters or stacks.
class UsageError extends Error {}
class AuditCleanupFailure extends Error {
  constructor(primary: unknown, cleanup: unknown) {
    // Exactly two sanitized records; never render raw causes or an SDK aggregate.
    super(`${safeDiagnostic(primary)}\nCleanup failed: ${safeDiagnostic(cleanup)}`);
  }
}

function safeDiagnostic(error: unknown): string {
  return error instanceof UsageError || error instanceof AuditFailure
    ? error.message
    : new AuditFailure("Audit execution", safeErrorCode(error)).message;
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

async function auditPhase<T>(phase: string, operation: () => PromiseLike<T>, allowInterruption = true): Promise<T> {
  try {
    return await (allowInterruption ? interruptible(operation) : operation());
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
AUDIT_STRIPE_TIMEOUT_MS bounds each connector/Stripe read (default 30000), without SDK retries.
AUDIT_TIMEOUT_MS bounds the whole audit before cleanup (default 300000).
Interrupted Checkout scans never emit a report; optional read failures remain unavailable evidence.
SIGINT/SIGTERM cancel the audit without a report; cleanup uses the shutdown budget.
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
  const stripeTimeout = timeoutSetting("AUDIT_STRIPE_TIMEOUT_MS", 30_000);
  const auditTimeout = timeoutSetting("AUDIT_TIMEOUT_MS", 300_000);
  interruptionTimeout = shutdownTimeout;
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const deadline = new AuditDeadline(auditTimeout, () => { timedOut = true; });
  try {
    await runAudit(args.includes("--inspect-payments"), mode, deadline, {
      databaseTimeout, shutdownTimeout, stripeTimeout, auditTimeout,
    });
  } finally {
    deadline.close();
  }
}

function fail(error: unknown) {
  if (failureReported) return;
  failureReported = true;
  removeInterruptHandlers();
  process.exitCode = 1;
  if (interruption) error = interruption;
  const diagnostic = error instanceof AuditCleanupFailure
    ? error.message
    : safeDiagnostic(error);
  // Even a blocked stderr pipe cannot retain an interrupted audit indefinitely.
  if (interruption) setTimeout(() => process.exit(1), 50);
  process.stderr.write(`Reconciliation failed: ${diagnostic}\n`, () => {
    // A broken driver may retain sockets even after cancellation and bounded
    // cleanup. Flush the failure before terminating this CLI, never the API.
    if (timedOut || interruption) process.exit(1);
  });
}

async function runAudit(
  inspectPayments: boolean,
  mode: StripeMode,
  deadline: AuditDeadline,
  { databaseTimeout, shutdownTimeout, stripeTimeout, auditTimeout }: {
    databaseTimeout: number; shutdownTimeout: number; stripeTimeout: number; auditTimeout: number;
  },
) {
  // Stripe's SDK has no AbortSignal option. Pass only its supported options:
  // its transport timeout bounds sockets, while the scope also bounds promises
  // from a reader that ignores its timeout entirely.
  const read = <T>(phase: string, operation: (options: Omit<AuditReadOptions, "signal">) => PromiseLike<T>) =>
    interruptible(() => deadline.run(phase, stripeTimeout, ({ timeout, maxNetworkRetries }) =>
      operation({ timeout, maxNetworkRetries })));
  // Import only after explicit invocation with a valid mode; --help needs no credentials.
  const stripe = await auditPhase("Stripe connection", async () => {
    return deadline.run("Stripe connection", stripeTimeout, async options => {
      const { getAuditStripeClient } = await import("./stripeClient");
      return getAuditStripeClient(options);
    });
  });
  // Balance is a read-only way to confirm mode even when the session list is empty.
  const balance = await auditPhase("Stripe mode check", () =>
    read("Stripe mode check", options => stripe.balance.retrieve({}, options)));
  if (balance.livemode !== (mode === "live")) {
    throw new AuditFailure("Stripe mode check", "AUDIT_MODE_MISMATCH",
      "Requested mode does not match the existing Stripe connection.");
  }
  const { pool, bizAccountsTable } = await auditPhase("Database initialization", () => import("@workspace/db"));
  const { sql } = await import("drizzle-orm");
  let report: Awaited<ReturnType<typeof buildApplicantPaymentReport>>;
  // A wrapper distinguishes a thrown undefined/null from successful execution.
  let primaryFailure: { error: unknown } | undefined;
  try {
    // This process is the audit, not API startup. Also let pg cancel a pending
    // physical connection; the deadline below covers even a stuck driver.
    pool.options.connectionTimeoutMillis = databaseTimeout;
    // Apply at connection startup as well, so BEGIN and read-only setup are
    // protected before the transaction-local setting can be installed.
    pool.options.statement_timeout = databaseTimeout;
    let acceptingConnection = true;
    // Infer the promise overload without starting acquisition before the
    // deadline check (pg's final callback overload has a void return type).
    const connect = () => pool.connect();
    let client: Awaited<ReturnType<typeof connect>>;
    try {
      client = await auditPhase("Database connection", () => deadline.run("Database connection", databaseTimeout, () => connect().then(connection => {
        if (!acceptingConnection) {
          connection.release(true);
          throw new Error("Audit connection arrived after its deadline.");
        }
        return connection;
      })));
    } finally {
      acceptingConnection = false;
    }
    const scanStartedAt = new Date();
    let snapshotComplete = false;
    let backendPid: number | undefined;
    const accounts = await auditPhase("Database receipt snapshot", async () => {
      try {
        // A separate pool connection cancels the exclusively held audit backend
        // before its socket is destroyed, including during server-side waits.
        const identity = await interruptible(() => deadline.run("Database receipt snapshot", databaseTimeout,
          () => client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")));
        backendPid = identity.rows[0].pid;
        const accounts = await interruptible(() => deadline.run("Database receipt snapshot", databaseTimeout, () => drizzle(client).transaction(async tx => {
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
        })));
        snapshotComplete = true;
        return accounts;
      } finally {
        if (interruption && backendPid !== undefined) {
          try {
            await bounded(pool.query("SELECT pg_cancel_backend($1)", [backendPid]),
              shutdownTimeout, "Database query cancellation");
          } catch {
            // Keep the interruption primary. Its original process-wide cleanup
            // deadline also bounds this cancellation attempt and pool shutdown.
          }
        }
        // Destroying a timed-out connection cancels in-flight queries and lets
        // PostgreSQL roll back the read-only transaction. Do not queue ROLLBACK
        // behind a query that may never respond.
        client.release(!snapshotComplete);
      }
    }, false);
    report = await auditPhase("Stripe payment scan", () => deadline.run("Stripe payment scan", auditTimeout, () => buildApplicantPaymentReport(
      { list: params => read("Stripe payment scan",
        options => stripe.checkout.sessions.list(params, options)) },
      accounts, mode, scanStartedAt,
      inspectPayments ? {
        retrievePaymentIntent: id => read("Stripe payment inspection", options => stripe.paymentIntents.retrieve(id, {}, options)),
        listCharges: params => read("Stripe payment inspection", options => stripe.charges.list(params, options)),
        listRefunds: params => read("Stripe payment inspection", options => stripe.refunds.list(params, options)),
        listDisputes: params => read("Stripe payment inspection", options => stripe.disputes.list(params, options)),
      } : undefined,
    )));
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    try {
      await auditPhase("Database pool shutdown", () =>
        bounded(pool.end(), shutdownTimeout, "Database pool shutdown"), false);
    } catch (cleanupError) {
      if (primaryFailure) throw new AuditCleanupFailure(primaryFailure.error, cleanupError);
      throw cleanupError;
    }
  }
  // Cleanup is part of successful completion too. A failed pool shutdown must
  // not leave JSON on stdout alongside a failing exit status.
  if (interruption) throw interruption;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().then(removeInterruptHandlers, fail);
