import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { privateDiagnostics } from "./test-fixtures/audit-errors";

let cleanupPool: (typeof import("@workspace/db"))["pool"] | undefined;
after(async () => { await cleanupPool?.end(); });
const cli = new URL("./reconcile-applicant-payments.ts", import.meta.url).pathname;
const loader = new URL("./test-fixtures/audit-cli-loader.mjs", import.meta.url).href;
interface Event {
  event: string;
  query?: string;
  code?: string;
  rows?: unknown[];
  destroy?: boolean;
  cancelled?: boolean;
  text?: string;
  pendingBytes?: number;
}

async function runCli(fixtureCase: string, inspect = false, overrides: Record<string, string> = {}) {
  assert.notEqual(process.env.NODE_ENV, "production", "Use the configured development database only");
  const importFailure = fixtureCase.startsWith("db-import-");
  const namespace = `audit_cli_${randomUUID().replaceAll("-", "")}`;
  const directory = mkdtempSync(join(tmpdir(), "audit-cli-"));
  const traceFile = join(directory, "events.jsonl");
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--import", loader, cli, "--mode", "test",
      ...(inspect ? ["--inspect-payments"] : []),
    ], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000,
      env: {
        // Import-rejection cases need neither credentials nor a database.
        ...(importFailure ? {} : process.env), NODE_ENV: "test",
        AUDIT_FIXTURE_CASE: fixtureCase, AUDIT_FIXTURE_SCHEMA: namespace,
        AUDIT_FIXTURE_TRACE: traceFile,
        AUDIT_DATABASE_TIMEOUT_MS: "150", AUDIT_SHUTDOWN_TIMEOUT_MS: "1500",
        AUDIT_STRIPE_TIMEOUT_MS: "150", AUDIT_TIMEOUT_MS: "10000",
        ...overrides,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "CLI must finish itself without being killed");
    for (const value of privateDiagnostics) {
      assert.ok(!result.stderr.includes(value), "Private diagnostics must not reach stderr");
      assert.ok(!result.stdout.includes(value), "Private diagnostics must not reach stdout");
    }
    const events: Event[] = readFileSync(traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!events.some(item => item.event.startsWith("forbidden-")));
    if (!events.some(item => item.event === "database-loaded")) {
      assert.ok(!events.some(item => item.event === "pool-connect"));
      return { ...result, events };
    }
    assert.equal(events.filter(item => item.event === "pool-end-start").length, 1);
    assert.equal(events.filter(item => item.event === "pool-end-done").length, 1,
      `${result.stderr}\n${JSON.stringify(events)}`);
    assert.deepEqual(events.find(item => item.event === "fixture-final-rows")?.rows, [{
      id: "fixture_account", stripe_session_id: "cs_fixture_receipt",
      application_paid_amount_cents: 100,
    }], "Disposable receipts must stay unchanged");
    return { ...result, events };
  } finally {
    // Also clean up if a regression crashes or times out before CLI cleanup.
    if (!importFailure) {
      cleanupPool ??= (await import("@workspace/db")).pool;
      await cleanupPool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [fixtureCase, code] of [
  ["db-import-known-code", "28P01"],
  ["db-import-wrapped-code", "ECONNREFUSED"],
  ["db-import-unknown-code", "AUDIT_OPERATION_FAILED"],
  ["db-import-non-error", "AUDIT_OPERATION_FAILED"],
  ["db-import-cyclic-cause", "AUDIT_OPERATION_FAILED"],
  ["db-import-throwing-code", "AUDIT_OPERATION_FAILED"],
  ["db-import-throwing-cause", "AUDIT_OPERATION_FAILED"],
  ["db-import-throwing-diagnostics", "28P01"],
]) {
  test(`actual CLI safely reports Database initialization for ${fixtureCase}`, async () => {
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr,
      `Reconciliation failed: Database initialization: operation failed. [${code}]\n`);
    assert.deepEqual(result.events.map(item => item.event), [
      "fake-stripe-loaded", "stripe-mode-read", "database-import-rejected",
      ...(["db-import-throwing-code", "db-import-throwing-cause"].includes(fixtureCase)
        ? ["diagnostic-getter"] : []),
    ], "Import rejection must not load the database, scan Stripe, clean up a nonexistent pool or write stdout");
  });
}

