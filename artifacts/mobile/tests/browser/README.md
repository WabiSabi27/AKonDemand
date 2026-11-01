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

## Exported API origin regression

```sh
pnpm --filter @workspace/mobile run test:browser:api-origin
```

This command always exports once through `scripts/build-web.js` with the reserved
`obsolete-preview.invalid` build-time domain. It starts two loopback instances of
the actual `server/serve-web.js`, then loads the **same unchanged export** in
fresh browser contexts on both origins. It checks the generated categories,
services, and businesses requests and checkout's legacy `apiGet` /
`getLegacyApiBase` / `API_BASE` chain. The legacy payment-config request gets a
synthetic error; Stripe is never initialized and no API server is needed.

All traffic is intercepted before navigation. Only the current origin's static
assets and exact fixture endpoints are allowed; obsolete-host, cross-preview,
unexpected API, and mutation requests are aborted and fail assertions.
Bundle response hashes are checked against the original export, and the whole
export is fingerprinted before and after reuse. Existing resolver unit tests
continue to cover the separate injected native and Metro-development addresses.

The same suite also runs six negative controls through the shared
`api-origin-request-guard.cjs`: the three generated-list paths and legacy
payment-config path aimed at a different loopback recorder, plus POSTs to the
current origin's list and payment-config paths. Interception is installed
before navigation. Each case requires a failed browser request, an exact
blocked-request report, no substituted fixture response, and zero delivery of
the blocked request to either recorder. The other recorder is first probed to
prove it is reachable and allows cross-origin responses; CORS or an unavailable
server cannot substitute for the guard. These controls need no live services
and reuse the suite's single export rather than building again per case.

Chromium must be installed; launch failures are failures, not skips. On Nix,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an available wrapped Chromium.
Failure screenshots and traces go to the ignored
`generated-artifacts/api-origin-browser/` directory. This test replaces the
local `web-dist/` with its fixture build; restart the web preview afterward if
you need a refreshed development export. Do not run export-building browser
suites concurrently against that directory.

### GitHub Actions

`.github/workflows/api-origin-browser.yml` runs this regression on pull requests,
pushes to `main` / `master`, and manual dispatch. Its stable check name is
**Exported API origins (Chromium)**. There are no path filters, so a required
check is not left waiting because a change falls outside a filter.

The job uses a fresh Ubuntu runner and checkout, installs locked mobile
dependencies and Chromium's Linux dependencies, then invokes
`test:browser:api-origin` once. The spec owns the single export; there is no
separate build step and no other export-building suite in this job. Other
workflow jobs use separate checkouts and do not share its `web-dist/`.
All API responses remain local fixtures, and no database, payment credentials,
running API server, or deployment URL is required.

On failure, the `api-origin-browser-failures` artifact retains screenshots and
traces from `generated-artifacts/api-origin-browser/` for 14 days. A missing
browser or failed export fails the check rather than skipping it.

To block merging, a repository administrator must separately require
**Exported API origins (Chromium)** in the applicable GitHub ruleset or branch
protection after the check has run. Adding this workflow does not modify those
settings. It does not replace the existing **Legacy payment links (Chromium)**
check and never merges, publishes, or changes the live site.
