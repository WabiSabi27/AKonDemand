import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { WebBrowserResultType } from "expo-web-browser/build/WebBrowser.types";
import LoginScreen from "../app/login";
import PaymentReturnScreen from "../app/payment-return";
import { advance, renderDashboard } from "./support/dashboard";
import { formatFee } from "../utils/fees";

vi.mock("@/components/FireweedDecor", () => ({ default: () => null }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("react-native-keyboard-controller", async () => ({
  KeyboardAwareScrollView: (await import("react-native")).ScrollView,
}));
vi.mock("react-native-reanimated", async () => ({
  default: { View: (await import("react-native")).View },
  FadeIn: { duration: () => undefined },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: React.EffectCallback) => React.useEffect(effect, [effect]),
  router: { push: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ replace: vi.fn() }),
  useLocalSearchParams: () => ({ id: "ba_synthetic" }),
}));
vi.mock("@/context/AppContext", () => ({
  useApp: () => ({ bizAccounts: [], categories: [{ id: "cat_test", name: "Cleaning" }] }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Platform.OS = "web";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const statusConflicts = [
  { status: "rejected", knownReceipts: true },
  { status: "rejected", knownReceipts: false },
  { status: "approved", knownReceipts: true },
  { status: "approved", knownReceipts: false },
] as const;

it.each((["web", "ios", "android"] as const).flatMap(platform =>
  statusConflicts.map(fixture => ({ ...fixture, platform })),
))("replaces stale acceptance with $status on $platform after a non-price conflict (known receipts: $knownReceipts)", async ({ status, knownReceipts, platform }) => {
  Platform.OS = platform;
  const nativeOpen = vi.mocked(WebBrowser.openAuthSessionAsync);
  nativeOpen.mockReset();
  nativeOpen.mockResolvedValue({ type: WebBrowserResultType.CANCEL });
  let currentStatus = "accepted";
  const submissions: unknown[] = [];
  const statusReads: string[] = [];
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/application-fees")) {
      // Pricing never changes: this 409 is exclusively about eligibility.
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    if (url.endsWith("/status")) {
      statusReads.push(currentStatus);
      return Response.json({
        id: "ba_synthetic", status: currentStatus, paidAt: "2026-08-01T00:00:00Z",
        applicationPayment: knownReceipts ? { amountCents: 1900, currency: "usd" } : null,
        onboardingPayment: knownReceipts && currentStatus === "approved"
          ? { amountCents: 7900, currency: "usd" } : null,
      });
    }
    if (url.endsWith("/onboarding-checkout")) {
      expect(init?.method).toBe("POST");
      submissions.push(JSON.parse(init!.body as string));
      return Response.json({
        error: `Onboarding payment is only available once your application is accepted (current status: "${currentStatus}").`,
      }, { status: 409 });
    }
    throw new Error(`Unexpected test request: ${url}`);
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    if (knownReceipts) expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();

    // The admin changes eligibility while the applicant still sees acceptance.
    vi.useFakeTimers();
    currentStatus = status;
    await act(async () => { fireEvent.click(pay); });
    await advance();
    const expectTerminal = () => {
      expect(screen.getByText(status === "approved" ? "You're all set!" : "Application not approved")).toBeTruthy();
      expect(screen.getByRole("button", { name: status === "approved" ? "Sign in" : "Back to Login" })).toBeTruthy();
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByText("Opening secure checkout…")).toBeNull();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
    };
    expectTerminal();
    expect(statusReads).toEqual(["accepted", status]);

    const expectReceipts = () => {
      if (knownReceipts) {
        expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
        if (status === "approved") expect(screen.getByText("Onboarding fee paid: $79.00")).toBeTruthy();
        else expect(screen.queryByText(/Onboarding fee paid:/)).toBeNull();
      } else {
        expect(screen.queryByText(/Application fee paid:|Onboarding fee paid:/)).toBeNull();
      }
      expect(screen.queryByText("Application fee paid: $1.00")).toBeNull();
      expect(screen.queryByText("Onboarding fee paid: $2.00")).toBeNull();
    };
    expectReceipts();
    expect(submissions).toEqual([{ expectedOnboardingFeeCents: 200 }]);
    expect(open).not.toHaveBeenCalled();
    expect(nativeOpen).not.toHaveBeenCalled();

    // Query refreshes and the full polling budget must not restart checkout.
    await act(async () => {
      await client.refetchQueries();
    });
    await advance(30_000);
    expect(submissions).toEqual([{ expectedOnboardingFeeCents: 200 }]);
    expect(statusReads).toEqual(["accepted", status]);
    expect(open).not.toHaveBeenCalled();
    expect(nativeOpen).not.toHaveBeenCalled();
    expectTerminal();
    expectReceipts();
  } finally {
    cleanup();
    client.clear();
  }
});

it.each((["web", "ios", "android"] as const).flatMap(platform =>
  statusConflicts.flatMap(fixture =>
    (["network", "503"] as const).map(failure => ({ ...fixture, platform, failure })),
  ),
))("keeps $status visible on $platform with unavailable pricing after $failure status failures (known receipts: $knownReceipts)", async ({ status, knownReceipts, platform, failure }) => {
  Platform.OS = platform;
  const nativeOpen = vi.mocked(WebBrowser.openAuthSessionAsync);
  nativeOpen.mockReset();
  nativeOpen.mockResolvedValue({ type: WebBrowserResultType.CANCEL });
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  let conflict = false;
  let statusUnavailable = false;
  const submissions: unknown[] = [];
  const fees = vi.fn(() => conflict
    ? Response.json({ error: "Pricing unavailable" }, { status: 503 })
    : Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
  const readStatus = vi.fn(() => {
    if (statusUnavailable) {
      if (failure === "network") throw new TypeError("Synthetic status outage");
      return Response.json({ error: "Status unavailable" }, { status: 503 });
    }
    return Response.json({
      id: "ba_synthetic", status: conflict ? status : "accepted",
      paidAt: "2026-08-01T00:00:00Z",
      applicationPayment: knownReceipts ? { amountCents: 1900, currency: "usd" } : null,
      onboardingPayment: knownReceipts && conflict && status === "approved"
        ? { amountCents: 7900, currency: "usd" } : null,
    });
  });
  const unexpectedRequests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/biz-accounts/ba_synthetic/onboarding-checkout") {
      expect(init?.method).toBe("POST");
      submissions.push(JSON.parse(init!.body as string));
      conflict = true;
      statusUnavailable = true;
      return Response.json({ error: "Application status changed" }, { status: 409 });
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") return fees();
    if (path === "/api/biz-accounts/ba_synthetic/status") return readStatus();
    unexpectedRequests.push(path);
    throw new Error(`Unexpected test request: ${path}`);
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    if (knownReceipts) expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(pay); });
    await advance();

    const expectNoCheckout = () => {
      expect(submissions).toEqual([{ expectedOnboardingFeeCents: 200 }]);
      expect(open).not.toHaveBeenCalled();
      expect(nativeOpen).not.toHaveBeenCalled();
      expect(unexpectedRequests).toEqual([]);
    };
    const expectNoPaymentControls = () => {
      expect(screen.queryByText("You're accepted!")).toBeNull();
      expect(screen.queryByText("Opening secure checkout…")).toBeNull();
      expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
      expect(screen.queryByText("Could not load fees. Tap to retry.")).toBeNull();
    };
    expect(fees).toHaveBeenCalledTimes(2);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expectNoPaymentControls();
    expectNoCheckout();
    await advance(1999);
    expect(readStatus).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Check 2…")).toBeTruthy();
    expectNoPaymentControls();
    expectNoCheckout();

    statusUnavailable = false;
    await advance(2000);
    const expectFinalDecision = () => {
      expect(screen.getByText(status === "approved" ? "You're all set!" : "Application not approved")).toBeTruthy();
      expect(screen.getByRole("button", { name: status === "approved" ? "Sign in" : "Back to Login" })).toBeTruthy();
      expect(screen.queryByText("Confirming your payment…")).toBeNull();
      if (knownReceipts) {
        expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
        if (status === "approved") expect(screen.getByText("Onboarding fee paid: $79.00")).toBeTruthy();
        else expect(screen.queryByText(/Onboarding fee paid:/)).toBeNull();
      } else {
        expect(screen.queryByText(/Application fee paid:|Onboarding fee paid:/)).toBeNull();
      }
      expect(screen.queryByText("Application fee paid: $1.00")).toBeNull();
      expect(screen.queryByText("Onboarding fee paid: $2.00")).toBeNull();
      expectNoPaymentControls();
      expectNoCheckout();
    };
    expect(readStatus).toHaveBeenCalledTimes(4);
    expectFinalDecision();

    // Background pricing reads still fail, but must not replace a final decision
    // or its recorded receipts with stale acceptance or payment controls.
    await act(async () => { await client.refetchQueries(); });
    await advance();
    expect(fees).toHaveBeenCalledTimes(3);
    expectFinalDecision();
    await advance(30_000);
    expect(readStatus).toHaveBeenCalledTimes(4);
    expect(fees).toHaveBeenCalledTimes(3);
    expectFinalDecision();
  } finally {
    cleanup();
    client.clear();
  }
});

