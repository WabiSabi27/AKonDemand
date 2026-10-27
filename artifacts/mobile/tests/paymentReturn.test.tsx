import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { WebBrowserResultType } from "expo-web-browser/build/WebBrowser.types";
import { Platform } from "react-native";
import PaymentReturnScreen from "../app/payment-return";
import { advance, renderDashboard } from "./support/dashboard";

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: React.EffectCallback) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => route.params,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    removeItem: vi.fn(async () => {}),
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Platform.OS = "web";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Exercise the real generated client, including ApiError handling for the 409.
// Only HTTP/browser boundaries are synthetic; pricing stays available throughout.
function mockStatusFailureAfterConflict(failure: "network" | "503") {
  route.params = { id: "ba_conflict_status_fixture" };
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const checkout = vi.fn(() => Response.json({ error: "Application status changed" }, { status: 409 }));
  const status = vi.fn<() => Response>(() => Response.json({ id: route.params.id, status: "accepted" }));
  const fees = vi.fn(() => Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/biz-accounts/${route.params.id}/onboarding-checkout`) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
      return checkout();
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") return fees();
    expect(path).toBe(`/api/biz-accounts/${route.params.id}/status`);
    return status();
  }));
  return {
    open, checkout, status, fees,
    failStatus: () => status.mockImplementation(() => {
      if (failure === "network") throw new TypeError("Synthetic network failure");
      return Response.json({ error: "Status temporarily unavailable" }, { status: 503 });
    }),
  };
}

it.each([
  ["network", "approved", "You're all set!"],
  ["network", "rejected", "Application not approved"],
  ["503", "approved", "You're all set!"],
  ["503", "rejected", "Application not approved"],
] as const)("keeps checkout blocked after a conflict during a transient %s status failure, then displays %s", async (failure, authoritativeStatus, title) => {
  const { open, checkout, status, fees, failStatus } = mockStatusFailureAfterConflict(failure);
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    vi.useFakeTimers();
    failStatus();
    await act(async () => { fireEvent.click(pay); });
    await advance();

    const expectBlocked = () => {
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
      expect(checkout).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    };
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2); // Initial acceptance, then failed refresh.
    expect(fees).toHaveBeenCalledTimes(2); // Conflict pricing refresh succeeded.
    expectBlocked();
    await advance(1999);
    expect(status).toHaveBeenCalledTimes(2);
    expectBlocked();
    await advance(1);
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Check 2…")).toBeTruthy();
    expectBlocked();

    status.mockImplementation(() => Response.json({ id: route.params.id, status: authoritativeStatus }));
    await advance(2000);
    expect(screen.getByText(title)).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(4);
    expectBlocked();
    // Later timer/query activity must not resubmit or restore stale acceptance.
    await act(async () => { await client.refetchQueries(); });
    await advance(30_000);
    expect(screen.getByText(title)).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(4);
    expectBlocked();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each(["network", "503"] as const)("requires a deliberate payment click after a conflict and transient %s failures recover to accepted", async failure => {
  const { open, checkout, status, fees, failStatus } = mockStatusFailureAfterConflict(failure);
  const originalMeeting = {
    meetingAt: "2027-01-12T18:00:00.000Z",
    meetingLocation: "Original meeting room",
    meetingDurationMinutes: 30,
  };
  const refreshedMeeting = {
    meetingAt: "2027-01-15T20:30:00.000Z",
    meetingLocation: "Rescheduled meeting room",
    meetingDurationMinutes: 90,
  };
  const meetingLabel = (iso: string) => {
    const date = new Date(iso);
    return `${date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  };
  status.mockImplementation(() => Response.json({ id: route.params.id, status: "accepted", ...originalMeeting }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    expect(screen.getByText(originalMeeting.meetingLocation)).toBeTruthy();
    expect(screen.getByText(meetingLabel(originalMeeting.meetingAt))).toBeTruthy();
    expect(screen.getByText(/\(30 minutes\)/)).toBeTruthy();
    vi.useFakeTimers();
    failStatus();
    await act(async () => { fireEvent.click(pay); });
    await advance();

    const expectNoAutomaticCheckout = () => {
      expect(checkout).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    };
    const expectBlocked = () => {
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
      expect(screen.queryByText(originalMeeting.meetingLocation)).toBeNull();
      expectNoAutomaticCheckout();
    };
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);
    expect(fees).toHaveBeenCalledTimes(2);
    expectBlocked();
    await advance(1999);
    expect(status).toHaveBeenCalledTimes(2);
    expectBlocked();
    await advance(1);
    expect(screen.getByText("Check 2…")).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(3);
    expectBlocked();

    status.mockImplementation(() => Response.json({ id: route.params.id, status: "accepted", ...refreshedMeeting }));
    await advance(2000);
    const expectRefreshedAcceptance = () => {
      expect(screen.getByText("You're accepted!")).toBeTruthy();
      expect(screen.getByText("The fee or application status has changed. Review the updated details before paying.")).toBeTruthy();
      expect(screen.getByText(refreshedMeeting.meetingLocation)).toBeTruthy();
      expect(screen.getByText(meetingLabel(refreshedMeeting.meetingAt))).toBeTruthy();
      expect(screen.getByText(/\(1 hour 30 minutes\)/)).toBeTruthy();
      expect(screen.queryByText(originalMeeting.meetingLocation)).toBeNull();
      expect(screen.queryByText(meetingLabel(originalMeeting.meetingAt))).toBeNull();
      expect(screen.queryByText(/\(30 minutes\)/)).toBeNull();
      expect(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" })).toBeTruthy();
      expectNoAutomaticCheckout();
    };
    expect(status).toHaveBeenCalledTimes(4);
    expectRefreshedAcceptance();
    await act(async () => { await client.refetchQueries(); });
    await advance(30_000);
    expect(status).toHaveBeenCalledTimes(4);
    expectRefreshedAcceptance();

    // Only this new click may submit a second checkout and open its URL.
    checkout.mockImplementation(() => Response.json({ checkoutUrl: "https://checkout.example.test/recovered-acceptance" }));
    open.mockReturnValue({} as Window);
    status.mockImplementation(() => Response.json({ id: route.params.id, status: "approved" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" })); });
    await advance();
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/recovered-acceptance", "_blank", "noopener,noreferrer");
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    await advance(30_000);
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each(["network", "503"] as const)("requires a new payment click after each of two offer conflicts with transient %s status failures", async failure => {
  const { open, checkout, status, fees, failStatus } = mockStatusFailureAfterConflict(failure);
  const meetings = [
    { meetingAt: "2027-02-01T18:00:00.000Z", meetingLocation: "Original offer room", meetingDurationMinutes: 30, durationLabel: "(30 minutes)" },
    { meetingAt: "2027-02-02T19:00:00.000Z", meetingLocation: "First refreshed offer room", meetingDurationMinutes: 60, durationLabel: "(1 hour)" },
    { meetingAt: "2027-02-03T20:30:00.000Z", meetingLocation: "Second refreshed offer room", meetingDurationMinutes: 90, durationLabel: "(1 hour 30 minutes)" },
  ];
  const meetingLabel = (iso: string) => {
    const date = new Date(iso);
    return `${date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  };
  const acceptMeeting = (index: number) => status.mockImplementation(() => Response.json({
    id: route.params.id, status: "accepted", ...meetings[index],
  }));
  acceptMeeting(0);
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    expect(screen.getByText(meetings[0].meetingLocation)).toBeTruthy();
    vi.useFakeTimers();

    const expectNoAutomaticCheckout = (count: number) => {
      expect(checkout).toHaveBeenCalledTimes(count);
      expect(open).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    };
    for (const cycle of [1, 2]) {
      failStatus();
      await act(async () => {
        const pay = screen.getByRole("button", { name: "Pay $2.00 onboarding fee" });
        // The recovered guard must admit the next deliberate click, but still
        // suppress duplicate clicks batched before the button unmounts.
        fireEvent.click(pay);
        fireEvent.click(pay);
      });
      await advance();
      expect(screen.getByText("Check 1…")).toBeTruthy();
      expect(status).toHaveBeenCalledTimes(cycle * 2);
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
      expect(screen.queryByText("You're accepted!")).toBeNull();
      for (const meeting of meetings) {
        expect(screen.queryByText(meeting.meetingLocation)).toBeNull();
      }
      expectNoAutomaticCheckout(cycle);
      await advance(1999);
      expect(status).toHaveBeenCalledTimes(cycle * 2);
      expectNoAutomaticCheckout(cycle);

      acceptMeeting(cycle);
      await advance(1);
      const expectRecovered = () => {
        const current = meetings[cycle];
        expect(screen.getByText("You're accepted!")).toBeTruthy();
        expect(screen.getByText("The fee or application status has changed. Review the updated details before paying.")).toBeTruthy();
        expect(screen.getByText(current.meetingLocation)).toBeTruthy();
        expect(screen.getByText(meetingLabel(current.meetingAt))).toBeTruthy();
        expect(screen.getByText(current.durationLabel, { exact: false })).toBeTruthy();
        for (const stale of meetings.slice(0, cycle)) {
          expect(screen.queryByText(stale.meetingLocation)).toBeNull();
          expect(screen.queryByText(meetingLabel(stale.meetingAt))).toBeNull();
          expect(screen.queryByText(stale.durationLabel, { exact: false })).toBeNull();
        }
        expect(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" }).hasAttribute("disabled")).toBe(false);
        expectNoAutomaticCheckout(cycle);
      };
      expect(status).toHaveBeenCalledTimes(cycle * 2 + 1);
      expectRecovered();

      // Exercise a real pricing query refresh and every possible old poll timer
      // before allowing another click. Neither may submit or open checkout.
      const feeReads = fees.mock.calls.length;
      await act(async () => { await client.refetchQueries(); });
      expect(fees).toHaveBeenCalledTimes(feeReads + 1);
      await advance(30_000);
      expect(status).toHaveBeenCalledTimes(cycle * 2 + 1);
      expectRecovered();
    }

    // A third deliberate click proves the guard released after the second
    // recovery. Only this successful POST is permitted to open checkout.
    checkout.mockImplementation(() => Response.json({ checkoutUrl: "https://checkout.example.test/repeated-recovery" }));
    open.mockReturnValue({} as Window);
    status.mockImplementation(() => Response.json({ id: route.params.id, status: "approved" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" })); });
    await advance();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    await act(async () => { await client.refetchQueries(); });
    await advance(30_000);
    expect(checkout).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/repeated-recovery", "_blank", "noopener,noreferrer");
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each(["network", "503"] as const)("does not restore a stale payment action when %s status failures exhaust the conflict polling budget", async failure => {
  const { open, checkout, status, fees, failStatus } = mockStatusFailureAfterConflict(failure);
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    vi.useFakeTimers();
    failStatus();
    await act(async () => { fireEvent.click(pay); });
    await advance();
    const expectBlocked = () => {
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
      expect(checkout).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    };
    expect(fees).toHaveBeenCalledTimes(2);
    // Fifteen failed reads at t=0, 2, …, 28 seconds; no extra read at t=30.
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      expect(screen.getByText(`Check ${attempt}…`)).toBeTruthy();
      expect(status).toHaveBeenCalledTimes(attempt + 1);
      expectBlocked();
      await advance(attempt === 15 ? 1999 : 2000);
    }
    expect(screen.queryByText("Payment is still processing")).toBeNull();
    await advance(1);
    expect(screen.getByText("Could not refresh your application status. Your application has been kept. Check its status before continuing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check application status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Login" })).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(16);
    expectBlocked();
    await act(async () => { await client.refetchQueries(); });
    await advance(30_000);
    expect(screen.getByText("Could not refresh your application status. Your application has been kept. Check its status before continuing.")).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(16);
    expectBlocked();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each([
  ["web", "delayed webhook"],
  ["web", "network outage"],
  ["ios", "delayed webhook"],
  ["ios", "network outage"],
  ["android", "delayed webhook"],
  ["android", "network outage"],
] as const)("keeps %s onboarding safe after %s exhausts confirmation polling and rechecks without paying again", async (platform, failure) => {
  Platform.OS = platform;
  route.params = { id: "ba_delayed_onboarding_fixture" };
  vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
    type: "success", url: "https://example.test/payment-return",
  });
  const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  const checkout = vi.fn(() => Response.json({ checkoutUrl: "https://checkout.example.test/delayed" }));
  let checkoutStarted = false;
  let recovered = false;
  let finalStatus = "accepted";
  const status = vi.fn(() => {
    if (checkoutStarted && failure === "network outage" && !recovered) {
      throw new TypeError("Synthetic outage after browser success");
    }
    return Response.json({ id: route.params.id, status: finalStatus });
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    if (path.endsWith("/onboarding-checkout")) {
      expect(init?.method).toBe("POST");
      checkoutStarted = true;
      return checkout();
    }
    expect(init?.method ?? "GET").toBe("GET");
    expect(path).toBe(`/api/biz-accounts/${route.params.id}/status`);
    return status();
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(pay); });
    await advance();
    const expectNoPayment = () => {
      expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(checkout).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledTimes(platform === "web" ? 1 : 0);
      expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(platform === "web" ? 0 : 1);
    };
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      expect(screen.getByText(`Check ${attempt}…`)).toBeTruthy();
      expectNoPayment();
      await advance(2000);
    }
    expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
    expect(screen.getByText(/Please don't pay again/)).toBeTruthy();
    expect(screen.getByText(/support@akodd.com/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Login" })).toBeTruthy();
    expect(screen.getByText(failure === "network outage"
      ? /We couldn't refresh your payment status/
      : /We haven't received confirmation/)).toBeTruthy();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    const callsAtTimeout = status.mock.calls.length;
    await advance(30_000);
    expect(status).toHaveBeenCalledTimes(callsAtTimeout);
    expectNoPayment();

    recovered = true;
    const check = screen.getByRole("button", { name: "Check payment status" });
    await act(async () => {
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await advance();
    // A fresh accepted response is still not a reason to pay again.
    expect(status).toHaveBeenCalledTimes(callsAtTimeout + 1);
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expectNoPayment();
    for (let attempt = 0; attempt < 15; attempt += 1) await advance(2000);
    expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
    expectNoPayment();

    finalStatus = "approved";
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check payment status" })); });
    await advance();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith("akodd_application_id");
    expectNoPayment();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each(["delayed webhook", "network outage"] as const)(
  "mounts a fresh onboarding success return safely during a %s",
  async failure => {
    route.params = Object.fromEntries(new URL(
      "https://published.example.test/payment-return?success=true&id=ba_fresh_onboarding_fixture&session=cs_synthetic&phase=onboarding",
    ).searchParams);
    let finalStatus = "accepted";
    let available = failure !== "network outage";
    const status = vi.fn(() => {
      if (!available) throw new TypeError("Synthetic network outage");
      return Response.json({ id: route.params.id, status: finalStatus });
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = new URL(String(input)).pathname;
      if (path === "/api/application-fees") {
        return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
      }
      expect(path).toBe(`/api/biz-accounts/${route.params.id}/status`);
      return status();
    }));
    vi.useFakeTimers();
    const { client } = renderDashboard(<PaymentReturnScreen />);
    try {
      await advance();
      for (let attempt = 1; attempt <= 15; attempt += 1) {
        expect(screen.getByText(`Check ${attempt}…`)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
        await advance(2000);
      }
      expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
      available = true;
      finalStatus = "approved";
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check payment status" })); });
      await advance();
      expect(screen.getByText("You're all set!")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    } finally {
      cleanup();
      client.clear();
      vi.useRealTimers();
    }
  },
);

it("starts only one checkout for repeated clicks in the same update, then releases the guard after a conflict", async () => {
  route.params = { id: "ba_rapid_fixture" };
  let finishCheckout!: (response: Response) => void;
  let opened = false;
  const checkout = vi.fn(() => new Promise<Response>(resolve => { finishCheckout = resolve; }));
  const open = vi.spyOn(window, "open").mockImplementation(() => {
    opened = true;
    return {} as Window;
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    if (path.endsWith("/onboarding-checkout")) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
      return checkout();
    }
    return Response.json({ id: route.params.id, status: opened ? "approved" : "accepted" });
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
  act(() => {
    // One React update: the old handler remains attached for all three clicks.
    fireEvent.click(pay);
    fireEvent.click(pay);
    fireEvent.click(pay);
  });
  await waitFor(() => expect(checkout).toHaveBeenCalledOnce());
  expect(screen.getByText("Opening secure checkout…")).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  await act(async () => {
    finishCheckout(Response.json({ error: "Refresh the offer" }, { status: 409 }));
  });
  const retry = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
  act(() => {
    fireEvent.click(retry);
    fireEvent.click(retry);
  });
  await waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
  await act(async () => {
    finishCheckout(Response.json({ checkoutUrl: "https://checkout.example.test/rapid" }));
  });
  await screen.findByText("You're all set!");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/rapid", "_blank", "noopener,noreferrer");
  client.clear();
});

it.each(["published.example.test", "expo.example.test"])(
  "shows a paid application from the return URL on %s without storage or another checkout",
  async host => {
    const url = new URL(`https://${host}/payment-return?success=true&id=ba_paid_fixture&session=cs_test_fixture`);
    route.params = Object.fromEntries(url.searchParams);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = new URL(String(input)).pathname;
      if (path === "/api/application-fees") {
        return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
      }
      expect(path).toBe("/api/biz-accounts/ba_paid_fixture/status");
      return Response.json({ id: "ba_paid_fixture", status: "pending", paidAt: "2026-10-20T12:00:00Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = renderDashboard(<PaymentReturnScreen />);
    await screen.findByText("Application received!");
    expect(screen.getByText(/Your application fee has been received/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.clear();
  },
);

it("checks application cancellation once without starting checkout", async () => {
  route.params = { cancelled: "true", id: "ba_cancelled_fixture" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    return new URL(String(input)).pathname === "/api/application-fees"
      ? Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" })
      : Response.json({ id: route.params.id, status: "awaiting_payment" });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText("Payment cancelled");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  client.clear();
});

it.each(["published.example.test", "expo.example.test"])(
  "preserves acceptance after cancelling checkout on %s and resumes only on a deliberate click",
  async host => {
    // No stage parameter: also covers already-issued Stripe cancellation URLs.
    route.params = Object.fromEntries(new URL(`https://${host}/payment-return?cancelled=true&id=ba_resume_fixture`).searchParams);
    let opened = false;
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      opened = true;
      return {} as Window;
    });
    const checkout = vi.fn(() => Response.json({ checkoutUrl: "https://checkout.example.test/existing-unpaid-session" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/application-fees") {
        return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
      }
      if (path.endsWith("/onboarding-checkout")) {
        expect(path).toBe("/api/biz-accounts/ba_resume_fixture/onboarding-checkout");
        expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
        return checkout();
      }
      return Response.json({ id: route.params.id, status: opened ? "approved" : "accepted" });
    }));
    const { client } = renderDashboard(<PaymentReturnScreen />);
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    expect(screen.getByText(/Your application is still accepted/)).toBeTruthy();
    expect(screen.queryByText(/restart your application/)).toBeNull();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(pay);
    await screen.findByText("You're all set!");
    expect(checkout).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/existing-unpaid-session", "_blank", "noopener,noreferrer");
    client.clear();
  },
);

it.each(
  (["ios", "android"] as const).flatMap(platform =>
    (["online", "offline"] as const).map(connection => ({ platform, connection })),
  ),
)(
  "does not retry checkout after the $platform browser fails to open, and recovers with $connection status checks only",
  async ({ platform, connection }) => {
    Platform.OS = platform;
    route.params = { id: "ba_native_browser_failure_fixture" };
    vi.mocked(WebBrowser.openAuthSessionAsync).mockRejectedValueOnce(new Error("Synthetic browser launch failure"));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const checkoutUrl = "https://checkout.example.test/native-browser-failure";
    const checkout = vi.fn(() => Response.json({ checkoutUrl }));
    const status = vi.fn(() => Response.json({ id: route.params.id, status: "accepted" }));
    const fees = vi.fn(() => Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.example.test");
      if (url.pathname === `/api/biz-accounts/${route.params.id}/onboarding-checkout`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
        return checkout();
      }
      expect(init?.method ?? "GET").toBe("GET");
      if (url.pathname === "/api/application-fees") return fees();
      expect(url.pathname).toBe(`/api/biz-accounts/${route.params.id}/status`);
      return status();
    }));
    const { client } = renderDashboard(<PaymentReturnScreen />);
    try {
      const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
      expect(checkout).not.toHaveBeenCalled();
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
      vi.useFakeTimers();
      await act(async () => { fireEvent.click(pay); });
      await advance();

      const expectNoRetry = () => {
        expect(checkout).toHaveBeenCalledOnce();
        expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledExactlyOnceWith(checkoutUrl, null);
        expect(open).not.toHaveBeenCalled();
        expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
      };
      const expectStartError = () => {
        expect(screen.getByText("Something went wrong")).toBeTruthy();
        expect(screen.getByText("Could not start the onboarding payment. Please try again.")).toBeTruthy();
        expect(screen.queryByText("Opening secure checkout…")).toBeNull();
        expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
        expectNoRetry();
      };
      expectStartError();
      expect(status).toHaveBeenCalledOnce();
      await advance(30_000);
      await act(async () => { await client.refetchQueries(); });
      await advance(30_000);
      expect(fees).toHaveBeenCalledTimes(2); // A real query refresh must not relaunch checkout.
      expect(status).toHaveBeenCalledOnce();
      expectStartError();

      if (connection === "offline") {
        status.mockImplementation(() => { throw new TypeError("Synthetic offline status check"); });
      }
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check application status" }));
      });
      await advance();
      if (connection === "offline") {
        const expectPaymentBlocked = () => {
          expect(screen.queryByText("You're accepted!")).toBeNull();
          expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
          expect(screen.queryByText("Opening secure checkout…")).toBeNull();
          expectNoRetry();
        };
        // Exhaust all fifteen reads at t=0, 2, …, 28 seconds.
        for (let attempt = 1; attempt <= 15; attempt += 1) {
          expect(screen.getByText(`Check ${attempt}…`)).toBeTruthy();
          expect(status).toHaveBeenCalledTimes(attempt + 1);
          expectPaymentBlocked();
          await advance(attempt === 15 ? 1999 : 2000);
        }
        expect(screen.queryByRole("button", { name: "Check application status" })).toBeNull();
        await advance(1);
        const expectRecovery = () => {
          expect(screen.getByText("Something went wrong")).toBeTruthy();
          expect(screen.getByText("Could not refresh your application status. Your application has been kept. Check its status before continuing.")).toBeTruthy();
          expect(screen.getByRole("button", { name: "Check application status" })).toBeTruthy();
          expect(screen.queryByText("Payment is still processing")).toBeNull();
          expect(status).toHaveBeenCalledTimes(16);
          expectPaymentBlocked();
        };
        expectRecovery();
        await act(async () => { await client.refetchQueries(); });
        await advance(30_000);
        expectRecovery();

        // Connectivity returning does not authorize a hidden read or checkout.
        status.mockImplementation(() => Response.json({ id: route.params.id, status: "accepted" }));
        await advance(30_000);
        expectRecovery();
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Check application status" }));
        });
        await advance();
      }
      const expectedStatusCalls = connection === "offline" ? 17 : 2;
      expect(status).toHaveBeenCalledTimes(expectedStatusCalls);
      expect(screen.getByText("You're accepted!")).toBeTruthy();
      expect(screen.queryByText("Something went wrong")).toBeNull();
      expect(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" })).toBeTruthy();
      expectNoRetry();
      // Restoring the payment action is not permission to submit it.
      await act(async () => { await client.refetchQueries(); });
      await advance(30_000);
      expect(status).toHaveBeenCalledTimes(expectedStatusCalls);
      expectNoRetry();
    } finally {
      cleanup();
      client.clear();
      vi.useRealTimers();
    }
  },
);

it.each([
  ["ios", "cancel"], ["ios", "dismiss"], ["android", "cancel"], ["android", "dismiss"],
])("refreshes immediately after %s browser %s and allows retry without restarting the application", async (platform, type) => {
  Platform.OS = platform as typeof Platform.OS;
  route.params = { id: "ba_native_fixture" };
  vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({ type } as WebBrowser.WebBrowserAuthSessionResult);
  const checkout = vi.fn(() => Response.json({ checkoutUrl: "https://checkout.example.test/existing-native-session" }));
  const status = vi.fn(() => Response.json({ id: route.params.id, status: "accepted" }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    return path.endsWith("/onboarding-checkout") ? checkout() : status();
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" }));
  await screen.findByText(/Your application is still accepted/);
  expect(status).toHaveBeenCalledTimes(2);
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  expect(checkout).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" }));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(2));
  await screen.findByText(/Your application is still accepted/);
  expect(checkout).toHaveBeenCalledTimes(2);
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenLastCalledWith("https://checkout.example.test/existing-native-session", null);
  client.clear();
});

it.each(
  (["ios", "android"] as const).flatMap(platform =>
    ([WebBrowserResultType.CANCEL, WebBrowserResultType.DISMISS] as const).flatMap(type =>
      (["approved", "rejected"] as const).map(finalStatus => ({ platform, type, finalStatus })),
    ),
  ),
)("shows refreshed $finalStatus after $platform browser $type without reopening checkout", async ({ platform, type, finalStatus }) => {
  Platform.OS = platform;
  route.params = { id: "ba_native_terminal_fixture" };
  let closeBrowser!: (result: WebBrowser.WebBrowserAuthSessionResult) => void;
  let browserClosed = false;
  vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(() =>
    new Promise(resolve => { closeBrowser = resolve; }),
  );
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const checkout = vi.fn(() => Response.json({ checkoutUrl: "https://checkout.example.test/native-terminal-session" }));
  const status = vi.fn(() => Response.json({
    id: route.params.id,
    status: browserClosed ? finalStatus : "accepted",
    applicationPayment: { amountCents: 1900, currency: "usd" },
    onboardingPayment: browserClosed && finalStatus === "approved"
      ? { amountCents: 6400, currency: "cad" }
      : null,
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/biz-accounts/${route.params.id}/onboarding-checkout`) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
      return checkout();
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") {
      // Current pricing must not be substituted for historical receipts.
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    expect(path).toBe(`/api/biz-accounts/${route.params.id}/status`);
    return status();
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
    expect(checkout).not.toHaveBeenCalled();
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    fireEvent.click(pay);
    await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledExactlyOnceWith(
      "https://checkout.example.test/native-terminal-session", null,
    ));
    // Keep the synthetic browser open until the initial accepted state is checked.
    expect(status).toHaveBeenCalledOnce();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await act(async () => {
      browserClosed = true;
      closeBrowser({ type });
    });
    await advance();

    const expectTerminal = () => {
      expect(screen.getByText(finalStatus === "approved" ? "You're all set!" : "Application not approved")).toBeTruthy();
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByText(/Your application is still accepted/)).toBeNull();
      expect(screen.queryByText("Payment cancelled")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
      expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
      expect(screen.queryByText("Application fee paid: $1.00")).toBeNull();
      if (finalStatus === "approved") {
        expect(screen.getByText("Onboarding fee paid: CA$64.00")).toBeTruthy();
      } else {
        expect(screen.queryByText(/Onboarding fee paid:/)).toBeNull();
      }
      expect(screen.queryByText("Onboarding fee paid: $2.00")).toBeNull();
      expect(status).toHaveBeenCalledTimes(2);
      expect(checkout).toHaveBeenCalledOnce();
      expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    };
    expectTerminal();
    // Query updates and later timers must not restore payment or retry checkout.
    await act(async () => { await client.refetchQueries(); });
    await advance(30_000);
    expectTerminal();
  } finally {
    cleanup();
    client.clear();
    vi.useRealTimers();
  }
});

it.each([
  ["pending", "Application received!"],
  ["approved", "You're all set!"],
  ["rejected", "Application not approved"],
])("uses refreshed %s status rather than cancellation copy", async (status, title) => {
  route.params = { cancelled: "true", id: "ba_changed_fixture" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    new URL(String(input)).pathname === "/api/application-fees"
      ? Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" })
      : Response.json({ id: route.params.id, status })));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText(title);
  expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
  expect(screen.queryByText("Payment cancelled")).toBeNull();
  client.clear();
});

it("keeps payment blocked when cancellation status cannot load, then offers a status retry", async () => {
  route.params = { cancelled: "true" };
  vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce("ba_stored_fixture");
  let available = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    expect(new URL(String(input)).pathname).toBe("/api/biz-accounts/ba_stored_fixture/status");
    if (!available) throw new Error("Offline");
    return Response.json({ id: "ba_stored_fixture", status: "accepted" });
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText(/Could not refresh your application status/);
  expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  available = true;
  vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce("ba_stored_fixture");
  fireEvent.click(screen.getByRole("button", { name: "Check application status" }));
  await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
  client.clear();
});

it.each([
  { status: "pending", title: "Application received!" },
  { status: "accepted", title: "You're accepted!" },
  { status: "approved", title: "You're all set!" },
])("shows historical receipts, not current pricing, for $status", async ({ status, title }) => {
  route.params = { id: "ba_historical_fixture" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname === "/api/application-fees") {
      // Today's prices are deliberately different from both recorded payments.
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    return Response.json({
      id: route.params.id, status, paidAt: "2026-09-01T12:00:00Z",
      applicationPayment: { amountCents: 1900, currency: "usd" },
      onboardingPayment: status === "approved" ? { amountCents: 6400, currency: "cad" } : null,
    });
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText(title);
  expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
  expect(screen.queryByText("Application fee paid: $1.00")).toBeNull();
  if (status === "approved") {
    expect(screen.getByText("Onboarding fee paid: CA$64.00")).toBeTruthy();
    expect(screen.queryByText("Onboarding fee paid: $2.00")).toBeNull();
  }
  if (status === "accepted") {
    expect(screen.getByText("Pay $2.00 onboarding fee")).toBeTruthy();
  }
  client.clear();
});

it("confirms a legacy approved payment without claiming today's amounts", async () => {
  route.params = { id: "ba_legacy_fixture" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    return Response.json({
      id: route.params.id, status: "approved", paidAt: "2026-09-01T12:00:00Z",
      applicationPayment: null, onboardingPayment: null,
    });
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText("You're all set!");
  expect(screen.getByText(/Your onboarding fee has been received/)).toBeTruthy();
  expect(screen.queryByText(/Application fee paid:/)).toBeNull();
  expect(screen.queryByText(/Onboarding fee paid:/)).toBeNull();
  client.clear();
});
