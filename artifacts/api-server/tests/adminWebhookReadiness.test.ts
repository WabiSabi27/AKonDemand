import { afterEach, expect, it, vi } from "vitest";
import { api, createAdminUser, mintToken, TEST_PREFIX } from "./helpers";
import * as readiness from "../src/lib/stripeWebhookReadiness";

afterEach(() => vi.restoreAllMocks());

it("does not expose payment readiness to anonymous users or non-admin roles", async () => {
  const getter = vi.spyOn(readiness, "getWebhookReadiness");
  expect((await api().get("/api/admin/metrics")).status).toBe(401);
  for (const role of ["customer", "business"] as const) {
    const token = mintToken({ userId: `${TEST_PREFIX}_readiness_${role}`, role });
    expect((await api().get("/api/admin/metrics").set("Authorization", `Bearer ${token}`)).status).toBe(403);
  }
  expect(getter).not.toHaveBeenCalled();
});

it.each(["checking", "ready", "unavailable"] as const)("returns the read-only %s snapshot to a current admin", async status => {
  const admin = await createAdminUser();
  const snapshot = { status, environment: "preview" as const, reason: "Fixed safe explanation." };
  const getter = vi.spyOn(readiness, "getWebhookReadiness").mockReturnValue(snapshot);
  const response = await api().get("/api/admin/metrics").set("Authorization", `Bearer ${admin.token}`);
  expect(response.status).toBe(200);
  expect(response.body.paymentWebhook).toEqual(snapshot);
  expect(Object.keys(response.body.paymentWebhook).sort()).toEqual(["environment", "reason", "status"]);
  expect(getter).toHaveBeenCalledTimes(1);
});