it("refreshes a stale onboarding fee and requires another deliberate payment click", async () => {
  let cents = 200;
  let checkoutOpened = false;
  const open = vi.spyOn(window, "open").mockImplementation(() => {
    checkoutOpened = true;
    return {} as Window;
  });
  const submissions: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/application-fees")) {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: cents, currency: "usd" });
    }
    if (url.endsWith("/status")) {
      return Response.json({ id: "ba_synthetic", status: checkoutOpened ? "approved" : "accepted", paidAt: null, meetingAt: null, meetingLocation: null, meetingDurationMinutes: null });
    }
    if (url.endsWith("/onboarding-checkout")) {
      submissions.push(JSON.parse(init!.body as string).expectedOnboardingFeeCents);
      if (submissions.at(-1) !== cents) return Response.json({ error: "Fee changed" }, { status: 409 });
      return Response.json({ checkoutUrl: "https://checkout.example.test/onboarding" });
    }
    throw new Error("Unexpected test request");
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  const displayed = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
  // The applicant is still looking at $2 when server configuration changes.
  cents = 350;
  fireEvent.click(displayed);
  await screen.findByRole("button", { name: "Pay $3.50 onboarding fee" });
  expect(screen.getByText(/Review the updated details/)).toBeTruthy();
  expect(submissions).toEqual([200]);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Pay $3.50 onboarding fee" }));
  await waitFor(() => expect(submissions).toEqual([200, 350]));
  await screen.findByText("You're all set!");
  expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/onboarding", "_blank", "noopener,noreferrer");
  client.clear();
});

