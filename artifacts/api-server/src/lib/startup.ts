type StartupStep<T = unknown> = {
  name: string;
  run: () => Promise<T>;
  timeoutMs?: number;
};
type StartupLogger = {
  info: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

// Only application-owned diagnostics are allowed into fatal startup output.
// In particular, never attach the original Error: its cause/stack may contain
// connector credentials, SQL parameters, or enormous bundled source lines.
export class StartupFailure extends Error {
  constructor(
    readonly step: string,
    readonly errorName: string,
    readonly errorCode?: string,
    readonly diagnostic?: string,
  ) {
    super(`API startup failed at ${step}${diagnostic ? `: ${diagnostic}` : ""}`);
    this.name = "StartupFailure";
  }

  toLogContext(): Record<string, string | undefined> {
    return {
      step: this.step,
      errorName: this.errorName,
      errorCode: this.errorCode,
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }
}

function startupFailure(step: string, error: unknown): StartupFailure {
  if (error instanceof StartupFailure) return error;
  const outer = error instanceof Error ? error : new Error("Unknown startup error");
  const cause = outer.cause instanceof Error ? outer.cause : outer;
  const rawCode = "code" in cause ? cause.code : undefined;
  const code = typeof rawCode === "string" &&
    /^(?:[0-9A-Z]{5}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EACCES|ENOENT|ECONNRESET|ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED)$/.test(rawCode)
    ? rawCode : undefined;
  const errorName = /^(?:Error|TypeError|SyntaxError|AbortError|TimeoutError)$/.test(cause.name)
    ? cause.name : "Error";
  let diagnostic: string | undefined;
  if (/^(Stripe connector lookup failed: \d{3} [A-Za-z ]{0,64}|Expected one configured Stripe connection; found \d{1,3}|Stripe connection lookup returned an incomplete collection|Configured Stripe connection credentials are missing)$/.test(cause.message)) {
    diagnostic = cause.message;
  } else if (/^(Stripe test keys are missing from production secrets|Stripe production configuration requires test keys; live keys are forbidden|Original Stripe test account identity is not configured|Stripe test account verification is unavailable|Stripe test account verification failed: HTTP \d{3}|Stripe test account verification returned an invalid response|Stripe test keys do not match the original sandbox account)$/.test(cause.message)) {
    diagnostic = cause.message;
  } else if (cause.message === "Stripe webhook callback URL is invalid" ||
      /^Stripe webhook unavailable: (local callback or signing secret is not usable|existing endpoint does not match this callback or is disabled|endpoint inventory is incomplete; registration was not attempted|callback already exists but its signing secret is not available locally|sandbox webhook capacity is full; no existing endpoints were changed)$/.test(cause.message)) {
    diagnostic = cause.message;
  } else if (cause.message.startsWith("Replit identity token not found.")) {
    diagnostic = "Replit runtime identity is unavailable";
  } else if (cause.name === "TimeoutError") {
    diagnostic = "Startup operation timed out";
  }
  return new StartupFailure(step, errorName, code, diagnostic);
}

export async function runStartupStep<T>(
  step: StartupStep<T>,
  log: StartupLogger,
): Promise<T> {
  const started = Date.now();
  log.info({ step: step.name }, "Startup step starting");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = step.run();
    const result = step.timeoutMs === undefined ? await operation : await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Startup operation timed out");
          error.name = "TimeoutError";
          reject(error);
        }, step.timeoutMs);
      }),
    ]);
    log.info({ step: step.name, elapsedMs: Date.now() - started }, "Startup step complete");
    return result;
  } catch (error) {
    const failure = startupFailure(step.name, error);
    log.error(failure.toLogContext(), "API startup failed");
    throw failure;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Keep entry-point failures out of Node's default uncaught-exception printer.
// A single bounded fatal record remains usable even when source-map/bundle
// stack output would overwhelm deployment log ingestion.
export async function startOrExit(
  start: () => Promise<void>,
  log: StartupLogger & { fatal: (context: object, message: string) => void; flush: () => void },
  exit: (code: number) => never,
): Promise<void> {
  try {
    await start();
  } catch (error) {
    const failure = startupFailure("api-startup", error);
    log.fatal(failure.toLogContext(), failure.message);
    log.flush();
    exit(1);
  }
}

export async function runStartup(
  environment: string | undefined,
  schemaSteps: StartupStep[],
  stripeStep: StartupStep,
  log: StartupLogger,
): Promise<void> {
  // Publish applies the managed production schema. Do not run application DDL
  // again in the serving process; development retains its existing bootstrap.
  const steps = environment === "production" ? [stripeStep] : [...schemaSteps, stripeStep];
  if (environment === "production") {
    log.info({}, "Using application schema managed by Publish");
  }
  for (const step of steps) {
    await runStartupStep(step, log);
  }
}
