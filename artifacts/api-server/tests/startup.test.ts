import { describe, expect, it, vi } from "vitest";
import { runStartup, runStartupStep, startOrExit, StartupFailure } from "../src/lib/startup";

describe("API startup", () => {
  const makeLogger = () => ({ info: vi.fn(), error: vi.fn() });

  it("never runs application-schema DDL in production", async () => {
    const schema = vi.fn();
    const stripe = vi.fn();
    await runStartup("production", [{ name: "schema", run: schema }],
      { name: "stripe", run: stripe }, makeLogger());
    expect(schema).not.toHaveBeenCalled();
    expect(stripe).toHaveBeenCalledOnce();
  });

  it("retains ordered development bootstrap before Stripe", async () => {
    const order: string[] = [];
    await runStartup("development", [
      { name: "first", run: async () => { order.push("first"); } },
      { name: "second", run: async () => { order.push("second"); } },
    ], { name: "stripe", run: async () => { order.push("stripe"); } }, makeLogger());
    expect(order).toEqual(["first", "second", "stripe"]);
  });

  it("fails explicitly with the failed step and safe database diagnostics", async () => {
    const log = makeLogger();
    const cause = Object.assign(new Error("private database details"), { code: "42501" });
    const stripe = vi.fn();
    await expect(runStartup("development", [{
      name: "audit-log",
      run: async () => { throw new Error("query with private parameters", { cause }); },
    }], { name: "stripe", run: stripe }, log)).rejects.toThrow("API startup failed at audit-log");
    expect(log.error).toHaveBeenCalledWith({
      step: "audit-log", errorName: "Error", errorCode: "42501",
    }, "API startup failed");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private");
    expect(stripe).not.toHaveBeenCalled();
  });

  it("does not hide Stripe initialization failures in production", async () => {
    await expect(runStartup("production", [], {
      name: "stripe-initialization",
      run: async () => { throw new Error("connection unavailable"); },
    }, makeLogger())).rejects.toThrow("API startup failed at stripe-initialization");
  });

  it("includes app-owned connector diagnostics but never propagates arbitrary causes", async () => {
    const log = makeLogger();
    const error = new Error("Expected one configured Stripe connection; found 0");
    await expect(runStartup("production", [], {
      name: "stripe-initialization",
      run: async () => { throw error; },
    }, log)).rejects.toThrow("Expected one configured Stripe connection; found 0");
    expect(log.error.mock.calls[0][0].diagnostic).toBe(error.message);

    try {
      await runStartup("production", [], {
        name: "stripe-initialization",
        run: async () => { throw new Error("private-placeholder"); },
      }, log);
    } catch (failure) {
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain("private-placeholder");
    }
  });

  it("preserves the precise inner failure instead of replacing it with Stripe initialization", async () => {
    const log = makeLogger();
    await expect(runStartup("production", [], {
      name: "stripe-initialization",
      run: () => runStartupStep({
        name: "stripe-credential-lookup",
        run: async () => { throw new Error("Stripe connector lookup failed: 403 Forbidden"); },
      }, log),
    }, log)).rejects.toThrow("API startup failed at stripe-credential-lookup: Stripe connector lookup failed: 403 Forbidden");
    expect(log.error.mock.calls.every(([context]) =>
      context.step === "stripe-credential-lookup")).toBe(true);
  });

  it("bounds an unresponsive read-only operation and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const result = runStartupStep({
        name: "stripe-credential-lookup",
        timeoutMs: 25_000,
        run: () => new Promise<never>(() => {}),
      }, makeLogger());
      const assertion = expect(result).rejects.toThrow("Startup operation timed out");
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);

      expect(await runStartupStep({
        name: "successful-read",
        timeoutMs: 25_000,
        run: async () => "ok",
      }, makeLogger())).toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing runtime identity without printing the original error", async () => {
    const log = makeLogger();
    await expect(runStartupStep({
      name: "stripe-credential-lookup",
      run: async () => { throw new Error("Replit identity token not found. private-placeholder"); },
    }, log)).rejects.toThrow("Replit runtime identity is unavailable");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private-placeholder");
  });

  it("writes and flushes a short fatal record before exiting, with no raw stack or cause", async () => {
    const events: string[] = [];
    const log = {
      ...makeLogger(),
      fatal: vi.fn(() => { events.push("fatal"); }),
      flush: vi.fn(() => { events.push("flush"); }),
    };
    const stopped = new Error("test-exit");
    const exit = vi.fn((code: number): never => {
      events.push(`exit-${code}`);
      throw stopped;
    });
    await expect(startOrExit(async () => {
      throw new StartupFailure("stripe-credential-lookup", "Error", undefined,
        "Stripe connector lookup failed: 403 Forbidden");
    }, log, exit)).rejects.toBe(stopped);
    expect(events).toEqual(["fatal", "flush", "exit-1"]);
    expect(log.fatal.mock.calls[0]).toEqual([{
      step: "stripe-credential-lookup", errorName: "Error", errorCode: undefined,
      diagnostic: "Stripe connector lookup failed: 403 Forbidden",
    }, "API startup failed at stripe-credential-lookup: Stripe connector lookup failed: 403 Forbidden"]);
  });

  it("never emits arbitrary error messages, names, codes, or oversized stacks in fatal output", async () => {
    const log = { ...makeLogger(), fatal: vi.fn(), flush: vi.fn() };
    const error = Object.assign(new Error("private-placeholder"), {
      name: "private-name", code: "private-code", stack: "x".repeat(100_000),
    });
    const exit = vi.fn((): never => { throw new Error("stopped"); });
    await expect(startOrExit(async () => { throw error; }, log, exit)).rejects.toThrow("stopped");
    const output = JSON.stringify(log.fatal.mock.calls);
    expect(output).not.toContain("private");
    expect(output.length).toBeLessThan(500);
  });

  it("does not exit after successful startup", async () => {
    const log = { ...makeLogger(), fatal: vi.fn(), flush: vi.fn() };
    const exit = vi.fn((): never => { throw new Error("unexpected exit"); });
    await startOrExit(async () => {}, log, exit);
    expect(log.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