it("keeps onboarding checkout blocked when a conflict's pricing refresh fails, until an explicit retry succeeds", async () => {
  let cents = 200;
  let failPricing = false;
  const submissions: number[] = [];
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/application-fees")) {
      return failPricing
        ? Response.json({ error: "Pricing unavailable" }, { status: 503 })
        : Response.json({ applicationFeeCents: 100, onboardingFeeCents: cents, currency: "usd" });
    }
    if (url.endsWith("/status")) return Response.json({ id: "ba_synthetic", status: "accepted" });
    if (url.endsWith("/onboarding-checkout")) {
      submissions.push(JSON.parse(init!.body as string).expectedOnboardingFeeCents);
      return Response.json({ error: "Fee changed" }, { status: 409 });
    }
    throw new Error("Unexpected test request");
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
  cents = 350;
  failPricing = true;
  fireEvent.click(pay);
  const retry = await screen.findByText("Could not load fees. Tap to retry.");
  const disabled = screen.getByRole("button", { name: "Loading onboarding fee…" }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true);
  fireEvent.click(disabled);
  expect(submissions).toEqual([200]);
  expect(open).not.toHaveBeenCalled();

  failPricing = false;
  fireEvent.click(retry);
  await screen.findByRole("button", { name: "Pay $3.50 onboarding fee" });
  expect(submissions).toEqual([200]);
  expect(open).not.toHaveBeenCalled();
  client.clear();
});

