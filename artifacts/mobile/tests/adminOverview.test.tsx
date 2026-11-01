import React from "react";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminOverview from "../app/(admin-tabs)/index";
import { advance, mockApi, renderDashboard } from "./support/dashboard";
import type { AdminWebhookReadiness } from "@workspace/api-client-react";
import { PaymentWebhookStatus } from "../components/PaymentWebhookStatus";

function metrics(failedCount: number) {
  return {
    gmv: { last30Cents: 0, lifetimeCents: 0, last30PlatformFeeCents: 0, lifetimePlatformFeeCents: 0 },
    subscriptions: {
      mrrCents: 0, totalActive: 0,
      byTier: { starter_gigger: { count: 0, mrrCents: 0 }, pro_business: { count: 0, mrrCents: 0 } },
    },
    churn: { activeNow: 0, inactiveNow: 0 },
    funnel: { applications: 0, paid: 0, approved: 0, activeWithBooking: 0 },
    topCategories: [], emailOutbox: { failedCount },
    paymentWebhook: {
      status: "checking" as const, environment: "preview" as const,
      reason: "Payment callback startup verification has not completed.",
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("refreshes after 60 seconds and shows then removes the failed-email badge without navigation", async () => {
  let count = 0;
  const fetchMock = mockApi("/api/admin/metrics", () => metrics(count));
  const { client } = renderDashboard(<AdminOverview />);
  await advance();
  const row = screen.getByText("Email Outbox").closest("button")!;
  expect(row).not.toBeNull();
  expect(within(row).queryByText("3")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  count = 3;
  await advance(59_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(within(row).getByText("3")).toBeTruthy();
  expect(within(row).getByText("Emails gave up retrying — retry or dismiss")).toBeTruthy();

  count = 0;
  await advance(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(within(row).queryByText("3")).toBeNull();
  expect(within(row).queryByText("Emails gave up retrying — retry or dismiss")).toBeNull();
  expect(within(row).getByText("Failed notification emails — retry or dismiss")).toBeTruthy();
  client.clear();
});

it("caps the failed-email badge at 99+", async () => {
  mockApi("/api/admin/metrics", () => metrics(105));
  const { client } = renderDashboard(<AdminOverview />);
  await advance();
  expect(screen.getByText("99+")).toBeTruthy();
  client.clear();
});

it("refreshes webhook availability without navigation and removes a stale success on failure", async () => {
  let readiness: AdminWebhookReadiness = {
    status: "unavailable", environment: "preview", reason: "This preview has no verified payment callback.",
  };
  const fetchMock = mockApi("/api/admin/metrics", () => ({
    ...metrics(0), paymentWebhook: readiness,
  }));
  const { client } = renderDashboard(<AdminOverview />);
  await advance();
  expect(screen.getByText("Automatic payment updates unavailable in this preview")).toBeTruthy();
  expect(screen.getByText(readiness.reason)).toBeTruthy();
  expect(screen.queryByText("Automatic payment updates available")).toBeNull();

  readiness = { status: "ready", environment: "preview", reason: "Callback verified at startup." };
  await advance(60_000);
  expect(screen.getByText("Automatic payment updates available")).toBeTruthy();
  expect(screen.queryByText("Automatic payment updates unavailable in this preview")).toBeNull();

  // A failed refetch must not leave cached readiness presented as current.
  fetchMock.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
  await advance(60_000);
  expect(screen.getByText("Payment update status could not be checked")).toBeTruthy();
  expect(screen.queryByText("Automatic payment updates available")).toBeNull();
  client.clear();
});

it.each([
  { readiness: undefined, title: "Checking automatic payment updates…" },
  { readiness: { status: "checking", environment: "preview", reason: "Verification in progress." }, title: "Checking automatic payment updates…" },
  { readiness: { status: "unavailable", environment: "production", reason: "Callback unavailable." }, title: "Automatic payment updates unavailable" },
] satisfies Array<{ readiness: AdminWebhookReadiness | undefined; title: string }>)(
  "shows an explicit non-ready state: $title", ({ readiness, title }) => {
    const { client } = renderDashboard(<PaymentWebhookStatus readiness={readiness} failed={false} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("Automatic payment updates available")).toBeNull();
    expect(screen.getByText(/API availability does not confirm/)).toBeTruthy();
    client.clear();
  },
);
