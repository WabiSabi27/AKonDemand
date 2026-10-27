// Host-level lifecycle and native configuration checks, NOT a native keyboard
// test. Actual keyboard occlusion/gestures still require iPhone and Android.
import React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import AdminStripeWebhooksScreen from "../app/admin-stripe-webhooks";
import { advance, renderDashboard } from "./support/dashboard";

const capture = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("react-native", async importOriginal => {
  const original = await importOriginal<typeof import("./support/native-hosts")>();
  return {
    ...original,
    FlatList: (props: React.ComponentProps<typeof original.FlatList>) => {
      capture.list(props);
      return <original.FlatList {...props} />;
    },
  };
});
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("@/components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAwareScrollView: () => null }));

const queueUrl = "https://api.example.test/api/admin/stripe-webhook-dead-letter?status=pending&limit=100";
const reviewUrl = "https://api.example.test/api/admin/stripe-webhook-dead-letter/sdl_synthetic/reviews";
const entry = {
  id: "sdl_synthetic", eventId: "evt_synthetic", eventType: "checkout.session.completed",
  handlerName: "biz_account_paid", status: "pending", attempts: 1,
  lastError: "Synthetic duplicate payment", createdAt: "2026-10-23T10:00:00Z",
  paymentReview: {
    mode: "test", originalSessionId: "cs_test_SyntheticOriginal", extraSessionId: "cs_test_SyntheticExtra",
    originalDashboardUrl: null, extraDashboardUrl: null,
  },
  manualReviews: [],
};
const audit = {
  id: "review_synthetic", outcome: "needs_follow_up", reviewerId: "admin_synthetic",
  reviewerName: "Synthetic Admin", reviewedAt: "2026-10-23T11:00:00Z",
  note: "Synthetic operational draft",
};

afterEach(() => {
  cleanup();
  Platform.OS = "web";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["ios", "android"] as const)("%s configuration preserves taps and reserves room below the note", async os => {
  Platform.OS = os;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(queueUrl);
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json({ entries: [entry] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<AdminStripeWebhooksScreen />);
  try {
    await screen.findByText("Record a review");
    const props = capture.list.mock.lastCall![0];
    expect(props.keyboardShouldPersistTaps).toBe("handled");
    const scroll = props.renderScrollComponent({ keyboardShouldPersistTaps: props.keyboardShouldPersistTaps });
    expect(scroll.type).toBe(KeyboardAwareScrollView);
    expect(scroll.props).toMatchObject({ bottomOffset: 60, keyboardShouldPersistTaps: "handled" });
  } finally {
    client.clear();
  }
});

it.each(["ios", "android"] as const)("%s keeps the draft through successful and failed polling and saves rapid taps once", async os => {
  Platform.OS = os;
  let queueFails = false;
  let reads = 0;
  let posted = false;
  let resolveSave!: (response: Response) => void;
  const pendingSave = new Promise<Response>(resolve => { resolveSave = resolve; });
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // No request ever escapes this fixture. Refund/replay/ignore are forbidden.
    if (method === "POST") {
      expect(String(url)).toBe(reviewUrl);
      expect(JSON.parse(init!.body as string)).toEqual({
        outcome: "needs_follow_up", note: "Synthetic operational draft",
      });
      return pendingSave;
    }
    expect(method).toBe("GET");
    expect(String(url)).toBe(queueUrl);
    reads++;
    return queueFails
      ? Response.json({ error: "Synthetic outage" }, { status: 503 })
      : Response.json({ entries: [{ ...entry, attempts: reads, manualReviews: posted ? [audit] : [] }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  const { client } = renderDashboard(<AdminStripeWebhooksScreen />);
  try {
    await advance();
    expect(screen.getByText("Record a review")).toBeTruthy();
    const input = screen.getByPlaceholderText("Non-sensitive operational note") as HTMLInputElement;
    fireEvent.click(screen.getByText("○ Needs follow-up"));
    fireEvent.change(input, { target: { value: "Synthetic operational draft" } });
    await advance(30_000);
    expect(reads).toBe(2);
    expect(screen.getByPlaceholderText("Non-sensitive operational note")).toBe(input);
    expect(input.value).toBe("Synthetic operational draft");
    expect(screen.getByText("● Needs follow-up")).toBeTruthy();
    queueFails = true;
    await advance(30_000);
    expect(reads).toBe(3);
    expect(screen.getByText(/Could not refresh queue/)).toBeTruthy();
    expect(screen.getByPlaceholderText("Non-sensitive operational note")).toBe(input);
    expect(input.value).toBe("Synthetic operational draft");
    queueFails = false;
    await advance(30_000);
    expect(screen.queryByText(/Could not refresh queue/)).toBeNull();
    const button = screen.getByText("Save review record").closest("button")!;
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await advance();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect(input.value).toBe("Synthetic operational draft");
    posted = true;
    await act(async () => { resolveSave(Response.json(audit, { status: 201 })); });
    await advance();
    expect(input.value).toBe("");
    expect(screen.getByText("Review recorded.")).toBeTruthy();
    expect(screen.getByText(/Reviewed by Synthetic Admin/)).toBeTruthy();
    expect(screen.getByText("○ Needs follow-up")).toBeTruthy();
    expect(screen.getByText("Save review record").closest("button")!.disabled).toBe(true);
  } finally {
    client.clear();
  }
});

it.each(["ios", "android"] as const)("%s preserves the draft when saving and the ensuing queue refresh both fail", async os => {
  Platform.OS = os;
  let failed = false;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(String(url)).toBe(reviewUrl);
      failed = true;
      return Response.json({ error: "Synthetic save failure" }, { status: 503 });
    }
    expect(String(url)).toBe(queueUrl);
    return failed ? Response.json({ error: "Synthetic refresh failure" }, { status: 503 })
      : Response.json({ entries: [entry] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<AdminStripeWebhooksScreen />);
  try {
    await screen.findByText("Record a review");
    fireEvent.click(screen.getByText("○ Needs follow-up"));
    const input = screen.getByPlaceholderText("Non-sensitive operational note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Synthetic operational draft" } });
    fireEvent.click(screen.getByText("Save review record"));
    await screen.findByText(/Could not confirm the review was saved/);
    await screen.findByText(/Could not refresh queue/);
    expect(screen.getByPlaceholderText("Non-sensitive operational note")).toBe(input);
    expect(input.value).toBe("Synthetic operational draft");
    expect(screen.getByText("● Needs follow-up")).toBeTruthy();
    expect(screen.queryByText("Review recorded.")).toBeNull();
    expect(screen.getByText("Save review record").closest("button")!.disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  } finally {
    client.clear();
  }
});