for (const [fixtureCase, phase] of [
  ["db-connect-stall", "Database connection"],
  ["db-connect-late", "Database connection"],
  ["db-begin-stall", "Database receipt snapshot"],
  ["db-read-only-stall", "Database receipt snapshot"],
  ["db-read-stall", "Database receipt snapshot"],
  ["db-commit-stall", "Database receipt snapshot"],
  ["cleanup-stall", "Database pool shutdown"],
]) {
  test(`actual CLI cancels ${fixtureCase}, preserves receipts and exits without a partial report`, async () => {
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^Reconciliation failed: ${phase}: timed out after \\d+ms\\. \\[AUDIT_TIMEOUT\\]\\n$`));
    assert.ok(!result.events.some(item => item.event === "stdout-write"));
    if (fixtureCase.startsWith("db-") && !fixtureCase.startsWith("db-connect")) {
      assert.equal(result.events.filter(item => item.event === "query-stall").length, 1);
      assert.deepEqual(result.events.filter(item => item.event === "client-release").map(item => item.destroy), [true]);
      assert.ok(!result.events.some(item => item.event === "stripe-page"),
        "A timed-out snapshot must not start scanning Stripe");
    }
    if (fixtureCase === "db-connect-late") {
      assert.equal(result.events.filter(item => item.event === "late-connection").length, 1);
      assert.deepEqual(result.events.filter(item => item.event === "client-release").map(item => item.destroy), [true]);
      assert.ok(!result.events.some(item => item.event === "audit-sql"));
    }
    if (fixtureCase === "cleanup-stall") {
      assert.ok(result.events.some(item => item.event === "stripe-page"),
        "Even an otherwise complete report must be withheld when shutdown stalls");
    }
  });
}

for (const [fixtureCase, primary, cleanup] of [
  ["db-connect-and-cleanup-failure",
    "Database connection: operation failed. [ECONNREFUSED]",
    "Database pool shutdown: operation failed. [ECONNRESET]"],
  ["db-read-and-cleanup-failure",
    "Database receipt snapshot: operation failed. [42P01]",
    "Database pool shutdown: operation failed. [ECONNRESET]"],
  ["stripe-and-cleanup-failure",
    "Stripe payment scan: operation failed. [rate_limit]",
    "Database pool shutdown: operation failed. [ECONNRESET]"],
  ["db-and-cleanup-unknown-code",
    "Database connection: operation failed. [AUDIT_OPERATION_FAILED]",
    "Database pool shutdown: operation failed. [AUDIT_OPERATION_FAILED]"],
  ["db-read-failure-cleanup-stall",
    "Database receipt snapshot: operation failed. [42P01]",
    "Database pool shutdown: timed out after 1500ms. [AUDIT_TIMEOUT]"],
]) {
  test(`actual CLI preserves both sanitized failures for ${fixtureCase}`, async () => {
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `Reconciliation failed: ${primary}\nCleanup failed: ${cleanup}\n`);
    assert.ok(result.stderr.length < 300, "Combined diagnostics must remain bounded");
    assert.ok(!result.events.some(item => item.event === "stdout-write"));
    if (fixtureCase === "stripe-and-cleanup-failure") {
      assert.equal(result.events.filter(item => item.event === "stripe-page").length, 2,
        "A later-page failure must withhold even an already partially built report");
    } else {
      assert.ok(!result.events.some(item => item.event === "stripe-page"));
    }
  });
}

test("actual CLI preserves snapshot and cleanup timeouts together", async () => {
  const result = await runCli("db-read-and-cleanup-stall");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Reconciliation failed: Database receipt snapshot: timed out after 150ms\. \[AUDIT_TIMEOUT\]\nCleanup failed: Database pool shutdown: timed out after 1500ms\. \[AUDIT_TIMEOUT\]\n$/);
  assert.equal(result.events.filter(item => item.event === "query-stall").length, 1);
  assert.deepEqual(result.events.filter(item => item.event === "client-release").map(item => item.destroy), [true]);
  assert.ok(!result.events.some(item => item.event === "stripe-page" || item.event === "stdout-write"));
});

test("actual CLI reads only receipt columns in a read-only transaction and emits one complete report after closing the pool", async () => {
  const result = await runCli("success");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true);
  assert.equal(report.paymentInspectionRequested, false);
  assert.ok(!result.events.some(item => item.event === "stripe-intent-read"));
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].preservedReceipt.amountCents, 100);
  assert.ok(!result.stdout.includes("DO_NOT_READ_"));
  const queries = result.events.filter(item => item.event === "audit-sql").map(item => item.query!);
  const readOnly = queries.findIndex(query => /SET TRANSACTION READ ONLY/i.test(query));
  const select = queries.findIndex(query => /^select .* from "biz_accounts"$/i.test(query));
  assert.ok(readOnly >= 0 && select > readOnly);
  const projection = queries[select].match(/^select (.+) from "biz_accounts"$/i)?.[1];
  assert.ok(projection, queries[select]);
  assert.deepEqual([...projection.matchAll(/"([^"]+)"/g)].map(match => match[1]), [
    "id", "stripe_session_id", "paid_at",
    "application_paid_amount_cents", "application_paid_currency",
    "onboarding_session_id", "onboarding_paid_at",
    "onboarding_paid_amount_cents", "onboarding_paid_currency",
  ]);
  assert.ok(!projection.includes("*"));
  const closed = result.events.findIndex(item => item.event === "pool-end-done");
  const output = result.events.findIndex(item => item.event === "stdout-write");
  assert.ok(output > closed, "No report may be emitted before cleanup succeeds");
  assert.equal(result.events.filter(item => item.event === "stdout-write").length, 1);
});

test("actual CLI optionally inspects refunds using only synthetic Stripe reads", async () => {
  const result = await runCli("success", true);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.paymentInspectionRequested, true);
  const inspection = report.groups[0].successfulSessions[0].paymentInspection;
  assert.equal(inspection.refunds.status, "full");
  assert.equal(inspection.refunds.amountRefundedCents, 100);
  assert.equal(inspection.refundRequests.status, "found");
  assert.equal(inspection.refundRequests.items[0].status, "succeeded");
  assert.equal(inspection.disputes.status, "none");
  for (const event of ["stripe-intent-read", "stripe-charges-read", "stripe-refunds-read", "stripe-disputes-read"]) {
    assert.equal(result.events.filter(item => item.event === event).length, 1);
  }
});

for (const fixtureCase of [
  "write-attempt", "db-read-failure", "db-connect-failure", "stripe-failure", "cleanup-failure",
]) {
  test(`actual CLI fails closed for ${fixtureCase}: nonzero exit, no JSON and a closed pool`, async () => {
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Reconciliation failed:/);
    assert.ok(!result.events.some(item => item.event === "stdout-write"));
    if (fixtureCase === "write-attempt") {
      assert.equal(result.events.find(item => item.event === "write-rejected")?.code, "25006",
        "PostgreSQL itself must reject the write in the CLI's READ ONLY transaction");
    }
    if (fixtureCase === "db-read-failure") {
      assert.equal(result.events.find(item => item.event === "database-error")?.code, "42P01");
    }
    if (fixtureCase === "db-connect-failure") {
      assert.equal(result.stderr, "Reconciliation failed: Database connection: operation failed. [ECONNREFUSED]\n");
    }
    if (fixtureCase === "stripe-failure") {
      assert.equal(result.events.filter(item => item.event === "stripe-page").length, 2);
      assert.equal(result.stderr, "Reconciliation failed: Stripe payment scan: operation failed. [rate_limit]\n");
    }
    if (fixtureCase === "cleanup-failure") {
      assert.equal(result.stderr, "Reconciliation failed: Database pool shutdown: operation failed. [ECONNRESET]\n");
    }
  });
}

for (const [fixtureCase, phase, code] of [
  ["db-private-read", "Database receipt snapshot", "28P01"],
  ["db-private-unknown-code", "Database connection", "AUDIT_OPERATION_FAILED"],
  ["db-private-non-error", "Database connection", "AUDIT_OPERATION_FAILED"],
  ["stripe-private-connect", "Stripe connection", "invalid_api_key"],
  ["stripe-private-mode", "Stripe mode check", "AUDIT_OPERATION_FAILED"],
]) {
  test(`actual CLI redacts credential-bearing ${fixtureCase} and reports only an owned phase and code`, async () => {
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `Reconciliation failed: ${phase}: operation failed. [${code}]\n`);
    assert.ok(result.stderr.length < 160);
    assert.ok(!result.events.some(item => item.event === "stdout-write"));
  });
}

test("actual CLI retains helpful mode mismatch guidance without starting database access", async () => {
  const result = await runCli("stripe-mode-mismatch");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Reconciliation failed: Stripe mode check: Requested mode does not match the existing Stripe connection. [AUDIT_MODE_MISMATCH]\n");
  assert.ok(!result.events.some(item => item.event === "database-loaded"));
});

test("optional payment inspection never includes private Stripe errors in its report", async () => {
  const result = await runCli("stripe-private-inspection", true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).paymentInspectionRequested, true);
  assert.equal(result.events.filter(item => item.event === "stripe-intent-read").length, 1);
});

test("timeout configuration errors retain safe guidance without echoing the supplied value", () => {
  for (const name of ["AUDIT_DATABASE_TIMEOUT_MS", "AUDIT_SHUTDOWN_TIMEOUT_MS", "AUDIT_STRIPE_TIMEOUT_MS", "AUDIT_TIMEOUT_MS"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--mode", "test"], {
      encoding: "utf8", timeout: 5_000,
      env: {
        ...process.env, DATABASE_URL: "", REPLIT_CONNECTORS_HOSTNAME: "",
        AUDIT_DATABASE_TIMEOUT_MS: "150", AUDIT_SHUTDOWN_TIMEOUT_MS: "1500",
        [name]: privateDiagnostics.join(" "),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr,
      `Reconciliation failed: ${name} must be a positive integer in milliseconds (at most 2147483647).\n`);
    for (const value of privateDiagnostics) assert.ok(!result.stderr.includes(value));
  }
});

// Unlike the synchronous timeout fixtures, these children stay asynchronous so
// the parent can observe the actual server wait and deliver an operator signal.
async function runInterruptedCli(fixtureCase: string, signal: "SIGINT" | "SIGTERM", blockedStderr = false) {
  assert.notEqual(process.env.NODE_ENV, "production", "Use the development database only");
  const fixturePool = cleanupPool ??= (await import("@workspace/db")).pool;
  const namespace = `audit_cli_${randomUUID().replaceAll("-", "")}`;
  const directory = mkdtempSync(join(tmpdir(), "audit-interrupt-"));
  const traceFile = join(directory, "events.jsonl");
  const latePage = fixtureCase === "stripe-scan-late-reply";
  const events = (): Event[] => {
    try {
      return readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const child = spawn(process.execPath, [
    "--import", "tsx", "--import", loader, cli, "--mode", "test",
    ...(latePage ? ["--inspect-payments"] : []),
  ], {
    env: {
      ...process.env, NODE_ENV: "test",
      AUDIT_FIXTURE_CASE: fixtureCase, AUDIT_FIXTURE_SCHEMA: namespace,
      AUDIT_FIXTURE_TRACE: traceFile,
      AUDIT_FIXTURE_STDERR_BACKPRESSURE: blockedStderr ? "true" : "false",
      // Deliberately much longer than the interruption budget. A database
      // timeout cannot masquerade as successful operator cancellation.
      AUDIT_DATABASE_TIMEOUT_MS: "120000", AUDIT_SHUTDOWN_TIMEOUT_MS: "750",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
  if (blockedStderr) child.stderr.pause();
  else child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    child.kill("SIGKILL");
  }, 15_000);
  const waitFor = async (ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!await ready()) {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      assert.ok(Date.now() < deadline, `Fixture never reached interruption point: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const queryStall = fixtureCase.startsWith("db-") && fixtureCase !== "db-connect-late";
    const marker = queryStall ? "query-stall"
      : fixtureCase === "db-connect-late" ? "pool-connect"
      : fixtureCase === "stripe-scan-interrupt" || latePage ? "stripe-scan-stall" : "shutdown-stall";
    await waitFor(() => events().some(item => item.event === marker));
    if (queryStall) {
      await waitFor(async () => {
        const result = await fixturePool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND query = 'SELECT pg_sleep(60)'",
          [namespace],
        );
        return result.rowCount === 1;
      });
    }
    if (blockedStderr) {
      const recorded = events();
      assert.ok(recorded.some(item => item.event === "stderr-backpressured"));
      assert.ok(!recorded.some(item => item.event === "stderr-prefill-flushed"),
        "The real stderr write must still be blocked before cancellation");
    }
    const signalledAt = Date.now();
    assert.ok(child.kill(signal));
    // A repeated operator signal while cleanup stalls must not bypass cleanup
    // or renew its deadline.
    if (fixtureCase === "cleanup-stall" || fixtureCase === "cleanup-open-stall") {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT"));
    }
    const result = await closed;
    assert.equal(watchdogExpired, false, "Child must enforce its own interruption deadline");
    assert.ok(Date.now() - signalledAt < 2000, "Interruption must not wait for the database deadline");
    assert.equal(result.signal, null, "The CLI must exit itself after cleanup");
    assert.equal(result.status, 1, stderr);
    assert.equal(stdout, "", "No partial or completed report may escape after interruption");
    const recorded = events();
    const expectedFailure = `Reconciliation failed: Audit interruption: cancelled by ${signal}. [AUDIT_INTERRUPTED]\n`;
    if (blockedStderr) {
      const queued = recorded.filter(item => item.event === "stderr-failure-queued");
      assert.equal(queued.length, 1, "Cancellation must attempt exactly one failure diagnostic");
      assert.equal(queued[0].text, expectedFailure);
      assert.ok((queued[0].pendingBytes ?? 0) > 0, "The failure must queue behind blocked pipe output");
      assert.ok(!recorded.some(item => item.event === "stderr-prefill-flushed"));
      assert.ok(!recorded.some(item => item.event === "stderr-failure-flushed"),
        "Exit must not depend on the blocked write callback");
      assert.ok(recorded.findIndex(item => item.event === "stderr-failure-queued") >
        recorded.findIndex(item => item.event === "pool-end-done"),
      "Finish database cleanup before attempting the blocked failure diagnostic");
    } else {
      assert.equal(stderr, expectedFailure);
    }
    assert.ok(!recorded.some(item => item.event.startsWith("forbidden-")));
    assert.ok(!recorded.some(item => item.event === "stdout-write"));
    for (const value of privateDiagnostics) assert.ok(!`${stdout}${stderr}`.includes(value));
    assert.equal(recorded.filter(item => item.event === "pool-end-start").length, 1);
    const shutdownStuckOpen = fixtureCase === "cleanup-open-stall";
    assert.equal(recorded.filter(item => item.event === "pool-end-done").length, shutdownStuckOpen ? 0 : 1);
    const finalRows = shutdownStuckOpen
      ? (await fixturePool.query(`SELECT id, stripe_session_id, application_paid_amount_cents
          FROM "${namespace}"."biz_accounts" ORDER BY id`)).rows
      : recorded.find(item => item.event === "fixture-final-rows")?.rows;
    assert.deepEqual(finalRows, [{
      id: "fixture_account", stripe_session_id: "cs_fixture_receipt",
      application_paid_amount_cents: 100,
    }], "Operator cancellation must not alter receipts");
    if (queryStall) {
      assert.equal(recorded.find(item => item.event === "backend-cancel-done")?.cancelled, true);
      assert.deepEqual(recorded.filter(item => item.event === "client-release").map(item => item.destroy), [true]);
      assert.ok(!recorded.some(item => item.event === "stripe-page"));
      const active = await fixturePool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state <> 'idle'",
        [namespace],
      );
      assert.equal(active.rowCount, 0, "The server query and read-only transaction must be gone");
    }
    if (blockedStderr || latePage) {
      const sessions = await fixturePool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1",
        [namespace],
      );
      assert.equal(sessions.rowCount, 0, "Cancellation must not retain even idle fixture database sessions");
    }
    if (fixtureCase === "db-connect-late") {
      assert.ok(recorded.some(item => item.event === "late-connection"));
      assert.deepEqual(recorded.filter(item => item.event === "client-release").map(item => item.destroy), [true]);
      assert.ok(!recorded.some(item => item.event === "audit-sql"));
    }
    if (latePage) {
      const ordered = [
        "stripe-scan-stall", "pool-end-start", "shutdown-pending",
        "stripe-late-page-released", "stripe-late-page-returned",
        "stripe-late-observation-done", "shutdown-resumed", "pool-end-done",
      ];
      let previous = -1;
      for (const event of ordered) {
        assert.equal(recorded.filter(item => item.event === event).length, 1, event);
        const index = recorded.findIndex(item => item.event === event);
        assert.ok(index > previous, `${event} must occur after ${ordered[ordered.indexOf(event) - 1] ?? "scan setup"}`);
        previous = index;
      }
      assert.equal(recorded.filter(item => item.event === "stripe-page").length, 1,
        "A successful late page with has_more must not restart pagination");
      for (const event of ["stripe-intent-read", "stripe-charges-read", "stripe-refunds-read", "stripe-disputes-read"]) {
        assert.ok(!recorded.some(item => item.event === event),
          `Late payment data must not trigger ${event}, even with inspection enabled`);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    clearTimeout(watchdog);
    // Clean up only backends explicitly tagged with this disposable namespace,
    // even if a regression leaves a server-side sleep holding a table lock.
    await fixturePool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [namespace],
    );
    await fixturePool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`operator ${signal} ignores a late Checkout reply while database shutdown is pending`, async () => {
    await runInterruptedCli("stripe-scan-late-reply", signal);
  });
  test(`operator ${signal} exits on deadline even when stderr is backpressured`, async () => {
    await runInterruptedCli("db-read-stall", signal, true);
  });
}

