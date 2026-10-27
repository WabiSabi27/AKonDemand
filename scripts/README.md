# Historical applicant payment reconciliation

This is a deliberately invoked **read-only** audit, not a webhook replay or a
payment recovery action. It discovers older extra charges even when their events
were already processed before duplicate-charge alerts existed.

```sh
pnpm --filter @workspace/scripts reconcile-applicant-payments --help
pnpm --filter @workspace/scripts reconcile-applicant-payments --mode test
pnpm --filter @workspace/scripts reconcile-applicant-payments --mode test --inspect-payments
```

Use `--mode live` only when the existing Stripe connection is live. The command
checks the connection's actual mode and fails on a mismatch. It does not switch
credentials, provision webhooks, sync Stripe, initialize the API, or touch prices.
It uses the configured database; make sure it contains the applicant receipts for
the Stripe account being examined. Do not assume a development database contains
all production applicants.

The command follows every Checkout Session page (100 per request), for sessions
created through the scan start. It includes only `mode=payment`,
`payment_status=paid` sessions with `metadata.bizAccountId`, grouped by applicant
and application/onboarding fee. Missing `feeType` is treated as the legacy
application fee; unknown fee types are listed separately rather than guessed.
Amounts are actual Stripe `amount_total` in minor units, with their own currency
and test/live mode, never today's configured prices. No currency totals are mixed.

## Reading the JSON

- `preservedReceipt` contains the database's first confirmed receipt, **only**
  when its paid timestamp is set. An unpaid checkout offer is not a receipt.
- `successfulSessions` lists every observed distinct paid session in the group.
  "Paid" is Checkout's historical status, not proof that funds are still retained.
  Report version 2 adds `paymentInspection` to each session (including unsupported
  fee types); the default status is `not_requested` with unknown amounts (`null`).
- `additionalSessions` lists paid IDs different from the preserved receipt's ID.
  When there is no preserved ID, all candidates remain in `successfulSessions`;
  the report does not choose a replacement receipt.
- `issues` flags multiple payments, missing receipts/applicants, unmatched saved
  IDs, and known amount/currency mismatches.
- `summary.groupsWithMultipleSuccessfulSessions` counts groups with at least two
  distinct paid sessions in the scanned mode. A single session different from a
  saved ID is separately flagged, not asserted to be a confirmed duplicate.
- A saved receipt's mode is `null` unless its session was found in this scan.
  Its absence may indicate another Stripe mode/account or incomplete local data.
  Historical unknown amounts/currencies remain `null`.

No report is printed until all Checkout pages and database pool shutdown succeed. Errors exit nonzero and go to
stderr. The database query runs in a read-only transaction and selects only
receipt fields and account IDs, not names, emails, passwords, or contact details.

### Database deadlines

The audit bounds connection acquisition and the entire receipt snapshot
(including transaction begin, read-only setup, SELECT, and commit) separately at
30 seconds each. Pool shutdown has a separate 5-second deadline, including after
an earlier failure. For slower audit environments, set `AUDIT_DATABASE_TIMEOUT_MS`
and/or `AUDIT_SHUTDOWN_TIMEOUT_MS` to positive integer milliseconds (maximum
2147483647). Invalid values fail before any external reads.

These settings apply only inside the deliberately invoked CLI; they do not alter
the API server's pool configuration or webhook startup. Pending physical database
connections also receive the driver's connection timeout. Late connections are
discarded, and a failed or timed-out receipt transaction destroys its connection
to cancel pending queries and roll back the read-only snapshot. A transaction-local
PostgreSQL statement timeout also bounds server-side waits that might not notice
a disconnected socket immediately. The same statement timeout is passed at
connection startup to protect begin/read-only setup too. Deadline timers
are cleared when operations settle. Cleanup is always attempted with its own
deadline. If a driver still holds resources after a timeout, the CLI flushes its
failure to stderr and exits nonzero itself. No JSON is emitted, even when the
report was complete before shutdown stalled. A saved empty output file is not
a successful report. These deadlines do not limit the duration of a Stripe scan.

Treat the output as sensitive financial information. To save it locally:

```sh
mkdir -p generated-artifacts
pnpm --silent --filter @workspace/scripts reconcile-applicant-payments --mode test \
  > generated-artifacts/applicant-payments-test.json
```

Check the exit status before using a saved file. Keep reports out of version
control and distribution. Run test and live audits separately; neither report
claims cross-mode/account completeness. Database receipts are a snapshot before
the scan, and Stripe pagination is not atomic: rerun after concurrent payments
settle when investigating discrepancies.

## Optional refund and dispute inspection

`--inspect-payments` retrieves each attributed paid session's PaymentIntent, then
all charges and disputes filtered by that intent, and all refund requests filtered
by each validated charge, 100 per page. This includes
preserved sessions, additional sessions, sessions without saved receipts, and
unsupported fee types. The default scan makes no such calls.

