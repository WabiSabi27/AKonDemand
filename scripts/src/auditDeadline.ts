// Audit-only cancellation. Nothing in the API or webhook client uses this scope.
export class AuditFailure extends Error {
  constructor(phase: string, code: string, detail = "operation failed.") {
    super(`${phase}: ${detail} [${code}]`);
  }
}

export interface AuditReadOptions {
  signal: AbortSignal;
  timeout: number;
  maxNetworkRetries: 0;
}

export class AuditDeadline {
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(milliseconds: number, private readonly onTimeout: () => void) {
    this.expiresAt = performance.now() + milliseconds;
    this.timer = setTimeout(() => {
      onTimeout();
      this.controller.abort(new AuditFailure("Audit deadline", "AUDIT_TIMEOUT",
        `timed out after ${milliseconds}ms.`));
    }, milliseconds);
  }

  async run<T>(
    phase: string,
    milliseconds: number,
    operation: (options: AuditReadOptions) => PromiseLike<T>,
  ): Promise<T> {
    this.controller.signal.throwIfAborted();
    const remaining = this.expiresAt - performance.now();
    if (remaining <= 0) {
      this.onTimeout();
      this.controller.abort(new AuditFailure("Audit deadline", "AUDIT_TIMEOUT", "deadline expired."));
      this.controller.signal.throwIfAborted();
    }
    const controller = new AbortController();
    const abort = () => controller.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener("abort", abort, { once: true });
    // Stripe silently ignores fractional millisecond timeouts; never pass zero.
    const timeout = Math.ceil(Math.min(milliseconds, remaining));
    let rejectAbort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      this.onTimeout();
      controller.abort(new AuditFailure(phase, "AUDIT_TIMEOUT", `timed out after ${timeout}ms.`));
    }, timeout);
    try {
      // Invoke lazily, after checking the deadline and installing cancellation.
      return await Promise.race([
        operation({ signal: controller.signal, timeout, maxNetworkRetries: 0 }),
        interrupted,
      ]);
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  close() {
    clearTimeout(this.timer);
  }
}
