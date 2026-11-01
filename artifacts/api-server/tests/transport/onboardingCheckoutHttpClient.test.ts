import { expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { onboardingCheckoutHttpClient } from "../../src/lib/onboardingCheckoutTransport";

const args: Parameters<Stripe.HttpClient["makeRequest"]> = [
  "127.0.0.1", 1, "/v1/checkout/sessions", "POST",
  { "Idempotency-Key": "synthetic-key" }, "mode=payment", "http", 250,
];

it.each(["ECONNRESET", "EPIPE"])("preserves %s as the cause without the SDK's forced-retry code", async code => {
  const cause = Object.assign(new Error("synthetic connection loss"), { code });
  const makeRequest = vi.fn().mockRejectedValue(cause);
  const client = onboardingCheckoutHttpClient({
    getClientName: () => "synthetic",
    makeRequest,
  });
  await expect(client.makeRequest(...args)).rejects.toMatchObject({
    code: "ONBOARDING_CONNECTION_CLOSED",
    cause,
  });
  expect(makeRequest).toHaveBeenCalledExactlyOnceWith(...args);
});

it.each(["ETIMEDOUT", "ENOTFOUND"])("does not alter other transport failures: %s", async code => {
  const cause = Object.assign(new Error("synthetic transport failure"), { code });
  const client = onboardingCheckoutHttpClient({
    getClientName: () => "synthetic",
    makeRequest: vi.fn().mockRejectedValue(cause),
  });
  await expect(client.makeRequest(...args)).rejects.toBe(cause);
});

it("forwards the request unchanged and returns the original HTTP response", async () => {
  const response = {} as Stripe.HttpClientResponse;
  const makeRequest = vi.fn().mockResolvedValue(response);
  const client = onboardingCheckoutHttpClient({
    getClientName: () => "synthetic",
    makeRequest,
  });
  expect(client.getClientName()).toBe("synthetic");
  expect(await client.makeRequest(...args)).toBe(response);
  expect(makeRequest).toHaveBeenCalledExactlyOnceWith(...args);
});

it.each([false, true])("rejects an interrupted JSON stream and cleans up its listeners (destroyed before guard=%s)", async early => {
  // An unconnected socket: exercise real Node stream event ordering, not I/O.
  const stream = new IncomingMessage(new Socket());
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  const cause = Object.assign(new Error("Synthetic response reset"), { code: "ECONNRESET" });
  const response: Stripe.HttpClientResponse = {
    getStatusCode: () => 200,
    getHeaders: () => ({ "content-type": "application/json" }),
    getRawResponse: () => stream,
    toStream: () => stream,
    // Model the installed SDK JSON reader's pending-on-interruption behavior.
    toJSON: () => new Promise<object>(() => {}),
  };
  const client = onboardingCheckoutHttpClient({
    getClientName: () => "synthetic",
    makeRequest: async () => {
      if (early) stream.destroy(cause);
      return response;
    },
  });
  try {
    const guarded = await client.makeRequest(...args);
    const json = guarded.toJSON();
    if (!early) stream.destroy(cause);
    await expect(json).rejects.toMatchObject({ code: "ONBOARDING_RESPONSE_INTERRUPTED" });
    if (!early) await expect(json).rejects.toHaveProperty("cause", cause);
    await closed;
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  } finally {
    stream.destroy();
    await closed;
  }
});

it("preserves a complete Node JSON response and removes its temporary listeners on close", async () => {
  const stream = new IncomingMessage(new Socket());
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  const payload = { id: "cs_test_synthetic_complete" };
  stream.complete = true;
  const toStream = vi.fn(() => stream);
  const client = onboardingCheckoutHttpClient({
    getClientName: () => "synthetic",
    makeRequest: async () => ({
      getStatusCode: () => 200,
      getHeaders: () => ({ "content-type": "application/json" }),
      getRawResponse: () => stream,
      toStream,
      toJSON: async () => payload,
    }),
  });
  try {
    const guarded = await client.makeRequest(...args);
    expect(await guarded.toJSON()).toBe(payload);
    expect(guarded.getStatusCode()).toBe(200);
    expect(guarded.getHeaders()).toEqual({ "content-type": "application/json" });
    expect(guarded.getRawResponse()).toBe(stream);
    const done = vi.fn();
    expect(guarded.toStream(done)).toBe(stream);
    expect(toStream).toHaveBeenCalledExactlyOnceWith(done);
    stream.destroy();
    await closed;
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  } finally {
    stream.destroy();
    await closed;
  }
});
