import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { credentialError, privateDiagnostics } from "./audit-errors.ts";

if (process.env.NODE_ENV !== "test" || !process.env.AUDIT_FIXTURE_TRACE) {
  throw new Error("Audit loader is for isolated tests only");
}
const cli = new URL("../reconcile-applicant-payments.ts", import.meta.url).pathname;
const record = (event, details = {}) => appendFileSync(
  process.env.AUDIT_FIXTURE_TRACE, `${JSON.stringify({ event, ...details })}\n`,
);

function databaseImportFailure(fixtureCase) {
  const error = credentialError(privateDiagnostics.join("\n"));
  switch (fixtureCase) {
    case "db-import-known-code":
      return credentialError("28P01");
    case "db-import-wrapped-code":
      return new Error(privateDiagnostics.join(" "), { cause: credentialError("ECONNREFUSED") });
    case "db-import-unknown-code":
      return error;
    case "db-import-non-error":
      return privateDiagnostics.join(" ");
    case "db-import-cyclic-cause": {
      const cause = credentialError(privateDiagnostics.join("\n"));
      error.cause = cause;
      cause.cause = error;
      return error;
    }
    case "db-import-throwing-code":
    case "db-import-throwing-cause":
      Object.defineProperty(error, fixtureCase.endsWith("code") ? "code" : "cause", {
        get() {
          record("diagnostic-getter");
          throw credentialError(privateDiagnostics.join("\n"));
        },
      });
      return error;
    case "db-import-throwing-diagnostics":
      error.code = "28P01";
      for (const property of ["message", "stack", "detail", "parameters"]) {
        Object.defineProperty(error, property, {
          get() {
            record("private-diagnostic-getter");
            throw credentialError(privateDiagnostics.join("\n"));
          },
        });
      }
      return error;
    default:
      throw new Error("Unknown isolated database import fixture");
  }
}

// Exercise the actual CLI entrypoint while replacing only its two external
// boundaries. Never load the real Stripe client, credentials, or API startup.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromCli = context.parentURL && new URL(context.parentURL).pathname === cli;
    if (fromCli && specifier === "./stripeClient") {
      return { url: new URL("./audit-stripe.ts", import.meta.url).href, shortCircuit: true };
    }
    if (fromCli && specifier === "@workspace/db") {
      if (process.env.AUDIT_FIXTURE_CASE?.startsWith("db-import-")) {
        record("database-import-rejected");
        throw databaseImportFailure(process.env.AUDIT_FIXTURE_CASE);
      }
      return { url: new URL("./audit-database.ts", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "@workspace/db" && process.env.AUDIT_FIXTURE_CASE?.startsWith("db-import-")) {
      record("forbidden-import");
      throw new Error("Real database imports are forbidden in database import failure tests");
    }
    if (specifier === "stripe" || specifier.includes("stripe-replit-sync") ||
        /stripeClient(?:\.[cm]?[jt]s)?$/.test(specifier)) {
      record("forbidden-import");
      throw new Error("Real Stripe imports are forbidden in audit integration tests");
    }
    const result = nextResolve(specifier, context);
    if (result.url.includes("/artifacts/api-server/")) {
      record("forbidden-import");
      throw new Error("API startup imports are forbidden in audit integration tests");
    }
    return result;
  },
});

globalThis.fetch = async () => {
  record("forbidden-fetch");
  throw new Error("External HTTP is forbidden in audit integration tests");
};
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => {
  record("stdout-write");
  return write(...args);
};

if (process.env.AUDIT_FIXTURE_STDERR_BACKPRESSURE === "true") {
  if (process.env.AUDIT_FIXTURE_CASE !== "db-read-stall") {
    throw new Error("Blocked stderr requires the disposable interruption fixture");
  }
  const writeError = process.stderr.write.bind(process.stderr);
  // Exceed the pipe and parent-readable buffer capacity with bounded synthetic
  // data. The parent deliberately does not consume stderr before child exit.
  const accepted = writeError(Buffer.alloc(2 * 1024 * 1024, "x"), () => {
    record("stderr-prefill-flushed");
  });
  if (accepted) throw new Error("Fixture did not backpressure stderr");
  record("stderr-backpressured");
  process.stderr.write = (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("Reconciliation failed:")) {
      record("stderr-failure-queued", {
        text: args[0], pendingBytes: process.stderr.writableLength,
      });
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback !== "function") throw new Error("Expected a failure-write callback");
      args[last] = (...result) => {
        record("stderr-failure-flushed");
        callback(...result);
      };
    }
    return writeError(...args);
  };
}
