import React from "react";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminOverview from "../app/(admin-tabs)/index";
import { advance, mockApi, renderDashboard } from "./support/dashboard";

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
