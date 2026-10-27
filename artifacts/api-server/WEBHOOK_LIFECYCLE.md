# Shared Stripe sandbox webhook policy

Startup never calls `findOrCreateManagedWebhook`: its cleanup treats a fork's
database as the account-wide inventory and can delete production/other previews.
Registration never deletes, disables, repoints, or retags existing endpoints.
The original account selection and historical payment data are unchanged.

Development defaults to **reuse-only**. It verifies the stored endpoint against
Stripe (exact callback URL, enabled, test mode, local signing secret). A fork
with a new address starts without allocating a sandbox slot and logs a warning:
automatic payment callbacks are unavailable in that preview. This is not proof
that webhook-based payments/subscriptions work there.

To intentionally provision a preview for payment testing, set the development
environment variable `STRIPE_PREVIEW_WEBHOOK_CREATE=true`, then restart the API.
This permits creation only, not cleanup. Remove the opt-in after provisioning.
Repeated boots reuse the endpoint. At the 16 test-endpoint limit startup warns
and continues without a callback; unrelated Stripe/credential/storage failures
still fail startup. Production ignores preview settings and requires a verified
existing endpoint or successful non-destructive creation; capacity errors remain
fatal and have a safe diagnostic.

An endpoint whose secret is missing locally cannot be recovered by a Stripe
retrieve request. Restore the correct environment's secret storage rather than
creating a duplicate or borrowing another preview's endpoint. A copied row for
another URL is never grounds for removing a local or remote endpoint.

If the exact current URL/account's locally stored endpoint returns a confirmed
404/resource_missing from Stripe, creation may supersede only that stale local
cache row. The remote inventory is checked first, and the row is removed through
the sync persistence API under the callback lock before saving a replacement.
This avoids its unique `(url, account_id)` constraint blocking the new ID.
Reuse-only previews keep the stale row; other URLs/accounts and payment/history
records are untouched. A replacement uses the absent endpoint ID in its
idempotency key so Stripe cannot replay the deleted endpoint's creation response.

## Cleanup approval policy

There is deliberately no automated cleanup or endpoint replacement path.
Freeing capacity is a separate, explicitly approved operator action:

1. Identify the original Stripe account, exact endpoint ID and callback URL.
2. Establish development ownership with both `managed_by: akodd-development`
   metadata and the owner's confirmation that the preview is retired.
   Age, reachability, description, or absence from a fork's DB are NOT proof.
3. Exclude production URLs/endpoints (including test-mode production), enabled
   current previews, unknown ownership, and any live-mode endpoint.
4. Obtain approval naming each endpoint and explaining that its old preview
   will stop receiving events. Approval for one endpoint never covers another.
5. Remove only approved endpoints through the Stripe dashboard; never delete
   payment/customer/history records or change accounts to bypass the quota.

Run isolated checks without database setup or Stripe access:
`pnpm --filter @workspace/api-server run test:transport`.
