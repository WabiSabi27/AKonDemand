import Stripe from "stripe";
import { IncomingMessage } from "node:http";

/**
 * The installed Node SDK's JSON reader listens only for data/end. An aborted
 * response can emit error/close without end, leaving its promise pending after
 * makeRequest has already resolved at the headers boundary.
 */
function guardResponse(response: Stripe.HttpClientResponse): Stripe.HttpClientResponse {
  if (typeof response.getRawResponse !== "function") return response;
  const stream = response.getRawResponse();
  if (!(stream instanceof IncomingMessage)) return response;

  let fail!: (cause: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => {
    fail = cause => reject(Object.assign(
      new Error("Onboarding payment response was interrupted", { cause }),
      { code: "ONBOARDING_RESPONSE_INTERRUPTED" },
    ));
  });
  // A stream may fail before the SDK invokes toJSON (or a consumer may choose
  // toStream). Own the early rejection without suppressing the JSON caller's.
  void interrupted.catch(() => {});
  const onError = (cause: Error) => fail(cause);
  const onClose = () => {
    if (!stream.complete) fail(new Error("Payment response closed before completion"));
    // Keep the error listener until close: Node emits aborted, then error,
    // then close, and removing it on aborted would expose an uncaught error.
    stream.removeListener("error", onError);
    stream.removeListener("close", onClose);
  };
  stream.on("error", onError);
  stream.once("close", onClose);
  if (stream.destroyed && !stream.complete) {
    // destroyed can become true before Node emits error/close. Reject now,
    // but keep owning errors until the actual close event performs cleanup.
    fail(new Error("Payment response closed before completion"));
  }

  return {
    getStatusCode: () => response.getStatusCode(),
    getHeaders: () => response.getHeaders(),
    getRawResponse: () => response.getRawResponse(),
    toStream: callback => response.toStream(callback),
    toJSON: () => Promise.race([response.toJSON(), interrupted]),
  };
}

/**
 * Stripe retries the first ECONNRESET/EPIPE even with maxNetworkRetries: 0.
 * Normalize only those transport failures so the onboarding request's explicit
 * zero-retry option is respected. Keep the original error for diagnostics.
 * Other clients retain the SDK's normal connection recovery behavior.
 */
export function onboardingCheckoutHttpClient(
  client: Stripe.HttpClient = Stripe.createNodeHttpClient(),
): Stripe.HttpClient {
  return {
    getClientName: () => client.getClientName(),
    async makeRequest(...args: Parameters<Stripe.HttpClient["makeRequest"]>) {
      try {
        return guardResponse(await client.makeRequest(...args));
      } catch (cause) {
        if (
          cause && typeof cause === "object" && "code" in cause &&
          (cause.code === "ECONNRESET" || cause.code === "EPIPE")
        ) {
          throw Object.assign(
            new Error("Onboarding payment connection closed without a response", { cause }),
            { code: "ONBOARDING_CONNECTION_CLOSED" },
          );
        }
        throw cause;
      }
    },
  };
}
