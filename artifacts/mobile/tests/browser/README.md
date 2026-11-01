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

## Download-instructions browser coverage

```sh
pnpm --filter @workspace/mobile exec playwright install chromium firefox webkit
pnpm --filter @workspace/mobile run test:browser:landing-page
```

On supported Linux images, use `playwright install --with-deps chromium firefox
webkit` to install the runtime libraries too. The landing-page config defines
separate Chromium, Firefox, and WebKit projects. WebKit tests the engine used by
Safari, not Safari itself or a physical iPhone. Phone user-agent overrides test
platform detection; they do not substitute for the selected browser engine.

All three engines run the same narrow-iPhone, Android-width, and desktop matrix
in light/dark mode with QR rendering available/unavailable. Each case checks
instructions restored after the intercepted mobile opening attempt, containment,
store preference, QR fallback, and pointer/keyboard link activation. QR scripts
are local stubs; link activation and Expo navigation are intercepted. Unexpected
network requests are blocked and fail the test. No server, real store, CDN, or
external protocol handler is needed.

Focused 200% text-only cases keep the viewport at 320px for both iPhone and
Android store preferences, and at the 768px two-column breakpoint. They double
computed font sizes (including the template's explicit pixel sizes), not page
zoom or box dimensions, in both color modes and QR states. Checks include text
and vertical containment, separation of the fallback message from the open
button, scrolling to each link, and pointer/keyboard activation under the same
fail-closed stubs.

Chromium is required. An absent bundled Firefox/WebKit executable or Playwright's
specific missing-host-dependencies diagnostic produces explicit skips, not
successful browser coverage. Other launch errors and all test failures fail
rather than silently skipping. Set `LANDING_PAGE_REQUIRE_ALL_BROWSERS=1`
to require every engine (recommended for browser-equipped CI). Use
`--project=firefox` or `--project=webkit` to run one engine. Explicit executable
overrides are supported via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`,
`PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH`, and `PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH`;
overrides must be compatible with the installed Playwright version and never
skip when invalid. Stock Firefox is not a substitute for Playwright's patched
Firefox runtime.

The availability/skip policy also has browser-free regression coverage:

```sh
pnpm --filter @workspace/mobile exec node --test server/landing-page-browser-availability.test.cjs
```

These tests execute the actual spec's registered hook with isolated browser
doubles, including failure propagation and probe cleanup. They also run with
`test:server` (and `test`); they do not establish real cross-engine coverage.

Screenshots and failure traces go under the ignored
`generated-artifacts/landing-page-browser/` directory, separated by project.

### Supported CI run

`.github/workflows/landing-page-browser.yml` runs on pull requests, pushes to
`main`/`master`, and manual dispatch. It uses Ubuntu 24.04 with a separate job for
each engine and installs that engine with `playwright install --with-deps`.
The Chromium job also runs the browser-free availability-policy tests once,
before installing its browser. This does not replace the three real-engine runs.
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
