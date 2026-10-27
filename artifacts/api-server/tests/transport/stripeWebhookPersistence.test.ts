import { afterEach, describe, expect, it, vi } from "vitest";
import { newDb } from "pg-mem";
import { StripeSync } from "stripe-replit-sync";
import type Stripe from "stripe";
import { configureStripeWebhook } from "../../src/lib/stripeWebhookLifecycle";

// Actual sync-package SQL against an isolated in-memory Postgres-compatible
// database, including BOTH real uniqueness rules. No shared DB or Stripe calls.
const url = "https://preview.example/api/stripe/webhook";
const currentAccount = "acct_original";
const oldWebhook = {
  id: "we_old", url, status: "enabled", livemode: false,
  secret: "whsec_old_synthetic", created: 1,
} as Stripe.WebhookEndpoint;
const newWebhook = {
  ...oldWebhook, id: "we_replacement", secret: "whsec_new_synthetic", created: 2,
};

async function persistenceFixture() {
  const memory = newDb();
  memory.public.none(`
    CREATE SCHEMA stripe;
    CREATE TABLE stripe._managed_webhooks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      status TEXT,
      livemode BOOLEAN,
      created BIGINT,
      last_synced_at TIMESTAMPTZ,
      UNIQUE (url, account_id)
    );
  `);
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  async function startStore() {
    const sync = new StripeSync({
      poolConfig: { connectionString: "postgres://synthetic:synthetic@127.0.0.1:1/unused" },
      stripeSecretKey: "sk_test_synthetic_no_network",
    });
    // Replace the unopened real pool before any library SQL runs.
    await sync.postgresClient.pool.end();
    sync.postgresClient.pool = pool as typeof sync.postgresClient.pool;
    vi.spyOn(sync, "getAccountId").mockResolvedValue(currentAccount);
    vi.spyOn(sync.postgresClient, "withAdvisoryLock").mockImplementation(async (_key, run) => run());
    return sync;
  }
  const store = await startStore();
  await store.upsertManagedWebhooks([oldWebhook], currentAccount);
  await store.upsertManagedWebhooks([
    { ...oldWebhook, id: "we_production", url: "https://production.example/api/stripe/webhook" },
  ], currentAccount);
  await store.upsertManagedWebhooks([
    { ...oldWebhook, id: "we_other_account" },
  ], "acct_other");

  const webhookEndpoints = {
    retrieve: vi.fn(async (id: string) => {
      if (id === oldWebhook.id) throw { statusCode: 404, code: "resource_missing" };
      if (id === newWebhook.id) return newWebhook;
      throw new Error("Unexpected remote lookup");
    }),
    list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    create: vi.fn().mockResolvedValue(newWebhook),
    del: vi.fn(() => { throw new Error("Remote deletion forbidden"); }),
    update: vi.fn(() => { throw new Error("Remote update forbidden"); }),
  };
  const run = (sync: StripeSync, production = true) => configureStripeWebhook({
    store: sync,
    stripe: { webhookEndpoints } as unknown as Pick<Stripe, "webhookEndpoints">,
    url, production, allowPreviewCreation: true,
  });
  const rows = async () => (await pool.query(
    "SELECT id, account_id, url, secret FROM stripe._managed_webhooks ORDER BY id",
  )).rows;
  return { store, webhookEndpoints, run, rows, pool, startStore };
}

describe("persisting a replacement after a confirmed remote 404", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reproduces the real URL/account uniqueness failure when stale metadata is not superseded", async () => {
    const f = await persistenceFixture();
    try {
      await expect(f.store.upsertManagedWebhooks([newWebhook], currentAccount))
        .rejects.toMatchObject({ code: "23505" });
      expect((await f.rows()).map(row => row.id)).toEqual([
        "we_old", "we_other_account", "we_production",
      ]);
    } finally {
      await f.pool.end();
    }
  });

  it.each([true, false])("saves the new secret and reuses it after restart (production=%s)", async production => {
    const f = await persistenceFixture();
    try {
      const protectedRows = (await f.rows()).filter(row => row.id !== "we_old");
      expect(await f.run(f.store, production)).toEqual({
        status: "ready", webhookId: "we_replacement",
      });
      const stored = await f.store.getManagedWebhookByUrl(url);
      expect(stored).toMatchObject({ id: newWebhook.id, url, secret: newWebhook.secret });
      expect((await f.rows()).filter(row => row.id !== newWebhook.id)).toEqual(protectedRows);
      expect(f.webhookEndpoints.create).toHaveBeenCalledWith(
        expect.objectContaining({ url }),
        { idempotencyKey: `akodd-webhook:${currentAccount}:${url}:replace:we_old` },
      );
      const restarted = await f.startStore();
      expect(await f.run(restarted, production)).toEqual({
        status: "ready", webhookId: "we_replacement",
      });
      expect(f.webhookEndpoints.create).toHaveBeenCalledTimes(1);
      expect(f.webhookEndpoints.del).not.toHaveBeenCalled();
      expect(f.webhookEndpoints.update).not.toHaveBeenCalled();
      expect(await restarted.getManagedWebhookByUrl(url)).toMatchObject({ secret: newWebhook.secret });
    } finally {
      await f.pool.end();
    }
  });

  it("does not supersede a stale row at capacity or when absence is unconfirmed", async () => {
    const f = await persistenceFixture();
    try {
      const before = await f.rows();
      f.webhookEndpoints.list.mockResolvedValueOnce({
        data: Array.from({ length: 16 }, (_, i) => ({
          ...oldWebhook, id: `we_${i}`, url: `https://other-${i}.example/webhook`,
        })), has_more: false,
      });
      await expect(f.run(f.store)).rejects.toThrow("capacity is full");
      expect(await f.rows()).toEqual(before);
      f.webhookEndpoints.retrieve.mockRejectedValueOnce({ statusCode: 403 });
      await expect(f.run(f.store)).rejects.toMatchObject({ statusCode: 403 });
      expect(await f.rows()).toEqual(before);
      expect(f.webhookEndpoints.create).not.toHaveBeenCalled();
    } finally {
      await f.pool.end();
    }
  });
});
