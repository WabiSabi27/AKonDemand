import { Agent, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import Stripe from "stripe";
import { expect, it, vi } from "vitest";
import { onboardingCheckoutBudget } from "../../src/lib/onboardingCheckoutLimits";
import { onboardingCheckoutHttpClient } from "../../src/lib/onboardingCheckoutTransport";

it("passes EPIPE through the installed SDK without an implicit checkout retry, preserving an explicit retry's identity", async () => {
  const requests: Array<{ method?: string; path?: string; key?: string; body: string }> = [];
  const agent = new Agent({ keepAlive: false });
  const server = createServer((req, res) => {
    const request = {
      method: req.method, path: req.url,
      key: req.headers["idempotency-key"] as string | undefined,
      body: "",
    };
    requests.push(request);
    req.setEncoding("utf8");
    req.on("data", chunk => { request.body += chunk; });
    req.on("end", () => {
      // A hidden SDK retry would succeed, failing the expected rejection rather
      // than being mistaken for another transport failure.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "cs_test_synthetic_epipe", object: "checkout.session" }));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const nodeClient = Stripe.createNodeHttpClient(agent);
    const cause = Object.assign(new Error("Synthetic write EPIPE"), {
      code: "EPIPE", errno: -32, syscall: "write",
    });
    const makeRequest = vi.fn((...args: Parameters<Stripe.HttpClient["makeRequest"]>) => {
      if (args[0] !== "127.0.0.1" || String(args[1]) !== String(port) || args[6] !== "http") {
        throw new Error("Only this fixture's loopback server is allowed");
      }
      // A deterministic underlying write failure: no OS-dependent socket race,
      // but the real SDK and production onboarding adapter both remain active.
      if (makeRequest.mock.calls.length === 1) return Promise.reject(cause);
      return nodeClient.makeRequest(...args);
    });
    const stripe = new Stripe("sk_test_synthetic_loopback_only", {
      host: "127.0.0.1", port, protocol: "http",
      httpClient: onboardingCheckoutHttpClient({
        getClientName: () => nodeClient.getClientName(),
        makeRequest,
      }),
      // The per-request override must suppress retries despite this default.
      maxNetworkRetries: 2, timeout: 5_000, telemetry: false,
    });
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: "price_synthetic_epipe", quantity: 1 }],
      success_url: "https://example.invalid/success",
      cancel_url: "https://example.invalid/cancel",
    };
    const idempotencyKey = "onboarding:synthetic:epipe:100";
    const options = { ...onboardingCheckoutBudget(2_000).requestOptions(), idempotencyKey };
    expect(options.maxNetworkRetries).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(2_000);

    const failure = await stripe.checkout.sessions.create(params, options).catch(error => error);
    expect(failure).toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect(failure).toMatchObject({
      type: "StripeConnectionError",
      detail: { code: "ONBOARDING_CONNECTION_CLOSED", cause: { code: "EPIPE", syscall: "write" } },
    });
    expect(failure.detail.cause).toBe(cause);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    await delay(1_100); // Beyond the SDK's initial retry backoff, using real time.
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);

    const first = makeRequest.mock.calls[0];
    expect(first[2]).toBe("/v1/checkout/sessions");
    expect(first[3]).toBe("POST");
    expect(first[4]).toMatchObject({ "Idempotency-Key": idempotencyKey });
    expect(first[5]).toBeTruthy();
    expect(new URLSearchParams(first[5]!).get("line_items[0][price]")).toBe("price_synthetic_epipe");

    const retryOptions = { ...onboardingCheckoutBudget(2_000).requestOptions(), idempotencyKey };
    expect(retryOptions.maxNetworkRetries).toBe(0);
    const session = await stripe.checkout.sessions.create(params, retryOptions);
    expect(session.id).toBe("cs_test_synthetic_epipe");
    expect(makeRequest).toHaveBeenCalledTimes(2);
    const second = makeRequest.mock.calls[1];
    expect(second.slice(0, 4)).toEqual(first.slice(0, 4));
    expect(second[4]).toMatchObject({ "Idempotency-Key": idempotencyKey });
    expect(second[5]).toBe(first[5]);
    expect(requests).toEqual([{
      method: "POST", path: "/v1/checkout/sessions", key: idempotencyKey, body: first[5],
    }]);
  } finally {
    agent.destroy();
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
});
