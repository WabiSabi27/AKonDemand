import React, { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { WebBrowserResultType } from "expo-web-browser/build/WebBrowser.types";
import { Platform } from "react-native";
import { QueryClientProvider } from "@tanstack/react-query";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mockStatus(read: (signal?: AbortSignal | null) => Response | Promise<Response>, applicationId?: string) {
  const status = vi.fn(read);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const path = new URL(String(input)).pathname;
    if (path === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    expect(path).toBe(`/api/biz-accounts/${applicationId ?? route.params.id}/status`);
    return status(init?.signal);
  }));
  return status;
}

function response(status: string) {
  return Response.json({
    id: route.params.id, status,
    applicationPayment: { amountCents: 1900, currency: "usd" },
  });
}

it.each(["application", "onboarding", "cancelled"] as const)(
  "ends a stalled %s status GET at 30 seconds without making payment requests",
  async phase => {
    route.params = {
      id: "ba_stalled_fixture",
      ...(phase === "onboarding" ? { success: "true", phase } : {}),
      ...(phase === "cancelled" ? { cancelled: "true" } : {}),
    };
    const status = mockStatus(() => new Promise<Response>(() => {}));
    vi.useFakeTimers();
    const view = renderDashboard(<PaymentReturnScreen />);
    await advance();
    const signal = status.mock.calls[0][0]!;
    expect(signal.aborted).toBe(false);
    await advance(29_999);
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    await advance(1);
    expect(screen.queryByText("Confirming your payment…")).toBeNull();
    expect(screen.getByText(phase === "onboarding"
      ? "Onboarding payment confirmation is delayed"
      : "Something went wrong")).toBeTruthy();
    expect(signal.aborted).toBe(true);
    expect(status).toHaveBeenCalledOnce();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    await advance(30_000);
    expect(status).toHaveBeenCalledOnce();
    view.unmount();
    view.client.clear();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("uses only the remaining budget for a later stalled read", async () => {
  route.params = { id: "ba_remaining_budget_fixture", success: "true", phase: "onboarding" };
  const firstRead = deferred<Response>();
  const status = mockStatus(() => new Promise<Response>(() => {}));
  status.mockImplementationOnce(() => firstRead.promise);
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await advance();
  await advance(25_000);
  await act(async () => { firstRead.resolve(response("accepted")); });
  await advance(2000);
  expect(status).toHaveBeenCalledTimes(2);
  await advance(2999);
  expect(screen.getByText("Confirming your payment…")).toBeTruthy();
  await advance(1);
  expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
  expect(status.mock.calls[1][0]!.aborted).toBe(true);
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it.each(["before retry", "during retry", "late failure"] as const)(
  "ignores an expired read %s and keeps recovery status-only",
  async timing => {
    route.params = { id: "ba_late_timeout_fixture", success: "true", phase: "onboarding" };
    const oldRead = deferred<Response>();
    const retryRead = deferred<Response>();
    const status = mockStatus(() => oldRead.promise);
    vi.useFakeTimers();
    const view = renderDashboard(<PaymentReturnScreen />);
    await advance();
    await advance(30_000);
    expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
    const finishOld = async () => {
      await act(async () => {
        if (timing === "late failure") oldRead.reject(new Error("Late network failure"));
        else oldRead.resolve(response("approved"));
      });
      await advance();
      expect(screen.queryByText("You're all set!")).toBeNull();
      expect(screen.queryByText(/Application fee paid:/)).toBeNull();
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    };
    if (timing === "before retry") await finishOld();
    status.mockImplementation(() => retryRead.promise);
    const check = screen.getByRole("button", { name: "Check payment status" });
    act(() => {
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await advance();
    expect(status).toHaveBeenCalledTimes(2);
    if (timing !== "before retry") await finishOld();
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    // The second stalled GET also releases the retry guard at its own deadline.
    await advance(30_000);
    expect(screen.getByText("Onboarding payment confirmation is delayed")).toBeTruthy();
    status.mockImplementation(() => response("approved"));
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await advance();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    expect(AsyncStorage.removeItem).toHaveBeenCalledExactlyOnceWith("akodd_application_id");
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    view.unmount();
    view.client.clear();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  ["ios", WebBrowserResultType.CANCEL],
  ["ios", WebBrowserResultType.DISMISS],
  ["android", WebBrowserResultType.CANCEL],
  ["android", WebBrowserResultType.DISMISS],
] as const)("ignores an already-open %s checkout's late %s after another application mounts", async (platform, type) => {
  Platform.OS = platform;
  route.params = { id: "ba_old_browser_fixture" };
  const browser = deferred<WebBrowser.WebBrowserAuthSessionResult>();
  vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(browser.promise);
  const checkoutUrl = "https://checkout.example.test/old-browser-session";
  const checkout = vi.fn(() => Response.json({ checkoutUrl }));
  const status = vi.fn<(id: string) => Response>();
  status.mockImplementation(id => Response.json({
    id,
    // Any obsolete read after navigation would also try to clear the saved id.
    status: id === "ba_old_browser_fixture" && status.mock.calls.length > 1 ? "approved" : "accepted",
    applicationPayment: { amountCents: id === "ba_old_browser_fixture" ? 1900 : 7300, currency: "usd" },
  }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/biz-accounts/ba_old_browser_fixture/onboarding-checkout") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
      return checkout();
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    if (path === "/api/biz-accounts/ba_old_browser_fixture/status") return status("ba_old_browser_fixture");
    expect(path).toBe("/api/biz-accounts/ba_new_browser_fixture/status");
    return status("ba_new_browser_fixture");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  const first = renderDashboard(<PaymentReturnScreen />);
  await advance();
  expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" }));
  await advance();
  // The browser is already open, not merely waiting for a checkout response.
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledExactlyOnceWith(checkoutUrl, null);
  expect(screen.getByText("Opening secure checkout…")).toBeTruthy();
  first.unmount();
  first.client.clear();

  // Load a different saved application in a distinct component instance.
  route.params = {};
  vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce("ba_new_browser_fixture");
  const second = renderDashboard(<PaymentReturnScreen />);
  await advance();
  expect(AsyncStorage.getItem).toHaveBeenCalledExactlyOnceWith("akodd_application_id");
  const expectNewApplicationUntouched = () => {
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    expect(screen.getByText("Application fee paid: $73.00")).toBeTruthy();
    expect(screen.queryByText("Application fee paid: $19.00")).toBeNull();
    expect(screen.queryByText(/Onboarding checkout was closed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" })).toBeTruthy();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(status.mock.calls).toEqual([["ba_old_browser_fixture"], ["ba_new_browser_fixture"]]);
    expect(checkout).toHaveBeenCalledOnce();
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(5); // Two fee reads, two status reads, one checkout.
  };
  expectNewApplicationUntouched();
  await act(async () => { browser.resolve({ type }); });
  await advance();
  expectNewApplicationUntouched();
  await advance(60_000);
  expectNewApplicationUntouched();
  second.unmount();
  second.client.clear();
});

it.each(["pending", "approved", "rejected", "accepted", "network failure"])(
  "ignores a late %s response after leaving confirmation, including on a newly mounted screen",
  async outcome => {
    route.params = { id: "ba_lifecycle_fixture" };
    const oldRead = deferred<Response>();
    const status = mockStatus(() => oldRead.promise);
    vi.useFakeTimers();
    const first = renderDashboard(<PaymentReturnScreen />);
    await advance();
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    first.unmount();
    first.client.clear();

    // Re-entering creates a distinct owner; an old response must not affect it.
    status.mockImplementation(() => response("awaiting_payment"));
    const second = renderDashboard(<PaymentReturnScreen />);
    await advance();
    await act(async () => {
      if (outcome === "network failure") oldRead.reject(new Error("Late offline response"));
      else oldRead.resolve(response(outcome));
    });
    await advance();
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expect(screen.queryByText(/Application fee paid:/)).toBeNull();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    await advance(2000);
    expect(status).toHaveBeenCalledTimes(3); // Old read + two current reads only.
    second.unmount();
    second.client.clear();
  },
);

it("cancels the outstanding poll delay immediately when leaving confirmation", async () => {
  route.params = { id: "ba_delay_fixture" };
  const status = mockStatus(() => response("awaiting_payment"));
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await advance();
  const clear = vi.spyOn(globalThis, "clearTimeout");
  view.unmount();
  // Assert cancellation itself, not just that the expired delay skips a request.
  expect(clear).toHaveBeenCalled();
  view.client.clear();
  expect(vi.getTimerCount()).toBe(0);
  await advance(60_000);
  expect(status).toHaveBeenCalledOnce();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
});

it("ignores a saved application id that finishes loading after unmount", async () => {
  route.params = {};
  const storedId = deferred<string | null>();
  vi.mocked(AsyncStorage.getItem).mockReturnValueOnce(storedId.promise);
  const status = mockStatus(() => response("approved"));
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await advance();
  view.unmount();
  await act(async () => { storedId.resolve("ba_storage_fixture"); });
  await advance(60_000);
  expect(status).not.toHaveBeenCalled();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.client.clear();
});

const storageRecoveryMessage = "Could not read your saved application. Your payment status has not been confirmed. Please check your application status again. Do not submit another payment.";

it.each(["application", "onboarding", "cancelled"])(
  "recovers from initial and manual saved-id read failures in the %s phase without opening checkout",
  async phase => {
    route.params = phase === "onboarding"
      ? { success: "true", phase: "onboarding" }
      : phase === "cancelled" ? { cancelled: "true" } : {};
    const initialRead = deferred<string | null>();
    const retryRead = deferred<string | null>();
    const recoveredRead = deferred<string | null>();
    vi.mocked(AsyncStorage.getItem)
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(retryRead.promise)
      .mockReturnValueOnce(recoveredRead.promise);
    const id = "ba_storage_recovery_fixture";
    const status = mockStatus(() => Response.json({ id, status: "accepted" }), id);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.useFakeTimers();
    const view = renderDashboard(<PaymentReturnScreen />);
    await advance();
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    await act(async () => { initialRead.reject(new Error("Private storage error")); });
    expect(screen.getByText(storageRecoveryMessage)).toBeTruthy();
    expect(screen.queryByText(/Please start over/)).toBeNull();
    expect(screen.queryByText("Private storage error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check application status" }));
    await act(async () => { retryRead.reject(new Error("Storage still unavailable")); });
    expect(screen.getByText(storageRecoveryMessage)).toBeTruthy();
    expect(status).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check application status" }));
    await act(async () => { recoveredRead.resolve(id); });
    await advance();
    expect(status).toHaveBeenCalledOnce();
    if (phase === "onboarding") {
      // A storage retry must retain the onboarding phase: accepted is not
      // evidence that another payment is safe.
      await advance(30_000);
      expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
    } else {
      expect(screen.getByText("You're accepted!")).toBeTruthy();
    }
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(3);
    expect(AsyncStorage.getItem).toHaveBeenLastCalledWith("akodd_application_id");
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    // The HTTP fixture rejects every non-GET request, including checkout.
    expect(open).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  },
);

it("ignores a saved-id read rejection after leaving confirmation", async () => {
  route.params = {};
  const storedId = deferred<string | null>();
  vi.mocked(AsyncStorage.getItem).mockReturnValueOnce(storedId.promise);
  const status = mockStatus(() => response("accepted"));
  vi.useFakeTimers();
  const first = renderDashboard(<PaymentReturnScreen />);
  await advance();
  first.unmount();
  first.client.clear();
  route.params = { id: "ba_reentered_fixture" };
  const second = renderDashboard(<PaymentReturnScreen />);
  await advance();
  await act(async () => { storedId.reject(new Error("Obsolete storage failure")); });
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  expect(screen.queryByText(storageRecoveryMessage)).toBeNull();
  expect(status).toHaveBeenCalledOnce();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  second.unmount();
  second.client.clear();
});

it("ignores an obsolete manual saved-id read rejection after a newer check completes", async () => {
  route.params = {};
  const initialRead = deferred<string | null>();
  const oldRead = deferred<string | null>();
  const newRead = deferred<string | null>();
  vi.mocked(AsyncStorage.getItem)
    .mockReturnValueOnce(initialRead.promise)
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(newRead.promise);
  const id = "ba_newest_storage_fixture";
  const status = mockStatus(() => Response.json({ id, status: "accepted" }), id);
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await act(async () => { initialRead.reject(new Error("Initial storage failure")); });
  const check = screen.getByRole("button", { name: "Check application status" });
  act(() => {
    fireEvent.click(check);
    fireEvent.click(check);
  });
  await act(async () => { newRead.resolve(id); });
  await advance();
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  await act(async () => { oldRead.reject(new Error("Obsolete storage failure")); });
  await advance(60_000);
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  expect(screen.queryByText(storageRecoveryMessage)).toBeNull();
  expect(status).toHaveBeenCalledOnce();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it.each(["pending", "approved", "rejected", "accepted", "network failure"])(
  "lets the newest manual check win over a deferred %s response",
  async obsoleteOutcome => {
    route.params = { cancelled: "true", id: "ba_manual_fixture" };
    const status = mockStatus(() => { throw new Error("Initial status unavailable"); });
    vi.useFakeTimers();
    const view = renderDashboard(<PaymentReturnScreen />);
    await advance();
    const check = screen.getByRole("button", { name: "Check application status" });
    const oldRead = deferred<Response>();
    const newRead = deferred<Response>();
    status.mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => newRead.promise);
    act(() => {
      // Both handlers run before React commits the polling screen.
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await advance();
    expect(status).toHaveBeenCalledTimes(3);
    await act(async () => {
      if (obsoleteOutcome === "network failure") oldRead.reject(new Error("Late failure"));
      else oldRead.resolve(response(obsoleteOutcome));
    });
    await advance();
    expect(screen.getByText("Confirming your payment…")).toBeTruthy();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    await act(async () => { newRead.resolve(response("accepted")); });
    await advance();
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    await advance(60_000);
    expect(status).toHaveBeenCalledTimes(3);
    view.unmount();
    view.client.clear();
  },
);

it("does not let an older terminal response overwrite an already completed newer check", async () => {
  route.params = { cancelled: "true", id: "ba_out_of_order_fixture" };
  const status = mockStatus(() => { throw new Error("Offline"); });
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await advance();
  const check = screen.getByRole("button", { name: "Check application status" });
  const oldRead = deferred<Response>();
  status.mockImplementationOnce(() => oldRead.promise)
    .mockImplementationOnce(() => response("accepted"));
  act(() => {
    fireEvent.click(check);
    fireEvent.click(check);
  });
  await advance();
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  await act(async () => { oldRead.resolve(response("approved")); });
  await advance();
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  expect(screen.queryByText("You're all set!")).toBeNull();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it("cancels a previous route's delay when a new application starts on the same screen", async () => {
  route.params = { id: "ba_previous_fixture" };
  const status = mockStatus(() => response("awaiting_payment"));
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  await advance();
  route.params = { id: "ba_next_fixture", cancelled: "true" };
  status.mockImplementation(() => response("accepted"));
  view.rerender(<QueryClientProvider client={view.client}><PaymentReturnScreen /></QueryClientProvider>);
  await advance();
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  await advance(60_000);
  expect(status).toHaveBeenCalledTimes(2);
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it("restarts confirmation safely when React replays the mounting effect", async () => {
  route.params = { id: "ba_strict_fixture" };
  const oldRead = deferred<Response>();
  const status = mockStatus(() => response("accepted"));
  status.mockImplementationOnce(() => oldRead.promise);
  vi.useFakeTimers();
  // StrictMode must be at the root for React 19 to replay effects.
  const { client, unmount } = renderDashboard(<></>);
  unmount();
  const view = render(<StrictMode><QueryClientProvider client={client}>
    <PaymentReturnScreen />
  </QueryClientProvider></StrictMode>);
  await advance();
  expect(status).toHaveBeenCalledTimes(2);
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  await act(async () => { oldRead.resolve(response("approved")); });
  await advance();
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
});
