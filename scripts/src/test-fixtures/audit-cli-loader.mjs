import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

if (process.env.NODE_ENV !== "test" || !process.env.AUDIT_FIXTURE_TRACE) {
  throw new Error("Audit loader is for isolated tests only");
}
const cli = new URL("../reconcile-applicant-payments.ts", import.meta.url).pathname;
const record = (event) => appendFileSync(
  process.env.AUDIT_FIXTURE_TRACE, `${JSON.stringify({ event })}\n`,
);

// Exercise the actual CLI entrypoint while replacing only its two external
// boundaries. Never load the real Stripe client, credentials, or API startup.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromCli = context.parentURL && new URL(context.parentURL).pathname === cli;
    if (fromCli && specifier === "./stripeClient") {
      return { url: new URL("./audit-stripe.ts", import.meta.url).href, shortCircuit: true };
    }
    if (fromCli && specifier === "@workspace/db") {
      return { url: new URL("./audit-database.ts", import.meta.url).href, shortCircuit: true };
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
