import { Agent, createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import Stripe from "stripe";
import { expect, it } from "vitest";
import { onboardingCheckoutBudget } from "../../src/lib/onboardingCheckoutLimits";
import { onboardingCheckoutHttpClient } from "../../src/lib/onboardingCheckoutTransport";

it.each(["headers", "partial JSON"] as const)(
  "rejects a reply interrupted after $0 without retries, then deliberately repeats the same checkout",
  async boundary => {
    const budgetMs = 500;
    const schedulingSlackMs = 750;
    const requests: Array<{ method?: string; path?: string; key?: string; body: string }> = [];
    const agent = new Agent({ keepAlive: false });
    const reply = JSON.stringify({ id: "cs_test_interrupted_reply", object: "checkout.session" });
    const prefix = '{"id":"cs_test_';
    let firstResponse: ServerResponse | undefined;
    let headersReceived = false;
    let partialBodyReceived = "";
    let responseAborted = false;
    let invocations = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((req, res) => {
      const request = {
        method: req.method, path: req.url,
        key: req.headers["idempotency-key"] as string | undefined, body: "",
      };
      requests.push(request);
      req.setEncoding("utf8");
      req.on("data", chunk => { request.body += chunk; });
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(reply),
          "Stripe-Should-Retry": "true",
        });
        if (requests.length === 1) {
          firstResponse = res;
          res.flushHeaders();
          if (boundary === "partial JSON") res.write(prefix);
        } else {
          // A hidden retry would succeed and fail the first-call rejection.
          res.end(reply);
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;
      const nodeClient = Stripe.createNodeHttpClient(agent);
      const stripe = new Stripe("sk_test_synthetic_loopback_only", {
        host: "127.0.0.1", port, protocol: "http",
        httpClient: onboardingCheckoutHttpClient({
          getClientName: () => nodeClient.getClientName(),
          async makeRequest(...args) {
            invocations += 1;
            const response = await nodeClient.makeRequest(...args);
            if (invocations === 1) {
              headersReceived = true;
              const stream = response.getRawResponse();
              stream.once("aborted", () => { responseAborted = true; });
              const interrupt = () => { setImmediate(() => firstResponse!.destroy()); };
              if (boundary === "headers") interrupt();
              else stream.once("data", chunk => {
                partialBodyReceived += String(chunk);
                interrupt();
              });
            }
            return response;
          },
        }),
        maxNetworkRetries: 2, timeout: 5_000, telemetry: false,
      });
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        line_items: [{ price: "price_synthetic_loopback_only", quantity: 1 }],
        success_url: "https://example.invalid/success",
        cancel_url: "https://example.invalid/cancel",
      };
      const idempotencyKey = `onboarding:synthetic:interrupted:${boundary}:100`;
      const options = { ...onboardingCheckoutBudget(budgetMs).requestOptions(), idempotencyKey };
      expect(options.maxNetworkRetries).toBe(0);
      const started = performance.now();
      const outcome = await Promise.race([
        stripe.checkout.sessions.create(params, options).then(
          session => ({ ok: true as const, session }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("Interrupted reply did not settle within its bounded wait")),
            budgetMs + schedulingSlackMs,
          );
        }),
      ]);
      clearTimeout(watchdog);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Interrupted checkout silently succeeded");
      expect(outcome.error).toBeInstanceOf(Stripe.errors.StripeAPIError);
      expect(performance.now() - started).toBeLessThan(budgetMs + schedulingSlackMs);
      expect(headersReceived).toBe(true);
      expect(partialBodyReceived).toBe(boundary === "headers" ? "" : prefix);
      await delay(1_100);
      expect(responseAborted).toBe(true);
      expect(invocations).toBe(1);
      expect(requests).toHaveLength(1);

      const session = await stripe.checkout.sessions.create(params, {
        ...onboardingCheckoutBudget(budgetMs).requestOptions(), idempotencyKey,
      });
      expect(session.id).toBe("cs_test_interrupted_reply");
      expect(invocations).toBe(2);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        method: "POST", path: "/v1/checkout/sessions", key: idempotencyKey,
      });
      expect(requests[0].body).not.toBe("");
      expect(requests[1]).toEqual(requests[0]);
    } finally {
      clearTimeout(watchdog);
      agent.destroy();
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    }
  },
);

