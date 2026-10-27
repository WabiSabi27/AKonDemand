import { describe, it, expect, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { api, TEST_PREFIX } from "./helpers";

const newEmail = () =>
  `${TEST_PREFIX}_auth_${Math.random().toString(36).slice(2, 8)}@test.local`;

describe("POST /auth/customer", () => {
  // The /auth/customer route generates its OWN id (not prefixed). Clean those
  // by email so we don't leave stragglers.
  afterAll(async () => {
    await db.delete(usersTable).where(like(usersTable.email, `${TEST_PREFIX}_auth_%`));
  });

  it("creates a new customer and returns a usable JWT", async () => {
    const email = newEmail();
    const res = await api()
      .post("/api/auth/customer")
      .send({ email, name: "Jane Tester" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("customer");

    // Verify the issued token actually works.
    const me = await api()
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(res.body.user.id);
  });

  it("re-uses the same row when an existing customer logs in again", async () => {
    const email = newEmail();
    const first = await api().post("/api/auth/customer").send({ email, name: "First" });
    const second = await api().post("/api/auth/customer").send({ email, name: "Second" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    // Name update should have stuck.
    expect(second.body.user.name).toBe("Second");
  });

  it("rejects login when the email is registered to a non-customer role", async () => {
    // Seed a business-role user with this email directly so /auth/customer
    // hits the role-mismatch branch.
    const email = newEmail();
    const id = `${TEST_PREFIX}_auth_biz_${Math.random().toString(36).slice(2, 8)}`;
    await db
      .insert(usersTable)
      .values({ id, email, name: "Biz Owner", role: "business" });
    const res = await api().post("/api/auth/customer").send({ email, name: "x" });
    expect(res.status).toBe(403);
  });
});

describe("GET /auth/me", () => {
  it("rejects requests without a token", async () => {
    const res = await api().get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a malformed token", async () => {
    const res = await api().get("/api/auth/me").set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});
