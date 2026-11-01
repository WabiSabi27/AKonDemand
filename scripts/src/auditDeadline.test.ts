import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import Stripe from "stripe";
import { AuditDeadline } from "./auditDeadline";

test("audit read timeout aborts an uncooperative reader and never invokes new reads after the total deadline", async () => {
  let timeouts = 0;
  const deadline = new AuditDeadline(100, () => { timeouts++; });
  try {
    let signal: AbortSignal | undefined;
    await assert.rejects(deadline.run("Synthetic read", 20, options => {
      signal = options.signal;
      return new Promise<never>(() => {});
    }), /Synthetic read: timed out after \d+ms\. \[AUDIT_TIMEOUT\]/);
    assert.equal(signal?.aborted, true);
    assert.equal(timeouts, 1);
    await assert.rejects(deadline.run("Synthetic read", 500, () => new Promise<never>(() => {})),
      /Audit deadline: timed out after 100ms\. \[AUDIT_TIMEOUT\]/);
    let invoked = false;
    await assert.rejects(deadline.run("Late read", 100, async () => {
      invoked = true;
    }), /AUDIT_TIMEOUT/);
    assert.equal(invoked, false);
  } finally {
    deadline.close();
  }
});

test("settled reads remove their abort listeners and timers, including synchronous exceptions", async () => {
  let timeouts = 0;
  const deadline = new AuditDeadline(10_000, () => { timeouts++; });
  try {
    // Enough reads to catch listener accumulation warnings on the shared signal.
    for (let index = 0; index < 30; index++) {
      assert.equal(await deadline.run("Synthetic read", 20, async () => index), index);
    }
    await assert.rejects(deadline.run("Synthetic throw", 20, () => {
      throw new Error("synthetic failure");
    }), /synthetic failure/);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(timeouts, 0);
  } finally {
    deadline.close();
  }
});

test("positive fractional monotonic budgets become integer SDK timeouts that actually close a stalled transport without retrying", async () => {
  let requests = 0;
  const server = createServer(() => { requests++; /* Deliberately never respond. */ });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const stripe = new Stripe("sk_test_audit_synthetic", {
    host: "127.0.0.1", port: address.port, protocol: "http",
    timeout: 5_000, maxNetworkRetries: 2,
  });
  const deadline = new AuditDeadline(150, () => {});
  try {
    // Obtain the actual options after a monotonic subtraction; close the scope
    // before the request to prove the SDK's own timeout, not Promise.race, works.
    const { timeout, maxNetworkRetries } = await deadline.run("Transport options", 5_000, async options => options);
    deadline.close();
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 150);
    const started = performance.now();
    await assert.rejects(stripe.balance.retrieve({}, { timeout, maxNetworkRetries }), /timeout/i);
    assert.ok(performance.now() - started < 2_000, "The SDK must not fall back to its 5-second default");
    assert.equal(requests, 1);
  } finally {
    deadline.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("the audit connector uses the read signal for headers and body waits; normal script clients keep default SDK settings", async () => {
  // This test process never calls a real connector or uses real credentials.
  process.env.REPL_IDENTITY = "audit-synthetic-identity";
  process.env.REPLIT_CONNECTORS_HOSTNAME = "audit-connector.invalid";
  const originalFetch = globalThis.fetch;
  const { getAuditStripeClient, getUncachableStripeClient } = await import("./stripeClient");
  let receivedSignal: AbortSignal | null | undefined;
  const response = { settings: { publishable: "pk_test_synthetic", secret: "sk_test_synthetic" } };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).hostname, "audit-connector.invalid");
    receivedSignal = options?.signal;
    return new Response(JSON.stringify(response));
  };
  const deadline = new AuditDeadline(5_000, () => {});
  const field = (client: Stripe, name: string): unknown => Reflect.get(client, "getApiField").call(client, name);
  try {
    const audit = await deadline.run("Stripe connection", 100, getAuditStripeClient);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(field(audit, "timeout"), 100);
    assert.equal(field(audit, "maxNetworkRetries"), 0);
    const normal = await getUncachableStripeClient();
    assert.equal(receivedSignal, undefined);
    const defaults = new Stripe("sk_test_synthetic");
    assert.equal(field(normal, "timeout"), field(defaults, "timeout"));
    assert.equal(field(normal, "maxNetworkRetries"), field(defaults, "maxNetworkRetries"));

    for (const wait of ["headers", "body"]) {
      globalThis.fetch = async (_url, options) => {
        receivedSignal = options?.signal;
        if (wait === "headers") return new Promise<Response>(() => {});
        return { ok: true, json: () => new Promise(() => {}) } as Response;
      };
      await assert.rejects(deadline.run("Stripe connection", 20, getAuditStripeClient), /AUDIT_TIMEOUT/);
      // The asynchronous fetch stub assigns this after the earlier undefined
      // assertion; TypeScript cannot track assignments through that callback.
      assert.equal((receivedSignal as AbortSignal | undefined)?.aborted, true);
    }
  } finally {
    deadline.close();
    globalThis.fetch = originalFetch;
  }
});