it.each([
  { status: 429, errorType: "rate_limit_error", sdkErrorType: "StripeRateLimitError" },
  { status: 503, errorType: "api_error", sdkErrorType: "StripeAPIError" },
])("suppresses SDK retries for HTTP $status while deliberate retries keep the same key", async ({
  status, errorType, sdkErrorType,
}) => {
  const requests: Array<{ method?: string; path?: string; key?: string; body: string }> = [];
  const agent = new Agent({ keepAlive: false });
  const idempotencyKey = `onboarding:synthetic:overloaded:${status}`;
  const controlKey = `onboarding:synthetic:retry-control:${status}`;
  const server = createServer((req, res) => {
    const request = {
      method: req.method,
      path: req.url,
      key: req.headers["idempotency-key"] as string | undefined,
      body: "",
    };
    requests.push(request);
    req.setEncoding("utf8");
    req.on("data", chunk => { request.body += chunk; });
    req.on("end", () => {
      const attempt = requests.filter(previous => previous.key === request.key).length;
      if (attempt === 1) {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Stripe-Should-Retry": "true",
          "Retry-After": "1",
        });
        res.end(JSON.stringify({ error: { type: errorType, message: "Synthetic provider overload" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "cs_test_loopback_only", object: "checkout.session" }));
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const stripe = new Stripe("sk_test_synthetic_loopback_only", {
      host: "127.0.0.1",
      port,
      protocol: "http",
      httpClient: Stripe.createNodeHttpClient(agent),
      maxNetworkRetries: 2,
      timeout: 5_000,
      telemetry: false,
    });
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: "price_synthetic_loopback_only", quantity: 1 }],
      success_url: "https://example.invalid/success",
      cancel_url: "https://example.invalid/cancel",
    };
    const budget = onboardingCheckoutBudget(3_000);
    const options = { ...budget.requestOptions(), idempotencyKey };
    expect(options.maxNetworkRetries).toBe(0);
    await expect(stripe.checkout.sessions.create(params, options)).rejects.toMatchObject({
      type: sdkErrorType,
      statusCode: status,
      message: "Synthetic provider overload",
      headers: { "stripe-should-retry": "true", "retry-after": "1" },
    });

    // Wait past Retry-After as well as the initial SDK backoff. No hidden POST
    // may be queued after the caller has received the provider's rejection.
    await delay(1_100);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/checkout/sessions",
      key: idempotencyKey,
    });
    expect(requests[0].body).not.toBe("");

    // Only a deliberate call with a fresh budget may send the second POST.
    const session = await stripe.checkout.sessions.create(params, {
      ...onboardingCheckoutBudget(3_000).requestOptions(),
      idempotencyKey,
    });
    expect(session.id).toBe("cs_test_loopback_only");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);

    // Positive control: the real SDK retries this same response when the
    // per-request override is omitted. The fixture is genuinely retryable.
    const control = await stripe.checkout.sessions.create(params, { idempotencyKey: controlKey });
    expect(control.id).toBe("cs_test_loopback_only");
    expect(requests).toHaveLength(4);
    expect(requests[2]).toEqual({ ...requests[0], key: controlKey });
    expect(requests[3]).toEqual(requests[2]);
  } finally {
    agent.destroy();
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
});

it("rejects a dropped connection without hidden retries, then deliberately repeats the exact checkout", async () => {
  const budgetMs = 2_000;
  const requests: Array<{ method?: string; path?: string; key?: string; body: string }> = [];
  let firstRequestRead = false;
  const agent = new Agent({ keepAlive: false });
  const server = createServer((req, res) => {
    const request = {
      method: req.method,
      path: req.url,
      key: req.headers["idempotency-key"] as string | undefined,
      body: "",
    };
    requests.push(request);
    req.setEncoding("utf8");
    req.on("data", chunk => { request.body += chunk; });
    req.on("end", () => {
      if (requests.length === 1) {
        // Read the entire POST before losing the connection, with no response.
        // This is a reset, not the delayed-response timeout covered below.
        firstRequestRead = true;
        req.socket.destroy();
      } else {
        // An unwanted SDK retry would succeed here and fail the rejection
        // assertion, rather than looking like another connection failure.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "cs_test_connection_drop", object: "checkout.session" }));
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const stripe = new Stripe("sk_test_synthetic_loopback_only", {
      host: "127.0.0.1",
      port,
      protocol: "http",
      httpClient: onboardingCheckoutHttpClient(Stripe.createNodeHttpClient(agent)),
      // Prove the budget overrides enabled SDK retries.
      maxNetworkRetries: 2,
      timeout: 5_000,
      telemetry: false,
    });
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: "price_synthetic_loopback_only", quantity: 1 }],
      success_url: "https://example.invalid/success",
      cancel_url: "https://example.invalid/cancel",
    };
    const idempotencyKey = "onboarding:synthetic:connection-drop:100";
    const budget = onboardingCheckoutBudget(budgetMs);
    const options = { ...budget.requestOptions(), idempotencyKey };
    expect(options.maxNetworkRetries).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(budgetMs);

    await expect(stripe.checkout.sessions.create(params, options)).rejects.toMatchObject({
      type: "StripeConnectionError",
      detail: {
        code: "ONBOARDING_CONNECTION_CLOSED",
        cause: { code: "ECONNRESET" },
      },
    });
    expect(firstRequestRead).toBe(true);
    expect(requests).toHaveLength(1);

    // Observe beyond the SDK's initial retry backoff, with real timers.
    await delay(1_100);
    expect(requests).toHaveLength(1);

    // Only an explicit new call may resend the payment attempt.
    const retryBudget = onboardingCheckoutBudget(budgetMs);
    const session = await stripe.checkout.sessions.create(params, {
      ...retryBudget.requestOptions(),
      idempotencyKey,
    });
    expect(session.id).toBe("cs_test_connection_drop");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/checkout/sessions",
      key: idempotencyKey,
    });
    expect(requests[0].body).not.toBe("");
    expect(requests[1]).toEqual(requests[0]);
  } finally {
    agent.destroy();
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
});

