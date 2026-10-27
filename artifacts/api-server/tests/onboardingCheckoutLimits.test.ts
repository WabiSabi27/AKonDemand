import { afterEach, expect, it, vi } from "vitest";
import {
  onboardingCheckoutBudget,
  OnboardingCheckoutUnavailable,
} from "../src/lib/onboardingCheckoutLimits";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("gives Stripe positive whole milliseconds even near the monotonic deadline", () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const budget = onboardingCheckoutBudget(1_000);
  elapsed = 100.25;
  expect(budget.requestOptions()).toEqual({ timeout: 900, maxNetworkRetries: 0 });
  elapsed = 999.75;
  expect(budget.requestOptions()).toEqual({ timeout: 1, maxNetworkRetries: 0 });
  elapsed = 1_000;
  expect(() => budget.requestOptions()).toThrow(OnboardingCheckoutUnavailable);
});

it("charges credentials and successive provider stages to one deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const budget = onboardingCheckoutBudget(1_000);
  const credentials = vi.fn(async () => {
    await vi.advanceTimersByTimeAsync(100);
    return "synthetic client";
  });
  expect(await budget.read(credentials)).toBe("synthetic client");
  expect(vi.getTimerCount()).toBe(0);

  // Retrieval, expiration, price lookup, then creation: no stage resets time.
  const timeouts = [];
  for (const elapsed of [200, 300, 150, 250]) {
    const options = budget.requestOptions();
    expect(options.maxNetworkRetries).toBe(0);
    timeouts.push(options.timeout);
    await vi.advanceTimersByTimeAsync(elapsed);
  }
  expect(timeouts).toEqual([900, 700, 400, 250]);
  expect(() => budget.requestOptions()).toThrow(OnboardingCheckoutUnavailable);
});

it.each([0, 1])("refuses new operations at or beyond the deadline (overrun: %s ms)", async overrun => {
  vi.useFakeTimers();
  const budget = onboardingCheckoutBudget(1_000);
  await vi.advanceTimersByTimeAsync(400);
  expect(budget.requestOptions()).toEqual({ timeout: 600, maxNetworkRetries: 0 });
  await vi.advanceTimersByTimeAsync(600 + overrun);

  const laterRead = vi.fn(async () => "must not run");
  await expect(budget.read(laterRead)).rejects.toBeInstanceOf(OnboardingCheckoutUnavailable);
  expect(laterRead).not.toHaveBeenCalled();
  expect(() => budget.requestOptions()).toThrow(OnboardingCheckoutUnavailable);
  expect(vi.getTimerCount()).toBe(0);
});

it("times out a later credential read using only the remaining budget", async () => {
  vi.useFakeTimers();
  const budget = onboardingCheckoutBudget(1_000);
  await budget.read(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  const stalledRead = vi.fn(() => new Promise<never>(() => {}));
  const pending = budget.read(stalledRead);
  // Attach the rejection assertion before advancing the rejection timer.
  const rejected = expect(pending).rejects.toBeInstanceOf(OnboardingCheckoutUnavailable);
  await vi.advanceTimersByTimeAsync(299);
  expect(stalledRead).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([-86_400_000, 86_400_000])(
  "keeps the shared deadline when the wall clock jumps by %s ms",
  async adjustment => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const budget = onboardingCheckoutBudget(1_000);
    await budget.read(async () => {
      await vi.advanceTimersByTimeAsync(100);
      vi.setSystemTime(Date.now() + adjustment);
    });

    // Synthetic provider stages share the original deadline despite repeated
    // clock corrections. No provider call or retry can start after it.
    const provider = vi.fn(async (elapsed: number) => {
      const options = budget.requestOptions();
      vi.setSystemTime(Date.now() + adjustment);
      await vi.advanceTimersByTimeAsync(elapsed);
      return options;
    });
    for (const [elapsed, remaining] of [[200, 900], [300, 700], [150, 400], [250, 250]]) {
      expect(await provider(elapsed)).toEqual({ timeout: remaining, maxNetworkRetries: 0 });
    }
    expect(provider).toHaveBeenCalledTimes(4);
    expect(() => budget.requestOptions()).toThrow(OnboardingCheckoutUnavailable);
    const laterRead = vi.fn(async () => "must not run");
    await expect(budget.read(laterRead)).rejects.toBeInstanceOf(OnboardingCheckoutUnavailable);
    expect(laterRead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([-86_400_000, 86_400_000])(
  "keeps a pending credential timeout when the wall clock jumps by %s ms",
  async adjustment => {
    vi.useFakeTimers();
    const budget = onboardingCheckoutBudget(1_000);
    await vi.advanceTimersByTimeAsync(700);
    const stalledRead = vi.fn(() => new Promise<never>(() => {}));
    const pending = budget.read(stalledRead);
    const rejected = expect(pending).rejects.toBeInstanceOf(OnboardingCheckoutUnavailable);
    vi.setSystemTime(Date.now() + adjustment);
    await vi.advanceTimersByTimeAsync(299);
    expect(stalledRead).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(budget.requestOptions()).toEqual({ timeout: 1, maxNetworkRetries: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(() => budget.requestOptions()).toThrow(OnboardingCheckoutUnavailable);
    expect(vi.getTimerCount()).toBe(0);
  },
);
