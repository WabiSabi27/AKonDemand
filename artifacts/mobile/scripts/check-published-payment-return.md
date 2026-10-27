# Published legacy payment-return check

## Opt-in automatic release and scheduled monitoring

`.github/workflows/payment-return-monitor.yml` is the automatic runner. Once
enabled in a connected GitHub repository, it runs every six hours, on GitHub
release publication, and on manual workflow dispatch. A GitHub release event is
not a Replit publishing event; the six-hour schedule catches changes after
Replit publishes even when no GitHub release is created. The job does not publish
the app. Neither this workflow nor the checker is part of app build or startup.

The workflow invokes `scripts/run-published-payment-monitor.cjs`, which obtains
**fresh deployment metadata on every run** from the documented Replit Admin API
`GET https://api.replit.com/v1/deployments`, filtered to the configured workspace
and project, ordered newest first with `limit=1`. It does not filter out failed
builds to find a historical success. It validates the returned workspace/project,
current serving status, public privacy, and primary routable `url` before passing
a fresh normalized snapshot to the route checker. There is no configured-origin
fallback, payment fixture, reconciliation, or payment API access.

### Enable it explicitly

This integration requires a connected GitHub repository with Actions enabled
and Replit **Enterprise Admin API** access. An Enterprise account admin can
generate a key in Replit account Settings → Developer with read access (`read:*`).
The Admin API does not expose personal-workspace projects; confirm this project
is in the account workspace first. Do not guess an undocumented endpoint or
grant publishing/write scopes.

In the connected repository's **Settings → Secrets and variables → Actions**:

1. Add `REPLIT_MONITOR_API_KEY` as a repository **secret**, never a variable or
   workflow input. Do not paste the value into chat or commit it.
2. Set repository variables `REPLIT_MONITOR_WORKSPACE_ID` and
   `REPLIT_MONITOR_PROJECT_ID` to the account-owned workspace and this project's
   IDs obtained from the Admin API/project metadata. These are not application
   capability ids. No public origin is stored in configuration.
3. Set repository variable `PAYMENT_RETURN_MONITOR_ENABLED` to exactly `true`.
   Without this variable the automatic job is skipped and makes no requests.
4. Dispatch **Published payment-return monitor** once to verify access and routing.
   Keep the workflow on the repository's default branch for scheduled runs.
5. Configure the responsible operator's GitHub Actions failure notifications
   (email or web) for this repository. The workflow emits a failed job, a safe
   error annotation, and a failure summary; delivery depends on those notification
   settings. It does not silently send emails via the app's SMTP account.

The workflow serializes its runs and has a six-minute job deadline. The runner
makes exactly one Admin API read with a 30-second deadline, no pagination, and
no retries; rate-limit/auth/missing-build failures fail the job and notify just
like route failures. Use a dedicated monitoring credential and coordinate other
clients for the same account through the account's request scheduler if sharing
an API budget. This job never fans out or automatically retries a `429`.
API credentials are supplied only to the metadata request, never forwarded to
the public origin. Failure output and notifications contain no API key, URLs,
capability ids, or response bodies.

To disable, remove/set `PAYMENT_RETURN_MONITOR_ENABLED` to `false`. The workflow
and runner both check this opt-in. The runner can also be used by another
scheduler via `node artifacts/mobile/scripts/run-published-payment-monitor.cjs`
with the same securely configured environment; it exits `1` on any failure so
that scheduler must alert on nonzero exit.

No repository connection, credential, schedule activation, notification
subscription, or deployment is created automatically by adding this code.
If the Admin API prerequisite is unavailable, the automatic integration is not
enabled: use the supervised metadata-based check below and report that scheduled
coverage remains disabled, rather than claiming automatic monitoring is active.

## Supervised post-release check

After a release has finished successfully, explicitly run this check. It is **not**
part of the build, startup, or publishing commands and never publishes anything.
It exits `0` only when all four HTTP routing checks pass; any configuration,
network, timeout, query, redirect, or HTML failure exits `1`. A release runner
should treat a nonzero exit as a failed monitoring step and notify its operator,
not retry a payment or automatically republish.

Retrieve fresh deployment metadata with the deployment tooling's
`getDeploymentInfo()` callback. Do not infer an origin from `REPLIT_DEV_DOMAIN`,
`REPLIT_DOMAINS`, preview artifact paths, this document's historical result, or
a saved URL. The callback is available to the workspace agent, **not** as a
Node.js import or shell command.

An agent can opt into a complete post-release run with this recipe (from the
workspace root, using its tool-calling runtime):