it("aborts the real SDK transport without retries, then deliberately retries the same key", async () => {
  // Real timers and real HTTP, but a short injected budget rather than a 10s test.
  const budgetMs = 250;
  const schedulingSlackMs = 750;
  const responseDelayMs = 3_000;
  const requests: Array<{ method?: string; path?: string; key?: string; body: string }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let firstRequestClosed = false;
  const agent = new Agent({ keepAlive: false });
  const server = createServer((req, res) => {
    const request = {
      method: req.method,
      path: req.url,
      key: req.headers["idempotency-key"] as string | undefined,
      body: "",
    };
    requests.push(request);
    req.setEncoding("utf8");
    req.on("data", chunk => { request.body += chunk; });
    if (requests.length === 1) {
      res.on("close", () => { firstRequestClosed = true; });
      // No headers or body before the SDK's timeout. A late provider reply
      // must not keep the caller waiting or trigger an automatic second POST.
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "cs_test_loopback_only", object: "checkout.session" }));
      }, responseDelayMs);
      timers.add(timer);
      res.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    } else {
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "cs_test_loopback_only", object: "checkout.session" }));
      });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const stripe = new Stripe("sk_test_synthetic_loopback_only", {
      host: "127.0.0.1",
      port,
      protocol: "http",
      httpClient: onboardingCheckoutHttpClient(Stripe.createNodeHttpClient(agent)),
      // Make the per-request zero-retry override observable, not a default.
      maxNetworkRetries: 2,
      timeout: 5_000,
      telemetry: false,
    });
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: "price_synthetic_loopback_only", quantity: 1 }],
      success_url: "https://example.invalid/success",
      cancel_url: "https://example.invalid/cancel",
    };
    const idempotencyKey = "onboarding:synthetic:initial:100";
    const budget = onboardingCheckoutBudget(budgetMs);
    const options = { ...budget.requestOptions(), idempotencyKey };
    expect(options.maxNetworkRetries).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(budgetMs);

    const started = performance.now();
    await expect(stripe.checkout.sessions.create(params, options)).rejects.toMatchObject({
      type: "StripeConnectionError",
      message: expect.stringContaining(`timeout being reached (${options.timeout}ms)`),
      detail: { code: "ETIMEDOUT" },
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(options.timeout! - 25);
    expect(elapsed).toBeLessThan(budgetMs + schedulingSlackMs);
    expect(requests).toHaveLength(1);
    expect(() => budget.requestOptions()).toThrow();

    // Observe beyond Stripe's initial retry backoff (500ms), with real time.
    // If retries were enabled the SDK would already have sent the second POST.
    await delay(1_100);
    expect(firstRequestClosed).toBe(true);
    expect(requests).toHaveLength(1);
    // A user retry gets a fresh deadline, not a fresh payment attempt identity.
    const retryBudget = onboardingCheckoutBudget(budgetMs);
    const session = await stripe.checkout.sessions.create(params, {
      ...retryBudget.requestOptions(),
      idempotencyKey,
    });
    expect(session.id).toBe("cs_test_loopback_only");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/checkout/sessions",
      key: idempotencyKey,
    });
    expect(requests[0].body).not.toBe("");
    expect(requests[1]).toEqual(requests[0]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    agent.destroy();
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
});
