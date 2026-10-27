import type Stripe from "stripe";

// Use the sync package's persistence and lock, NOT its registration helper:
// that helper deletes other URLs and remote "orphans" across shared accounts.
export interface WebhookStore {
  getAccountId(): Promise<string>;
  getManagedWebhookByUrl(url: string): Promise<{ id: string; secret?: string; url: string } | null>;
  getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[];
  upsertManagedWebhooks(webhooks: Stripe.WebhookEndpoint[], accountId: string): Promise<unknown>;
  postgresClient: {
    withAdvisoryLock<T>(key: string, run: () => Promise<T>): Promise<T>;
    delete(table: string, id: string): Promise<boolean>;
  };
}

export type WebhookRegistration =
  | { status: "ready"; webhookId: string }
  | { status: "unavailable"; reason: string };

export async function configureStripeWebhook(options: {
  stripe: Pick<Stripe, "webhookEndpoints">;
  store: WebhookStore;
  url: string;
  production: boolean;
  allowPreviewCreation: boolean;
}): Promise<WebhookRegistration> {
  const { stripe, store, url, production, allowPreviewCreation } = options;
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname === "undefined" ||
      target.username || target.password || target.search || target.hash ||
      target.pathname !== "/api/stripe/webhook") {
    throw new Error("Stripe webhook callback URL is invalid");
  }
  const unavailable = (reason: string): WebhookRegistration => {
    if (production) throw new Error(`Stripe webhook unavailable: ${reason}`);
    return { status: "unavailable", reason };
  };
  const accountId = await store.getAccountId();
  return store.postgresClient.withAdvisoryLock(`webhook:${accountId}:${url}`, async () => {
    const local = await store.getManagedWebhookByUrl(url);
    let confirmedAbsentId: string | undefined;
    if (local) {
      // A cloned database is not proof that an endpoint belongs to this fork.
      if (local.url !== url || !local.secret) {
        return unavailable("local callback or signing secret is not usable");
      }
      try {
        const remote = await stripe.webhookEndpoints.retrieve(local.id);
        if (remote.url === url && remote.status === "enabled" &&
            (production || !remote.livemode)) {
          return { status: "ready", webhookId: remote.id };
        }
        return unavailable("existing endpoint does not match this callback or is disabled");
      } catch (error) {
        const missing = error as { statusCode?: number; code?: string };
        if (missing.statusCode !== 404 && missing.code !== "resource_missing") throw error;
        confirmedAbsentId = local.id;
      }
    }
    if (!production && !allowPreviewCreation) {
      return unavailable("preview registration is reuse-only; automatic payment callbacks are not configured");
    }

    // A remote endpoint's secret cannot be retrieved later. Without its local
    // secret we cannot safely adopt it, repoint it, or create a duplicate.
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    if (endpoints.has_more) {
      return unavailable("endpoint inventory is incomplete; registration was not attempted");
    }
    if (endpoints.data.some(endpoint => endpoint.url === url)) {
      return unavailable("callback already exists but its signing secret is not available locally");
    }
    if (endpoints.data.filter(endpoint => !endpoint.livemode).length >= 16) {
      return unavailable("sandbox webhook capacity is full; no existing endpoints were changed");
    }
    if (confirmedAbsentId) {
      // The URL/account-scoped lookup and remote 404 above prove that THIS
      // local cache row is stale. Its unique (url, account_id) would block
      // saving a replacement with a new ID. Remove only that exact cache ID,
      // using the sync persistence API, while still holding the callback lock.
      // Never use deleteManagedWebhook here: it also deletes from Stripe.
      await store.postgresClient.delete("_managed_webhooks", confirmedAbsentId);
    }
    let webhook: Stripe.WebhookEndpoint;
    try {
      webhook = await stripe.webhookEndpoints.create({
        url,
        enabled_events: store.getSupportedEventTypes(),
        description: "AK On Demand callback",
        metadata: { managed_by: production ? "akodd-production" : "akodd-development" },
      }, {
        // A deleted predecessor must not replay its old creation response
        // during Stripe's idempotency window.
        idempotencyKey: `akodd-webhook:${accountId}:${url}${confirmedAbsentId ? `:replace:${confirmedAbsentId}` : ""}`,
      });
    } catch (error) {
      // Another preview can fill the last slot after our read-only preflight.
      const failure = error as { type?: string; message?: string };
      if (failure.type === "StripeInvalidRequestError" &&
          /(?:maximum|limit|too many).*(?:webhook|endpoint)|(?:webhook|endpoint).*(?:maximum|limit|too many)/i.test(failure.message ?? "")) {
        return unavailable("sandbox webhook capacity is full; no existing endpoints were changed");
      }
      throw error;
    }
    if (!webhook.secret) throw new Error("Stripe webhook creation returned no signing secret");
    await store.upsertManagedWebhooks([webhook], accountId);
    return { status: "ready", webhookId: webhook.id };
  });
}