for (const [fixtureCase, phase] of [
  ["stripe-connect-stall", "Stripe connection"],
  ["stripe-mode-stall", "Stripe mode check"],
  ["stripe-page-stall", "Stripe payment scan"],
  ["stripe-later-page-stall", "Stripe payment scan"],
  ["stripe-page-cleanup-stall", "Stripe payment scan"],
]) {
  test(`actual CLI bounds ${fixtureCase} without emitting an incomplete report`, async () => {
    const started = performance.now();
    const result = await runCli(fixtureCase);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    const cleanupDiagnostic = fixtureCase === "stripe-page-cleanup-stall"
      ? "Cleanup failed: Database pool shutdown: timed out after 1500ms\\. \\[AUDIT_TIMEOUT\\]\\n"
      : "";
    assert.match(result.stderr, new RegExp(`^Reconciliation failed: ${phase}: timed out after \\d+ms\\. \\[AUDIT_TIMEOUT\\]\\n${cleanupDiagnostic}$`));
    assert.ok(performance.now() - started < 10_000, "Read and shutdown must finish before the parent safety timeout");
    if (fixtureCase === "stripe-connect-stall") {
      assert.equal(result.events.filter(item => item.event === "stripe-aborted").length, 1);
    }
    assert.ok(!result.events.some(item => item.event === "stdout-write"));
    if (fixtureCase === "stripe-later-page-stall") {
      assert.equal(result.events.filter(item => item.event === "stripe-page").length, 2);
    }
    if (fixtureCase.includes("page")) {
      assert.deepEqual(result.events.filter(item => item.event === "client-release").map(item => item.destroy), [false]);
    } else {
      assert.ok(!result.events.some(item => item.event === "database-loaded"));
    }
  });
}