it.each(["network", "503"] as const)("keeps recovered acceptance blocked after another failed pricing retry following a conflict and %s status failures", async failure => {
  let failPricing = false;
  let failStatus = false;
  let approved = false;
  let resolvePricing!: (response: Response) => void;
  const submissions: unknown[] = [];
  const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  const nativeOpen = vi.mocked(WebBrowser.openAuthSessionAsync);
  nativeOpen.mockReset();
  const fees = vi.fn<() => Response | Promise<Response>>(() => failPricing
    ? Response.json({ error: "Pricing unavailable" }, { status: 503 })
    : Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
  const status = vi.fn(() => {
    if (failStatus) {
      if (failure === "network") throw new TypeError("Synthetic status outage");
      return Response.json({ error: "Status unavailable" }, { status: 503 });
    }
    return Response.json({ id: "ba_synthetic", status: approved ? "approved" : "accepted" });
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/biz-accounts/ba_synthetic/onboarding-checkout") {
      expect(init?.method).toBe("POST");
      submissions.push(JSON.parse(init!.body as string));
      return submissions.length === 1
        ? Response.json({ error: "Fee changed" }, { status: 409 })
        : Response.json({ checkoutUrl: "https://checkout.example.test/combined-recovery" });
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") return fees();
    expect(path).toBe("/api/biz-accounts/ba_synthetic/status");
    return status();
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  try {
    const pay = await screen.findByRole("button", { name: "Pay $2.00 onboarding fee" });
    vi.useFakeTimers();
    failPricing = true;
    failStatus = true;
    await act(async () => { fireEvent.click(pay); });
    await advance();

    const expectNoCheckout = () => {
      expect(submissions).toEqual([{ expectedOnboardingFeeCents: 200 }]);
      expect(open).not.toHaveBeenCalled();
      expect(nativeOpen).not.toHaveBeenCalled();
    };
    expect(fees).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Check 1…")).toBeTruthy();
    expect(screen.queryByText("You're accepted!")).toBeNull();
    expect(screen.queryByRole("button", { name: /onboarding fee/i })).toBeNull();
    expectNoCheckout();
    await advance(1999);
    expect(status).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Check 2…")).toBeTruthy();
    expectNoCheckout();

    failStatus = false;
    await advance(2000);
    const expectPricingBlocked = () => {
      expect(screen.getByText("You're accepted!")).toBeTruthy();
      expect(screen.getByText(/Review the updated details before paying/)).toBeTruthy();
      expect(screen.getByText("Could not load fees. Tap to retry.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Pay $2.00 onboarding fee" })).toBeNull();
      const disabled = screen.getByRole("button", { name: "Loading onboarding fee…" }) as HTMLButtonElement;
      expect(disabled.disabled).toBe(true);
      fireEvent.click(disabled);
      expectNoCheckout();
    };
    expect(status).toHaveBeenCalledTimes(4);
    expectPricingBlocked();
    await advance(30_000);
    expect(status).toHaveBeenCalledTimes(4);
    expect(fees).toHaveBeenCalledTimes(2);
    expectPricingBlocked();

    // Hold the explicit pricing retry open to check the in-flight guard too.
    fees.mockImplementation(() => new Promise<Response>(resolve => { resolvePricing = resolve; }));
    await act(async () => { fireEvent.click(screen.getByText("Could not load fees. Tap to retry.")); });
    await advance();
    expect(fees).toHaveBeenCalledTimes(3);
    const loading = screen.getByRole("button", { name: "Loading onboarding fee…" }) as HTMLButtonElement;
    expect(loading.disabled).toBe(true);
    fireEvent.click(loading);
    expectNoCheckout();
    await advance(30_000);
    expect(fees).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledTimes(4);
    expect(loading.disabled).toBe(true);
    expectNoCheckout();
    await act(async () => {
      resolvePricing(Response.json({ error: "Pricing still unavailable" }, { status: 503 }));
    });
    await advance();
    expectPricingBlocked();
    await advance(30_000);
    expect(fees).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledTimes(4);
    expectPricingBlocked();

    // Another deliberate retry can restore pricing, but cannot start checkout.
    await act(async () => { fireEvent.click(screen.getByText("Could not load fees. Tap to retry.")); });
    await advance();
    expect(fees).toHaveBeenCalledTimes(4);
    const retryLoading = screen.getByRole("button", { name: "Loading onboarding fee…" }) as HTMLButtonElement;
    expect(retryLoading.disabled).toBe(true);
    fireEvent.click(retryLoading);
    expectNoCheckout();
    await act(async () => {
      resolvePricing(Response.json({ applicationFeeCents: 100, onboardingFeeCents: 350, currency: "usd" }));
    });
    await advance();
    const refreshedPay = screen.getByRole("button", { name: "Pay $3.50 onboarding fee" }) as HTMLButtonElement;
    expect(refreshedPay.disabled).toBe(false);
    expect(screen.queryByText("Could not load fees. Tap to retry.")).toBeNull();
    expectNoCheckout();
    await advance(30_000);
    expect(fees).toHaveBeenCalledTimes(4);
    expect(status).toHaveBeenCalledTimes(4);
    expectNoCheckout();

    // Recovering either read must never replace this deliberate second click.
    approved = true;
    await act(async () => { fireEvent.click(refreshedPay); });
    await advance();
    expect(submissions).toEqual([
      { expectedOnboardingFeeCents: 200 },
      { expectedOnboardingFeeCents: 350 },
    ]);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://checkout.example.test/combined-recovery", "_blank", "noopener,noreferrer");
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    await advance(30_000);
    expect(submissions).toHaveLength(2);
    expect(open).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    client.clear();
  }
});

it.each([true, false])("shows only the historical recorded amount, if known (%s)", async known => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/application-fees")) {
      return Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" });
    }
    return Response.json({
      id: "ba_synthetic", status: "pending", paidAt: "2026-08-01T00:00:00Z",
      meetingAt: null, meetingLocation: null, meetingDurationMinutes: null,
      applicationPayment: known ? { amountCents: 1900, currency: "usd" } : null,
      onboardingPayment: null,
    });
  }));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText("Application received!");
  if (known) expect(screen.getByText("Application fee paid: $19.00")).toBeTruthy();
  else expect(screen.queryByText(/Application fee paid:/)).toBeNull();
  expect(screen.queryByText("Application fee paid: $1.00")).toBeNull();
  client.clear();
});

