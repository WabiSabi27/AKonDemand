import { Router, type IRouter } from 'express';
import { getStripePublishableKey } from '../stripeClient';

const router: IRouter = Router();

/**
 * Returns the Stripe publishable key for the mobile `StripeProvider`. Safe to
 * expose to clients. The previous routes on this file (`/plans`, `/subscribe`,
 * `/payment-intent`, `/application-fee`, `/session-status/:id`,
 * `/subscription/:userId`) were Phase 1/2 prototypes that have been fully
 * superseded — see `routes/meSubscription.ts`, `routes/bookingsPayments.ts`,
 * and `routes/bizAccounts.ts` — and were removed when no first-party client
 * called them anymore.
 */
router.get('/config', async (_req, res) => {
  try {
    const publishableKey = await getStripePublishableKey();
    res.json({ publishableKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
