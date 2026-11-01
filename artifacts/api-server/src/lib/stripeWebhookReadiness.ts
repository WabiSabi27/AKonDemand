import type { AdminWebhookReadiness } from "@workspace/api-zod";
import type { WebhookRegistration } from "./stripeWebhookLifecycle";

type Snapshot = Pick<AdminWebhookReadiness, "status" | "reason">;
let snapshot: Snapshot = {
  status: "checking",
  reason: "Payment callback startup verification has not completed.",
};

// Only fixed, reviewed explanations cross the admin API boundary. Never return
// raw Stripe errors, callback URLs, endpoint IDs, signing secrets or credentials.
const safeReasons: Record<string, string> = {
  "local callback or signing secret is not usable":
    "This server does not have a usable payment callback configuration.",
  "existing endpoint does not match this callback or is disabled":
    "The configured payment callback is disabled or does not match this server.",
  "preview registration is reuse-only; automatic payment callbacks are not configured":
    "This preview has no verified payment callback. Automatic payment updates are unavailable here.",
  "endpoint inventory is incomplete; registration was not attempted":
    "Payment callback verification could not complete. No endpoints were changed.",
  "callback already exists but its signing secret is not available locally":
    "This server cannot securely use its existing payment callback.",
  "sandbox webhook capacity is full; no existing endpoints were changed":
    "Sandbox payment callback capacity is full. Existing endpoints were not changed.",
};

export function getWebhookReadiness(): AdminWebhookReadiness {
  return {
    ...snapshot,
    environment: process.env.NODE_ENV === "production" ? "production" : "preview",
  };
}

export async function trackWebhookRegistration(
  register: () => Promise<WebhookRegistration>,
): Promise<WebhookRegistration> {
  snapshot = { status: "checking", reason: "Payment callback startup verification is in progress." };
  try {
    const result = await register();
    snapshot = result.status === "ready"
      ? { status: "ready", reason: "This server verified an enabled payment callback at startup." }
      : {
        status: "unavailable",
        reason: Object.prototype.hasOwnProperty.call(safeReasons, result.reason)
          ? safeReasons[result.reason]
          : "Automatic payment updates are unavailable on this server.",
      };
    return result;
  } catch (error) {
    snapshot = {
      status: "unavailable",
      reason: "Payment callback startup verification failed. Check the server configuration.",
    };
    // Preserve fatal production startup behavior and the original diagnostic.
    throw error;
  }
}
