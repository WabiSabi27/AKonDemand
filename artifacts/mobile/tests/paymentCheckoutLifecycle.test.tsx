import React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import PaymentReturnScreen from "../app/payment-return";
import { advance, renderDashboard } from "./support/dashboard";

const route = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  events: null as null | { focus: () => void; blur: () => void },
}));
vi.mock("expo-router", () => ({
  // A pushed screen emits blur without unmounting the previous stack screen.
  useFocusEffect: (effect: React.EffectCallback) => React.useEffect(() => {
    let dispose: ReturnType<React.EffectCallback>;
    const focus = () => { dispose = effect(); };
    const blur = () => { dispose?.(); dispose = undefined; };
    route.events = { focus, blur };
    focus();
    return () => { blur(); route.events = null; };
  }, [effect]),
  useLocalSearchParams: () => route.params,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  WebBrowserResultType: { CANCEL: "cancel", DISMISS: "dismiss" },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), removeItem: vi.fn(async () => {}) },
}));

afterEach(() => {
  cleanup();
  Platform.OS = "web";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const checkoutUrl = "https://checkout.example.test/lifecycle";
function setup() {
  route.params = { id: "ba_checkout_old" };
  const checkout = vi.fn<() => Response | Promise<Response>>(() => Response.json({ checkoutUrl }));
  const status = vi.fn((id: string) => Response.json({ id, status: "accepted" }));
  const fees = vi.fn<() => Response | Promise<Response>>(() => Response.json({
    applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd",
  }));
  const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/onboarding-checkout")) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ expectedOnboardingFeeCents: 200 });
      return checkout();
    }
    expect(init?.method ?? "GET").toBe("GET");
    if (path === "/api/application-fees") return fees();
    const match = /^\/api\/biz-accounts\/([^/]+)\/status$/.exec(path);
    expect(match).not.toBeNull();
    return status(match![1]);
  }));
  vi.useFakeTimers();
  const view = renderDashboard(<PaymentReturnScreen />);
  const changeRoute = async (params = { id: "ba_checkout_new" } as Record<string, string>) => {
    route.params = params;
    view.rerender(<QueryClientProvider client={view.client}><PaymentReturnScreen /></QueryClientProvider>);
    await advance();
  };
  return { ...view, checkout, status, fees, open, changeRoute };
}

async function pay() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Pay $2.00 onboarding fee" }));
  });
  await advance();
}

it.each(["web", "ios", "android"] as const)(
  "never launches %s checkout when its deferred response arrives after unmount",
  async platform => {
    Platform.OS = platform;
    const view = setup();
    const reply = deferred<Response>();
    view.checkout.mockReturnValueOnce(reply.promise);
    await advance();
    await pay();
    expect(view.checkout).toHaveBeenCalledOnce();
    view.unmount();
    view.client.clear();
    await act(async () => { reply.resolve(Response.json({ checkoutUrl })); });
    await advance();
    expect(view.open).not.toHaveBeenCalled();
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(view.status).toHaveBeenCalledOnce();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  },
);

it.each(["success", "conflict", "failure"] as const)(
  "ignores an old checkout %s after route replacement while a new checkout is pending",
  async outcome => {
    const view = setup();
    const oldReply = deferred<Response>();
    const newReply = deferred<Response>();
    view.checkout.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
    await advance();
    await pay();
    await view.changeRoute();
    const newPay = screen.getByRole("button", { name: "Pay $2.00 onboarding fee" });
    await act(async () => {
      fireEvent.click(newPay);
      // Resolve the old request before React commits the new loading screen.
      if (outcome === "failure") oldReply.reject(new TypeError("Late checkout failure"));
      else oldReply.resolve(Response.json(outcome === "conflict" ? { error: "Changed" } : { checkoutUrl },
        { status: outcome === "conflict" ? 409 : 200 }));
      await oldReply.promise.catch(() => {});
    });
    await advance();
    expect(screen.getByText("Opening secure checkout…")).toBeTruthy();
    expect(screen.queryByText(/Review the updated details/)).toBeNull();
    expect(view.fees).toHaveBeenCalledOnce();
    expect(view.open).not.toHaveBeenCalled();
    expect(view.status).toHaveBeenCalledTimes(2);
    await act(async () => { newReply.resolve(Response.json({ checkoutUrl })); });
    await advance();
    expect(view.open).toHaveBeenCalledExactlyOnceWith(checkoutUrl, "_blank", "noopener,noreferrer");
    expect(view.checkout).toHaveBeenCalledTimes(2);
    expect(view.status).toHaveBeenLastCalledWith("ba_checkout_new");
    view.unmount();
    view.client.clear();
  },
);

it.each(["success", "cancel", "dismiss", "failure"] as const)(
  "ignores a deferred native browser %s after the route changes",
  async outcome => {
    Platform.OS = "ios";
    const browser = deferred<WebBrowser.WebBrowserAuthSessionResult>();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(browser.promise);
    const view = setup();
    await advance();
    await pay();
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledExactlyOnceWith(checkoutUrl, null);
    await view.changeRoute();
    await act(async () => {
      if (outcome === "failure") browser.reject(new Error("Late browser failure"));
      else browser.resolve(outcome === "success"
        ? { type: "success", url: "https://example.test/payment-return" }
        : { type: outcome === "cancel" ? WebBrowser.WebBrowserResultType.CANCEL : WebBrowser.WebBrowserResultType.DISMISS });
    });
    await advance(60_000);
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    expect(screen.queryByText(/checkout was closed/)).toBeNull();
    expect(view.status).toHaveBeenCalledTimes(2);
    expect(view.checkout).toHaveBeenCalledOnce();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  },
);