```javascript
const deployment = await getDeploymentInfo();
await writeFile({
  path: "/tmp/payment-return-deployment.json",
  content: JSON.stringify({ retrievedAt: new Date().toISOString(), deployment }),
});
const result = await shellExec({
  command: "pnpm --filter @workspace/mobile run check:published-payment-return --deployment-metadata /tmp/payment-return-deployment.json",
});
console.log(result.output);
if (result.exitCode !== 0) throw new Error("Published payment-return monitoring failed");
```

Equivalently, once that metadata snapshot has been obtained, run from
`artifacts/mobile`:

```sh
node scripts/check-published-payment-return.cjs --deployment-metadata /tmp/payment-return-deployment.json
```

The snapshot must contain `{ "retrievedAt": "<ISO timestamp>", "deployment":
<unaltered getDeploymentInfo() result> }`. It expires after 15 minutes and must
describe an active successful **public** deployment with an HTTPS `primaryUrl`.
Unavailable metadata, private/password-protected deployments, preview/local
origins, and stale snapshots fail closed before any HTTP requests. Fetch metadata
anew for each run. Do not cache a snapshot as scheduled-job configuration.

This lower-level CLI does not install a schedule. Use the automatic workflow
above for recurring checks, or explicitly invoke this supervised command after
publishing. Both paths validate fresh deployment metadata rather than using a
saved origin or development domain.

### What a pass means

The CLI always prints `PASS HTTP ROUTING` per variant followed by
`ROUTES ONLY: paid-application verification NOT RUN`. It uses a synthetic,
non-capability id and **never calls any application status or payment API**.
It makes at most eight GET requests, follows redirects manually, and has a
30-second timeout per request (up to four minutes total). No automatic retries.
There are no Checkout sessions, charges, reconciliation calls, database writes,
or payment mutations.

Only safe fixed failure messages are logged: no full URLs, response payloads,
raw exception details, or capability ids. Do not enable HTTP debug logging or
log the monitor's inputs in a surrounding runner.

## Optional separately supervised paid-fixture verification

Paid verification is deliberately unavailable in the automated CLI. A route-only
pass is **not** proof that payment succeeded, or that client-side screens render.
The exported `checkPublishedPaymentReturn` function remains available for a
supervised check using `paidApplicationId` and `confirmedPaidSandbox: true`.
Obtain its `origin` using the same fresh deployment metadata validation above.
The confirmation flag is an operator attestation, not a lookup or a sandbox-mode
detector: independently establish that the fixture is already paid in that
deployment and has a test-mode Stripe session **before the first request**.

Only supply an application previously confirmed paid in the sandbox. Do not use
an unpaid or unknown application: the public status endpoint can reconcile an
`awaiting_payment` application. Do not create a checkout or edit payment records
to obtain a fixture. Application ids are capability tokens; do not commit them
or full status responses, put them in command-line arguments, or log exceptions
from a surrounding HTTP client. If safe independent confirmation is unavailable,
omit paid verification; report route-only coverage instead. Never set the
confirmation flag just to bypass the guard. The supervised check reads the paid
status before/after and requires the status, timestamp, and receipts to remain
unchanged; it is not a replacement for the independent paid-fixture confirmation.

Success and cancellation links, with and without a trailing slash, must return
exactly one 302 redirect to the root `/payment-return` and then HTTP 200 HTML.
The raw query must survive unchanged, including duplicate keys, encoded values,
plus signs, empty values, and bare flags. Redirects are followed manually so a
second redirect cannot silently pass.

These HTTP checks verify public routing and persisted payment status, not
client-side rendering. A 404 on the old path means the compatibility redirect
is not available on that release; local tests alone do not establish a public pass.

## Published verification — 2026-10-23

Deployment metadata confirmed the public origin as
`https://service-marketplace-AKonDemand.replit.app` with a successful active build.
The full smoke check passed against that origin using an existing application
confirmed by a read-only production lookup to have a recorded payment and a
test-mode Stripe session:

- Success and cancellation links, both with and without a trailing slash:
  exactly one `302` to `/payment-return`, followed by `200` HTML.
- The exact raw query survived, including application id, outcome, session,
  duplicate keys, encoded values, plus signs, empty values, and a bare flag.
- The public status endpoint confirmed the existing payment before and after.
  Application status, payment timestamp, and both payment receipts were unchanged.
- No checkout was created, no charge was made, and no payment records were edited.

The application id and full status responses are intentionally omitted because
the id grants access to its public status. This is evidence for the checked
release, not a guarantee about future releases; rerun the check after publishing.
