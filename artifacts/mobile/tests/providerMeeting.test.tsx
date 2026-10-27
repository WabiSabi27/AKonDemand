import React from "react";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BusinessDashboard from "../app/(business-tabs)/index";
import { advance, mockApi, renderDashboard } from "./support/dashboard";

const NOW = Date.parse("2027-01-12T18:00:00.000Z");
function meeting(meetingAt: string | null, meetingLocation: string | null = "Juneau meeting room") {
  return {
    id: "test-application", status: "approved", paidAt: null,
    meetingAt, meetingLocation, meetingDurationMinutes: 45,
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows the upcoming meeting for an authenticated provider", async () => {
  mockApi("/api/me/biz-account", () => meeting(new Date(NOW + 3_600_000).toISOString()));
  const { client } = renderDashboard(<BusinessDashboard />);
  await advance();
  expect(screen.getByText("Upcoming Meeting")).toBeTruthy();
  expect(screen.getByText("Juneau meeting room")).toBeTruthy();
  expect(screen.getByText(/45 min/)).toBeTruthy();
  client.clear();
});

it.each([null, new Date(NOW - 60_000).toISOString(), new Date(NOW).toISOString()])(
  "hides absent or elapsed meetings (%s), including any stale location",
  async time => {
    mockApi("/api/me/biz-account", () => meeting(time));
    const { client } = renderDashboard(<BusinessDashboard />);
    await advance();
    expect(screen.queryByText("Upcoming Meeting")).toBeNull();
    expect(screen.queryByText("Juneau meeting room")).toBeNull();
    client.clear();
  },
);

it.each([null, ""])("omits the location line when the location is %s", async location => {
  mockApi("/api/me/biz-account", () => meeting(new Date(NOW + 3_600_000).toISOString(), location));
  const { client } = renderDashboard(<BusinessDashboard />);
  await advance();
  expect(screen.getByText("Upcoming Meeting")).toBeTruthy();
  expect(screen.queryByText("Juneau meeting room")).toBeNull();
  client.clear();
});

it("removes a cleared meeting on the next poll without navigating away", async () => {
  let payload = meeting(new Date(NOW + 3_600_000).toISOString());
  const fetchMock = mockApi("/api/me/biz-account", () => payload);
  const { client } = renderDashboard(<BusinessDashboard />);
  await advance();
  expect(screen.getByText("Upcoming Meeting")).toBeTruthy();
  payload = meeting(null); // Keep stale details deliberately.
  await advance(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Upcoming Meeting")).toBeNull();
  expect(screen.queryByText("Juneau meeting room")).toBeNull();
  client.clear();
});

it("hides a meeting when its time arrives even if the API snapshot never changes", async () => {
  mockApi("/api/me/biz-account", () => meeting(new Date(NOW + 30_000).toISOString()));
  const { client } = renderDashboard(<BusinessDashboard />);
  await advance();
  expect(screen.getByText("Upcoming Meeting")).toBeTruthy();
  await advance(30_000);
  expect(screen.queryByText("Upcoming Meeting")).toBeNull();
  expect(screen.queryByText("Juneau meeting room")).toBeNull();
  client.clear();
});

it("replaces the expiry timer when the admin reschedules the meeting", async () => {
  let payload = meeting(new Date(NOW + 90_000).toISOString(), "Original room");
  mockApi("/api/me/biz-account", () => payload);
  const { client } = renderDashboard(<BusinessDashboard />);
  await advance();
  payload = meeting(new Date(NOW + 180_000).toISOString(), "New room");
  await advance(60_000);
  expect(screen.getByText("New room")).toBeTruthy();
  expect(screen.queryByText("Original room")).toBeNull();
  await advance(30_000); // Original meeting time must no longer expire the card.
  expect(screen.getByText("Upcoming Meeting")).toBeTruthy();
  await advance(90_000);
  expect(screen.queryByText("Upcoming Meeting")).toBeNull();
  client.clear();
});
