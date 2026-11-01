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
running all fourteen cases; it does not reuse an old bundle.

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

### Supported CI run

`.github/workflows/landing-page-browser.yml` runs on pull requests, pushes to
`main`/`master`, and manual dispatch. It uses Ubuntu 24.04 with a separate job for
each engine and installs that engine with `playwright install --with-deps`.
Every job sets `LANDING_PAGE_REQUIRE_ALL_BROWSERS=1` and invokes the documented
command with its project selected:

```sh
LANDING_PAGE_REQUIRE_ALL_BROWSERS=1 pnpm --filter @workspace/mobile run test:browser:landing-page --project=firefox
```

Missing engines or host libraries fail CI rather than skipping. An engine
failure does not cancel the other jobs. Available screenshots and retained
failure traces are uploaded as `landing-page-browser-chromium`,
`landing-page-browser-firefox`, and `landing-page-browser-webkit` for 14 days,
including when the suite fails. Launch failures before a page exists may have
no screenshot or trace; inspect the job log in that case.

This workflow uses the existing isolated QR fixtures, intercepted store/Expo
navigation, and fail-closed network routing. It needs no application server,
Expo export, live API, payment credentials, or deployment access. The separate
payment-return workflow is unchanged.

Before merging, confirm all three **Download instructions (chromium)**,
**Download instructions (firefox)**, and **Download instructions (webkit)**
checks passed for the exact commit under review, without skipped cases. A local
run that skips Firefox/WebKit is not equivalent. Repository administrators can
require these three checks in branch protection or a ruleset; adding this file
alone does not configure that policy. A prepared workflow is not evidence of a
successful CI run.