function goToPayment() {
  fireEvent.click(screen.getByText("New Service Provider?"));
  const fill = (placeholder: string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
  fill("Your business name", "Fee Test Business");
  fill("Full legal name", "Fee Test Owner");
  fill("e.g. 907-555-1234", "9075551234");
  fill("your@business.com", "synthetic@example.test");
  fill("Min 8 characters", "synthetic-password");
  fill("Re-enter password", "synthetic-password");
  fireEvent.click(screen.getByText("Continue"));
  fireEvent.click(screen.getByText("Home-Based Business"));
  fireEvent.click(screen.getByText("New Business"));
  fill("e.g. AK-123456", "AK-123456");
  fireEvent.click(screen.getByText("Select a service category…"));
  fireEvent.click(screen.getByText("Cleaning"));
  fill("Briefly describe your business, services offered, and service area...", "Cleaning services");
  fireEvent.click(screen.getByText("Continue"));
  fill("e.g. House Cleaning", "Cleaning");
  fill("0.00", "50");
  fireEvent.click(screen.getByText("Continue to Payment"));
}

it.each([100, 1234])("uses the API's %i cents for both totals, terms and payment request", async cents => {
  let posted: { url: string; expectedApplicationFeeCents: number } | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/application-fees")) {
      return Response.json({ applicationFeeCents: cents, onboardingFeeCents: 200, currency: "usd" });
    }
    posted = { url: String(input), ...JSON.parse(init!.body as string) };
    return Response.json({ error: "Synthetic stop before Stripe" }, { status: 502 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  const { client } = renderDashboard(<LoginScreen />);
  goToPayment();
  const fee = formatFee(cents, "usd");
  const pay = await screen.findByRole("button", { name: `Pay ${fee} Application Fee` });
  expect(screen.getAllByText(fee)).toHaveLength(2);
  expect(screen.getByText(`The ${fee} application fee is non-refundable.`)).toBeTruthy();
  expect(screen.queryByText(/\$79\.00/)).toBeNull();
  fireEvent.click(pay);
  await waitFor(() => expect(posted).toBeDefined());
  expect(posted!.url).toContain("/api/biz-accounts");
  expect(posted!.expectedApplicationFeeCents).toBe(cents);
  client.clear();
});

it("refreshes a changed fee after checkout rejects the displayed amount, without automatically resubmitting", async () => {
  let cents = 100;
  let submissions = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/application-fees")) {
      return Response.json({ applicationFeeCents: cents, onboardingFeeCents: 200, currency: "usd" });
    }
    submissions += 1;
    cents = 1234;
    return Response.json({ error: "The application fee has changed." }, { status: 409 });
  }));
  vi.spyOn(window, "alert").mockImplementation(() => {});
  const { client } = renderDashboard(<LoginScreen />);
  goToPayment();
  fireEvent.click(await screen.findByRole("button", { name: "Pay $1.00 Application Fee" }));
  await screen.findByRole("button", { name: "Pay $12.34 Application Fee" });
  expect(screen.getAllByText("$12.34")).toHaveLength(2);
  expect(submissions).toBe(1);
  client.clear();
});

