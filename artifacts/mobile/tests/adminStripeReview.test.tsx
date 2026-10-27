import React from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Alert, Linking, Platform } from "react-native";
import AdminStripeWebhooksScreen from "../app/admin-stripe-webhooks";
import { renderDashboard } from "./support/dashboard";

vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("@/components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAwareScrollView: () => null }));

const originalUrl = "https://dashboard.stripe.com/test/search?query=cs_test_Original123";
const extraUrl = "https://dashboard.stripe.com/test/search?query=cs_test_Extra456";
function load(review: object | undefined, status = "pending") {
  const fetchMock = vi.fn(async () => Response.json({ entries: [{
    id: "sdl_synthetic", eventId: "evt_synthetic", eventType: "checkout.session.completed",
    handlerName: "biz_account_paid", status, attempts: 1, lastError: "Duplicate payment",
    createdAt: new Date().toISOString(), paymentReview: review, manualReviews: [],
  }] }));
  vi.stubGlobal("fetch", fetchMock);
  return { ...renderDashboard(<AdminStripeWebhooksScreen />), fetchMock };
}
const review = {
  mode: "test", originalSessionId: "cs_test_Original123", extraSessionId: "cs_test_Extra456",
  originalDashboardUrl: originalUrl, extraDashboardUrl: extraUrl,
};
afterEach(() => { cleanup(); Platform.OS = "web"; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens both Dashboard searches in new tabs without calling retry or ignore", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { client, fetchMock } = load(review, "ignored");
  await screen.findByText("Duplicate payment review — Test mode");
  fireEvent.click(screen.getByText("Find original payment in Stripe"));
  fireEvent.click(screen.getByText("Find extra payment in Stripe"));
  expect(open).toHaveBeenNthCalledWith(1, originalUrl, "_blank", "noopener,noreferrer");
  expect(open).toHaveBeenNthCalledWith(2, extraUrl, "_blank", "noopener,noreferrer");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Ignore")).toBeNull();
  client.clear();
});

it("opens native review links with Linking and reports opening failures", async () => {
  Platform.OS = "ios";
  const open = vi.spyOn(Linking, "openURL").mockRejectedValue(new Error("Browser unavailable"));
  const alert = vi.spyOn(Alert, "alert");
  const { client } = load({ ...review, mode: "live", originalDashboardUrl: originalUrl.replace("/test/", "/") });
  await screen.findByText("Duplicate payment review — Live mode");
  fireEvent.click(screen.getByText("Find original payment in Stripe"));
  await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("Could not open Stripe", expect.any(String)));
  expect(open).toHaveBeenCalledWith(originalUrl.replace("/test/", "/"));
  client.clear();
});

it("leaves unknown-mode sessions visible but never opens an unsafe link", async () => {
  const open = vi.spyOn(window, "open");
  const { client } = load({ ...review, mode: null, originalDashboardUrl: null, extraDashboardUrl: null });
  await screen.findByText("Duplicate payment review — Mode unavailable");
  expect(screen.getByText("cs_test_Original123")).toBeTruthy();
  expect(screen.queryByText("Find extra payment in Stripe")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  client.clear();
});

it("does not add a duplicate-payment panel to ordinary failed events", async () => {
  const { client } = load(undefined);
  await screen.findByText("Duplicate payment");
  expect(screen.queryByText(/Duplicate payment review/)).toBeNull();
  expect(screen.getByText("Retry")).toBeTruthy();
  expect(screen.getByText("Ignore")).toBeTruthy();
  client.clear();
});

it("saves a review through the real generated client and shows refreshed audit history", async () => {
  const audit = { id: "review_synthetic", outcome: "needs_follow_up", reviewerId: "admin_synthetic",
    reviewerName: "Second Admin", reviewedAt: "2026-10-23T10:00:00Z", note: "Check extra charge" };
  let reviews: object[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(String(url)).toContain("/admin/stripe-webhook-dead-letter/sdl_synthetic/reviews");
      expect(JSON.parse(init.body as string)).toEqual({ outcome: "needs_follow_up", note: "Check extra charge" });
      reviews = [audit];
      return Response.json(audit, { status: 201 });
    }
    return Response.json({ entries: [{
      id: "sdl_synthetic", eventId: "evt_synthetic", eventType: "checkout.session.completed",
      handlerName: "biz_account_paid", status: "ignored", attempts: 1, lastError: "Duplicate payment",
      createdAt: new Date().toISOString(), paymentReview: review, manualReviews: reviews,
    }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<AdminStripeWebhooksScreen />);
  await screen.findByText("No manual review recorded. Queue status alone does not confirm review.");
  expect((screen.getByText("Save review record").closest("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("○ Needs follow-up"));
  fireEvent.change(screen.getByPlaceholderText("Non-sensitive operational note"), { target: { value: "Check extra charge" } });
  fireEvent.click(screen.getByText("Save review record"));
  await screen.findByText("Review recorded.");
  await screen.findByText(/Reviewed by Second Admin/);
  expect(screen.getByText("Check extra charge")).toBeTruthy();
  expect((screen.getByPlaceholderText("Non-sensitive operational note") as HTMLInputElement).value).toBe("");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(screen.queryByText("Ignore")).toBeNull();
  client.clear();
});

it("keeps the draft and shows an explicit error when saving fails", async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST" ? Response.json({ error: "Forbidden" }, { status: 403 }) : Response.json({ entries: [{
      id: "sdl_synthetic", eventId: "evt_synthetic", eventType: "checkout.session.completed",
      handlerName: "biz_account_paid", status: "pending", attempts: 1, lastError: "Duplicate payment",
      createdAt: new Date().toISOString(), paymentReview: review, manualReviews: [],
    }] }));
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<AdminStripeWebhooksScreen />);
  await screen.findByText("○ No further action needed");
  fireEvent.click(screen.getByText("○ No further action needed"));
  fireEvent.change(screen.getByPlaceholderText("Non-sensitive operational note"), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByText("Save review record"));
  await screen.findByText("Could not confirm the review was saved. Refresh the queue before trying again.");
  expect((screen.getByPlaceholderText("Non-sensitive operational note") as HTMLInputElement).value).toBe("Keep this draft");
  expect(screen.queryByText("Review recorded.")).toBeNull();
  client.clear();
});
