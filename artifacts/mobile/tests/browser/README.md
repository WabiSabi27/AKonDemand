# Legacy payment-return browser coverage

Run from the workspace root:

```sh
pnpm --filter @workspace/mobile exec playwright install chromium
pnpm --filter @workspace/mobile run test:browser:payment-return
```

On Nix, if the downloaded browser cannot find its Linux runtime libraries, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an available wrapped Chromium executable.
On supported Linux CI images, install dependencies with
`pnpm --filter @workspace/mobile exec playwright install --with-deps chromium`.

The command builds the current Expo web app, then runs Chromium against the real
`server/serve-web.js` on an ephemeral loopback port. It needs no running API,
Stripe credentials, signed-in account, or database fixture. Each test starts with
empty browser storage. All API responses are isolated browser mocks; unexpected
requests and every non-GET request are blocked and fail the test. Never replace
these fixtures with an unpaid application's real public status endpoint: even
that GET can reconcile payment state.

Both legacy path spellings (`/mobile/payment-return` and its trailing-slash
variant) go through the real 302 redirect and Expo router. Assertions cover the
raw query, application id in the browser's status request, pending versus approved
persisted status, historical receipts, unpaid cancellation, and a cancellation
link opened after payment has already been recorded. No payment button is clicked.
Error recovery also covers missing ids with empty storage and cancelled returns
whose mocked status is temporarily unavailable. After mock recovery, clicking
**Check application status** reuses the URL id and reflects persisted pending or
approved status without opening Checkout or sending mutations.

Three negative guard cases use only blank loopback recorder pages and synthetic
identifiers. An unknown status id, a checkout POST, and a script from a second
loopback origin must each produce a browser request-aborted event and an entry
in the guard's unexpected-request report, with no request reaching either
recorder. A successful local document request verifies the recorder is reachable.
These cases share the redirect suite's guard and install it before navigation;
they never load the application or contact a payment/status service.

This complements `scripts/check-published-payment-return.cjs`, which checks public
HTTP routing but does not execute JavaScript. It does not replace that published
smoke check or test native downloads or rejected-applicant checkout.

Failure screenshots and traces are stored under the ignored
`generated-artifacts/payment-return-browser/` directory.

## Pull-request and release check

`.github/workflows/payment-return-browser.yml` runs on every pull request,
pushes to `main` or `master`, GitHub release publication, and manual dispatch.
It installs the frozen mobile workspace dependencies with pnpm 10.26.1 and
Node 24, installs Chromium with its Linux dependencies, then invokes the package
command above. That command always rebuilds the current Expo web export before
running all seventeen cases; it does not reuse an old bundle.

The job needs no secrets or deployment configuration. It bakes the reserved
`payment-return.invalid` host into the export, starts only the local static server,
and preserves the suite's fail-closed request interception and synthetic
`ba_browser_*` identifiers. No real payment/status API is contacted. Do not add
real application identifiers, payment credentials, or a running API to this job.

On failure, download `payment-return-browser-failures` from the workflow run.
It retains available traces, screenshots, and test failure details from
`generated-artifacts/payment-return-browser/` for 14 days. To inspect a trace:

```sh
pnpm --filter @workspace/mobile exec playwright show-trace /path/to/trace.zip
```

In GitHub branch protection or a ruleset, require **Legacy payment links
(Chromium)** before merging. The workflow provides the check, but repository
administrators must enable that merge requirement. Release runs verify the
release's source; they do not publish or roll back the app. To gate a release,
merge only checked commits and wait for the main-branch check before publishing.

The separate opt-in `payment-return-monitor.yml` remains unchanged: it checks
published HTTP routing, not execution of the Expo app, and is not a substitute
for this isolated browser regression check.