it.each(["success", "cancel", "dismiss"] as const)(
  "still refreshes status when the current native checkout returns %s",
  async outcome => {
    Platform.OS = "android";
    const browser = deferred<WebBrowser.WebBrowserAuthSessionResult>();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(browser.promise);
    const view = setup();
    await advance();
    await pay();
    expect(view.status).toHaveBeenCalledOnce();
    view.status.mockImplementation(id => Response.json({ id, status: "approved" }));
    await act(async () => {
      browser.resolve(outcome === "success"
        ? { type: "success", url: "https://example.test/payment-return" }
        : { type: outcome === "cancel" ? WebBrowser.WebBrowserResultType.CANCEL : WebBrowser.WebBrowserResultType.DISMISS });
    });
    await advance();
    expect(screen.getByText("You're all set!")).toBeTruthy();
    expect(view.status).toHaveBeenCalledTimes(2);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith("akodd_application_id");
    expect(view.checkout).toHaveBeenCalledOnce();
    view.unmount();
    view.client.clear();
  },
);

it("ignores a checkout storage lookup that finishes after leaving", async () => {
  const view = setup();
  await advance();
  const pollId = deferred<string | null>();
  const checkoutId = deferred<string | null>();
  vi.mocked(AsyncStorage.getItem).mockReturnValueOnce(pollId.promise).mockReturnValueOnce(checkoutId.promise);
  // A param change can leave the previous acceptance visible while storage loads.
  await view.changeRoute({});
  await pay();
  expect(AsyncStorage.getItem).toHaveBeenCalledTimes(2);
  view.unmount();
  view.client.clear();
  await act(async () => {
    pollId.resolve("ba_saved");
    checkoutId.resolve("ba_saved");
  });
  await advance();
  expect(view.checkout).not.toHaveBeenCalled();
  expect(view.open).not.toHaveBeenCalled();
  expect(view.status).toHaveBeenCalledOnce();
});

it("does not restart the old status poll after a conflict's deferred fee refresh", async () => {
  const view = setup();
  await advance();
  const refresh = deferred<Response>();
  view.fees.mockReturnValueOnce(refresh.promise);
  view.checkout.mockReturnValueOnce(Response.json({ error: "Changed" }, { status: 409 }));
  await pay();
  expect(view.fees).toHaveBeenCalledTimes(2);
  await view.changeRoute();
  await act(async () => {
    refresh.resolve(Response.json({ applicationFeeCents: 100, onboardingFeeCents: 200, currency: "usd" }));
  });
  await advance();
  expect(view.status).toHaveBeenCalledTimes(2);
  expect(screen.getByText("You're accepted!")).toBeTruthy();
  expect(view.open).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it.each(["web", "ios", "android"] as const)(
  "does not launch deferred %s checkout after another route is pushed over the mounted screen",
  async platform => {
    Platform.OS = platform;
    const view = setup();
    const reply = deferred<Response>();
    view.checkout.mockReturnValueOnce(reply.promise);
    await advance();
    await pay();
    act(() => { route.events!.blur(); });
    // The component remains mounted, unlike an unmount/replace test.
    expect(screen.getByText("Opening secure checkout…")).toBeTruthy();
    await act(async () => { reply.resolve(Response.json({ checkoutUrl })); });
    await advance();
    expect(view.open).not.toHaveBeenCalled();
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(view.status).toHaveBeenCalledOnce();
    expect(screen.getByText("Opening secure checkout…")).toBeTruthy();
    act(() => { route.events!.focus(); });
    await advance();
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    view.unmount();
    view.client.clear();
  },
);

it.each(["success", "cancel", "dismiss", "failure"] as const)(
  "ignores a deferred browser %s after blur and refocus of the same mounted screen",
  async outcome => {
    Platform.OS = "ios";
    const browser = deferred<WebBrowser.WebBrowserAuthSessionResult>();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(browser.promise);
    const view = setup();
    await advance();
    await pay();
    act(() => { route.events!.blur(); });
    act(() => { route.events!.focus(); });
    await advance();
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    await act(async () => {
      if (outcome === "failure") browser.reject(new Error("Late browser rejection"));
      else browser.resolve(outcome === "success"
        ? { type: "success", url: "https://example.test/payment-return" }
        : { type: outcome === "cancel" ? WebBrowser.WebBrowserResultType.CANCEL : WebBrowser.WebBrowserResultType.DISMISS });
    });
    await advance(60_000);
    expect(screen.getByText("You're accepted!")).toBeTruthy();
    expect(screen.queryByText(/checkout was closed/)).toBeNull();
    expect(view.status).toHaveBeenCalledTimes(2);
    expect(view.checkout).toHaveBeenCalledOnce();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  },
);
