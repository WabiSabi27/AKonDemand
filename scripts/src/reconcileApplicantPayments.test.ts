import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pool as cleanupPool } from "@workspace/db";
import { privateDiagnostics } from "./test-fixtures/audit-errors";

after(async () => { await cleanupPool.end(); });
const cli = new URL("./reconcile-applicant-payments.ts", import.meta.url).pathname;
const loader = new URL("./test-fixtures/audit-cli-loader.mjs", import.meta.url).href;
interface Event {
  event: string;
  query?: string;
  code?: string;
  rows?: unknown[];
  destroy?: boolean;
}

async function runCli(fixtureCase: string, inspect = false) {
  assert.notEqual(process.env.NODE_ENV, "production", "Use the configured development database only");
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
        ...process.env, NODE_ENV: "test",
        AUDIT_FIXTURE_CASE: fixtureCase, AUDIT_FIXTURE_SCHEMA: namespace,
        AUDIT_FIXTURE_TRACE: traceFile,
        AUDIT_DATABASE_TIMEOUT_MS: "150", AUDIT_SHUTDOWN_TIMEOUT_MS: "1500",
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
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [fixtureCase, phase] of [
  ["db-connect-stall", "Database connection"],
  ["db-connect-late", "Database connection"],
  ["db-begin-stall", "Database receipt snapshot"],
  ["db-read-only-stall", "Database receipt snapshot"],
  ["db-read-stall", "Database receipt snapshot"],
  ["db-commit-stall", "Database receipt snapshot"],
  ["cleanup-stall", "Database pool shutdown"],
  ["db-read-and-cleanup-stall", "Database pool shutdown"],
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
  const select = queries.findIndex(query => /^select /i.test(query));
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
  for (const name of ["AUDIT_DATABASE_TIMEOUT_MS", "AUDIT_SHUTDOWN_TIMEOUT_MS"]) {
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