**API cost:** beyond the existing balance read and Checkout page reads, expect one
PaymentIntent read plus at least one charge-list and one dispute-list read per
distinct PaymentIntent and mode, plus at least one refund-list read per inspected
charge (normally 4 extra requests for one charge). Each additional charge/dispute/refund
page costs another request. Multiple charges each require their own refund-list
read. Sessions sharing an intent reuse its
first inspection within that scan, even across fee/account groups and Checkout
pages. SDK retries may add requests. Reads run sequentially, so large histories take longer and consume
Stripe rate limits. No live requests are made by the synthetic report tests.

- `paymentInspection.status`: `complete`, `unknown` (missing/inconsistent data),
  `unavailable` (a read or pagination failed), or `not_requested`.
- `refunds` reports captured and refunded minor-unit amounts in their own currency,
  per-charge IDs/amounts, and `none`, `partial`, or `full` when known. Unknown or
  unavailable totals are `null`, never an inferred zero. Amounts use Stripe's
  `Charge.amount_refunded` only; pending, failed, canceled, or action-required
  requests do not increase successful refunded totals.
- `refundRequests` separately reports `none` or `found` after all charge-specific
  pages succeed. Each item contains `refundId`, `chargeId`, raw Stripe `status`
  (`succeeded`, `pending`, `requires_action`, `failed`, or `canceled`), `amountCents`,
  and `currency`. Succeeded requests are listed for context but are not added again
  to `refunds.amountRefundedCents`. Do not sum all request amounts as refunded money:
  a pending/action-required request may still finish, and failed/canceled requests
  are not successful refunds. Investigate existing requests before requesting another.
  `unknown`, `unavailable`, and `not_requested` are not evidence of no requests.
  Invalid charge data prevents refund-list reads and leaves request status unknown.
- `disputes` independently reports `none` or `found`, with dispute IDs, charge IDs,
  raw Stripe statuses (including closed/won/lost), amounts, and currencies.
  A dispute is not a refund; do not subtract dispute amounts from refund totals.
- Partial inspection failures retain independently known refund/dispute evidence,
  including settled totals when a refund-list read fails. Request items from
  successfully inspected charges may remain, but a failed later refund page
  discards that charge's partial list and makes request status `unavailable`.
  but the overall inspection is not complete. Raw Stripe errors are not printed.
  An unavailable inspection does not abort the otherwise complete Checkout report;
  consumers must check each inspection status before drawing financial conclusions.
- The scan is not atomic: refunds/disputes may change during or after inspection.
  Missing intent IDs, unmatched charges, and inconsistent data remain unknown.
- Reuse is scan-local and bound to the selected Stripe account/reader, keyed by
  PaymentIntent ID and mode. Unknown and unavailable results are retained too:
  another session does not trigger an implicit retry or replace partial evidence.
  A new report run starts fresh and retries all reads (normal SDK retries still
  apply within a read). Reused evidence is the first observation, not an
  independent or scan-start snapshot. Every session keeps its own detached
  evidence, amounts, attribution, and manual-review findings.

**Investigate in Stripe before taking action, even after inspection.** Full
refunds and won disputes do not clear issues or remove candidates from manual
review. Inspection cannot establish whether a payment was appropriate. The report
does not update receipts, applicant status, alerts, products, or prices, activate
accounts, or issue refunds.

Tests:

```sh
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts typecheck
```

The report-only tests use synthetic data without Stripe or database calls.
The CLI integration tests require Node 24 and the configured **development**
database. They run the actual command in child processes, replace Stripe with
synthetic responses, and block real Stripe, API-startup, and HTTP imports/calls.

Each integration case creates and removes its own randomly named database schema.
Its connection searches only that schema, with no fallback to application tables.
These are disposable persistent tables, not PostgreSQL temporary tables:
PostgreSQL permits writes to temporary tables even inside a read-only transaction.
The tests verify receipt-only selection, PostgreSQL write rejection, unchanged
fixture receipts, pool closure, and empty stdout on database, pagination, or
shutdown failure. They never reconcile actual applicant records.
Stall cases include connection acquisition (including a late connection), begin,
read-only setup, receipt query, commit, and pool shutdown, plus a query timeout
followed by a shutdown timeout. Query stalls use server-side waits on disposable
connections; shutdown stalls retain a child-process handle. Tests require the CLI
to cancel/close resources and exit itself before the parent's safety timeout,
preserve fixture receipts, and leave stdout empty. No real Stripe calls are made.

To run only the database-free report tests:

```sh
pnpm --filter @workspace/scripts exec tsx --test src/applicantPaymentReport.test.ts src/applicantPaymentInspection.test.ts
```