it("blocks payment while pricing loads and offers retry after a pricing failure", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetchMock);
  const { client } = renderDashboard(<LoginScreen />);
  goToPayment();
  const pay = screen.getByRole("button", { name: "Loading application fee…" }) as HTMLButtonElement;
  expect(pay.disabled).toBe(true);
  fireEvent.click(pay);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
  const retry = await screen.findByText("Could not load the application fee. Tap to retry.");
  expect((screen.getByRole("button", { name: "Payment unavailable" }) as HTMLButtonElement).disabled).toBe(true);
  fetchMock.mockImplementation(async () => Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
  fireEvent.click(retry);
  await screen.findByRole("button", { name: "Pay $1.00 Application Fee" });
  client.clear();
});

it.each(["pending", "rejected", "accepted"])("confirmation copy has no hardcoded application charge (%s)", async status => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    Response.json(String(input).endsWith("/api/application-fees")
      ? { applicationFeeCents: 1234, onboardingFeeCents: 567, currency: "usd" }
      : { id: "ba_synthetic", status, paidAt: null }),
  ));
  const { client } = renderDashboard(<PaymentReturnScreen />);
  await screen.findByText(status === "pending" ? "Application received!" : status === "accepted" ? "You're accepted!" : "Application not approved");
  if (status === "accepted") await screen.findByRole("button", { name: "Pay $5.67 onboarding fee" });
  expect(screen.queryByText(/\$1\b|\$79\b/)).toBeNull();
  client.clear();
});
