import { vi } from "vitest";
import type Stripe from "stripe";
import { configureStripeWebhook, type WebhookStore } from "../../../src/lib/stripeWebhookLifecycle";

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

export function syntheticEndpoint(id: string, url: string, extra = {}) {
  return {
    id, url, status: "enabled", livemode: false,
    metadata: { managed_by: "akodd-development" }, ...extra,
  } as Stripe.WebhookEndpoint;
}

type SavedWebhook = { id: string; url: string; secret?: string };
type PersistenceHooks = {
  beforeSave?: (webhook: Stripe.WebhookEndpoint) => Promise<void>;
  afterSave?: (webhook: Stripe.WebhookEndpoint) => Promise<void>;
};

// Private in-memory surrogate for shared Postgres and Stripe. Separate starters
// have separate store objects but share account/URL uniqueness and blocking
// advisory locks. No app boot, database client, credentials or network imports.
export function registrationFixture(hooks: PersistenceHooks = {}) {
  const accountId = "acct_synthetic_concurrency";
  const saved = new Map<string, SavedWebhook>();
  const remote = new Map<string, Stripe.WebhookEndpoint>();
  const idempotency = new Map<string, Stripe.WebhookEndpoint>();
  const lockTails = new Map<string, Promise<void>>();
  const lockRequests: string[] = [];
  const lockEntries: string[] = [];
  const localReads: Array<{ url: string; value: SavedWebhook | null }> = [];
  const requestWaiters: Array<{ count: number; ready: () => void }> = [];
  let created = 0;

  const webhookEndpoints = {
    retrieve: vi.fn(async (id: string) => {
      const value = remote.get(id);
      if (!value) throw { statusCode: 404, code: "resource_missing" };
      // Stripe never returns the signing secret on retrieval or listing.
      return structuredClone(value);
    }),
    list: vi.fn(async () => ({ data: structuredClone([...remote.values()]), has_more: false })),
    create: vi.fn(async (input: Stripe.WebhookEndpointCreateParams, options: Stripe.RequestOptions) => {
      if (!options.idempotencyKey) throw new Error("Fixture requires an idempotency key");
      const replay = idempotency.get(options.idempotencyKey);
      if (replay) return structuredClone(replay);
      const id = `we_synthetic_${++created}`;
      const value = syntheticEndpoint(id, input.url, { metadata: input.metadata });
      remote.set(id, value);
      const response = { ...value, secret: `whsec_synthetic_${created}` };
      idempotency.set(options.idempotencyKey, response);
      return structuredClone(response);
    }),
    update: vi.fn(() => { throw new Error("Remote updates forbidden"); }),
    del: vi.fn(() => { throw new Error("Remote deletes forbidden"); }),
  };

  async function withAdvisoryLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = lockTails.get(key) ?? Promise.resolve();
    const release = gate();
    const tail = previous.then(() => release.promise);
    lockTails.set(key, tail);
    lockRequests.push(key);
    for (const waiter of requestWaiters) {
      if (lockRequests.length >= waiter.count) waiter.ready();
    }
    await previous;
    lockEntries.push(key);
    try {
      return await run();
    } finally {
      // Release on successful save, failed save and lost acknowledgement alike.
      release.open();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    }
  }

  const deleteLocal = vi.fn(async (table: string, id: string) => {
    if (table !== "_managed_webhooks") throw new Error("Unexpected cache table");
    for (const [url, webhook] of saved) {
      if (webhook.id === id) return saved.delete(url);
    }
    return false;
  });
  const persist = vi.fn(async (webhooks: Stripe.WebhookEndpoint[], account: string) => {
    if (account !== accountId || webhooks.length !== 1) throw new Error("Unexpected persistence scope");
    const webhook = webhooks[0];
    await hooks.beforeSave?.(webhook);
    const existing = saved.get(webhook.url);
    if (existing && existing.id !== webhook.id) throw new Error("Duplicate account/callback cache row");
    saved.set(webhook.url, { id: webhook.id, url: webhook.url, secret: webhook.secret });
    await hooks.afterSave?.(webhook);
  });

  function starter(url: string) {
    const store: WebhookStore = {
      getAccountId: async () => accountId,
      getManagedWebhookByUrl: async callback => {
        const value = structuredClone(saved.get(callback) ?? null);
        localReads.push({ url: callback, value });
        return value;
      },
      getSupportedEventTypes: () => ["checkout.session.completed"],
      upsertManagedWebhooks: persist,
      postgresClient: { withAdvisoryLock, delete: deleteLocal },
    };
    return {
      store,
      run: () => configureStripeWebhook({
        stripe: { webhookEndpoints } as unknown as Pick<Stripe, "webhookEndpoints">,
        store, url, production: false, allowPreviewCreation: true,
      }),
    };
  }

  function waitForRequests(count: number) {
    if (lockRequests.length >= count) return Promise.resolve();
    return new Promise<void>(ready => { requestWaiters.push({ count, ready }); });
  }

  return {
    accountId, saved, remote, webhookEndpoints, deleteLocal, persist,
    lockRequests, lockEntries, localReads, starter, waitForRequests,
  };
}