test("actual CLI enforces one total deadline across otherwise timely Checkout pages", async () => {
  const result = await runCli("stripe-total-deadline", false, {
    AUDIT_TIMEOUT_MS: "1500", AUDIT_STRIPE_TIMEOUT_MS: "1000",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /AUDIT_TIMEOUT/);
  assert.ok(result.events.filter(item => item.event === "stripe-page").length > 1);
  assert.ok(!result.events.some(item => item.event === "stdout-write"));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const fixtureCase of [
    "db-begin-stall", "db-read-only-stall", "db-read-stall", "db-commit-stall",
    "db-connect-late", "stripe-scan-interrupt", "cleanup-stall", "cleanup-open-stall",
  ]) {
    test(`operator ${signal} cancels ${fixtureCase} with bounded cleanup and no report`, async () => {
      await runInterruptedCli(fixtureCase, signal);
    });
  }
}

for (const kind of ["intent", "charges", "refunds", "disputes",
  "charges-later-page", "refunds-later-page", "disputes-later-page"]) {
  test(`stalled optional ${kind} reads remain unavailable, never false evidence of no refunds or disputes`, async () => {
    const result = await runCli(`stripe-${kind}-stall`, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const inspection = JSON.parse(result.stdout).groups[0].successfulSessions[0].paymentInspection;
    assert.equal(inspection.status, "unavailable");
    if (kind.startsWith("intent") || kind.startsWith("charges")) {
      assert.equal(inspection.refunds.status, "unavailable");
      assert.equal(inspection.refunds.amountRefundedCents, null);
      assert.equal(inspection.refundRequests.status, "unavailable");
    } else {
      assert.equal(inspection.refunds.status, "full", "Keep independently verified settled totals");
      assert.equal(inspection.refunds.amountRefundedCents, 100);
      assert.equal(kind.startsWith("refunds") ? inspection.refundRequests.status : inspection.disputes.status, "unavailable");
    }
    assert.equal(result.events.filter(item => item.event === "stripe-stall").length, 1);
    const closed = result.events.findIndex(item => item.event === "pool-end-done");
    assert.ok(result.events.findIndex(item => item.event === "stdout-write") > closed);
  });
}

test("expiry of the total budget during optional inspection cannot be swallowed into a successful report", async () => {
  const result = await runCli("stripe-intent-stall", true, {
    AUDIT_TIMEOUT_MS: "1500", AUDIT_STRIPE_TIMEOUT_MS: "5000",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /AUDIT_TIMEOUT/);
  assert.equal(result.events.filter(item => item.event === "stripe-intent-read").length, 1);
  assert.ok(!result.events.some(item => item.event === "stdout-write"));
});
