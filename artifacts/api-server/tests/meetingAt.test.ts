/**
 * Task 6 — meeting times must not drift across timezones.
 *
 * `biz_accounts.meeting_at` is a `TIMESTAMP` (no tz) column round-tripped as
 * UTC ISO strings. These tests lock the invariant: the instant an admin sends
 * (in ANY offset) is exactly the instant returned by the PATCH response and by
 * a later re-fetch — byte-identical UTC ISO. They also lock the authz rule
 * that non-admins cannot change meetingAt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, bizAccountsTable, usersTable } from "@workspace/db";
import { api, mintToken, createAdminUser, TEST_PREFIX, type TestUser } from "./helpers";

const rand = () => Math.random().toString(36).slice(2, 8);

async function createBizAccount(): Promise<{ id: string; ownerId: string; ownerToken: string }> {
  const ownerId = `${TEST_PREFIX}_mtg_owner_${rand()}`;
  const id = `${TEST_PREFIX}_mtg_ba_${rand()}`;
  const email = `${id}@test.local`;
  await db.insert(usersTable).values({ id: ownerId, email, name: "Mtg Owner", role: "business" });
  await db.insert(bizAccountsTable).values({
    id,
    businessName: `${TEST_PREFIX} Mtg Biz`,
    ownerName: "Mtg Owner",
    email,
    passwordHash: "x",
    businessType: "home-based",
    status: "accepted",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ownerId,
  });
  return {
    id,
    ownerId,
    ownerToken: mintToken({ userId: ownerId, role: "business", businessId: id }),
  };
}

describe("PATCH /biz-accounts/:id meetingAt — timezone stability", () => {
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createAdminUser();
  });

  afterAll(async () => {
    await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${TEST_PREFIX}_mtg_%`));
    await db.delete(usersTable).where(like(usersTable.id, `${TEST_PREFIX}_mtg_%`));
  });

  it("round-trips the exact instant when sent with a non-UTC offset (Alaska time)", async () => {
    const { id } = await createBizAccount();
    // 10:30 AM Alaska (UTC-8 during AKDT) == 18:30 UTC.
    const sent = "2026-09-15T10:30:00-08:00";
    const expectedUtc = new Date(sent).toISOString(); // "2026-09-15T18:30:00.000Z"
    expect(expectedUtc).toBe("2026-09-15T18:30:00.000Z");

    const patch = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ meetingAt: sent });
    expect(patch.status).toBe(200);
    expect(patch.body.meetingAt).toBe(expectedUtc);

    // Re-fetch through the public status endpoint: same instant, no drift.
    const refetch = await api().get(`/api/biz-accounts/${id}/status`);
    expect(refetch.status).toBe(200);
    expect(refetch.body.meetingAt).toBe(expectedUtc);

    // And the raw DB row holds the same instant.
    const [row] = await db.select().from(bizAccountsTable).where(like(bizAccountsTable.id, id));
    expect(row.meetingAt?.toISOString()).toBe(expectedUtc);
  });

  it("round-trips a UTC ISO string exactly, and null clears the meeting", async () => {
    const { id } = await createBizAccount();
    const sent = "2026-10-01T21:00:00.000Z";

    const patch = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ meetingAt: sent });
    expect(patch.status).toBe(200);
    expect(patch.body.meetingAt).toBe(sent);

    const cleared = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ meetingAt: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.meetingAt).toBeNull();
  });

  it("silently ignores meetingAt from the SP owner (non-admin cannot change it)", async () => {
    const { id, ownerToken } = await createBizAccount();
    const original = "2026-11-05T19:00:00.000Z";
    await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ meetingAt: original });

    const attempt = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ meetingAt: "2027-01-01T00:00:00.000Z", phone: "907-555-0000" });
    expect(attempt.status).toBe(200);
    // Owner-editable field applied; meetingAt untouched.
    expect(attempt.body.phone).toBe("907-555-0000");
    expect(attempt.body.meetingAt).toBe(original);

    const refetch = await api().get(`/api/biz-accounts/${id}/status`);
    expect(refetch.body.meetingAt).toBe(original);
  });

  it("rejects meetingAt changes from unrelated users entirely", async () => {
    const { id } = await createBizAccount();
    const stranger = await createBizAccount(); // different biz account/owner
    const res = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${stranger.ownerToken}`)
      .send({ meetingAt: "2027-01-01T00:00:00.000Z" });
    expect(res.status).toBe(403);
  });
});
