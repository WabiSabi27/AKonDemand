import { getUncachableStripeClient } from './stripeClient';

/**
 * Seeds ServiceHub's Stripe catalog:
 *   - Two recurring subscription products (Starter Gigger $29, Pro Business $79).
 *   - Two one-time onboarding fees (Application $19, Onboarding $60).
 *
 * Source of truth for these values is artifacts/api-server/src/lib/plans.ts.
 * `scripts` cannot import from an artifact (workspace rule), so the numbers are
 * duplicated here intentionally — keep them in sync with plans.ts.
 *
 * Old tiers (basic/pro/premium) are archived so they disappear from the
 * customer portal. Safe pre-launch: there are no live subscribers on them.
 */

const SUBSCRIPTION_PLANS = [
  {
    name: 'Starter Gigger',
    description: 'List up to 5 services with a 3-month booking window. 9% commission per booking.',
    price: 2900, // $29/mo
    metadata: {
      plan_tier: 'starter_gigger',
      max_services: '5',
      commission_bps: '900',
      booking_horizon_months: '3',
    },
  },
  {
    name: 'Pro Business',
    description: 'List up to 20 services with a 6-month booking window. Lower 6.5% commission per booking.',
    price: 7900, // $79/mo
    metadata: {
      plan_tier: 'pro_business',
      max_services: '20',
      commission_bps: '650',
      booking_horizon_months: '6',
    },
  },
];

const ONE_TIME_FEES = [
  {
    name: 'AK On Demand – Service Provider Application Fee',
    description:
      'One-time, non-refundable fee to apply as a service provider on AK On Demand. Gets your application to the interview stage.',
    price: 100, // $1.00 (beta-testing price; normally $19.00)
    metadata: { fee_type: 'application' },
  },
  {
    name: 'AK On Demand – Service Provider Onboarding Fee',
    description:
      'One-time, non-refundable onboarding fee paid after acceptance to activate your service provider account.',
    price: 200, // $2.00 (beta-testing price; normally $60.00)
    metadata: { fee_type: 'onboarding' },
  },
];

const NEW_PLAN_TIERS = new Set(SUBSCRIPTION_PLANS.map((p) => p.metadata.plan_tier));
const OLD_PLAN_TIERS = ['basic', 'pro', 'premium'];

async function archiveOldPlans(stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>) {
  for (const tier of OLD_PLAN_TIERS) {
    if (NEW_PLAN_TIERS.has(tier)) continue;
    const found = await stripe.products.search({
      query: `metadata['plan_tier']:'${tier}' AND active:'true'`,
    });
    for (const product of found.data) {
      await stripe.products.update(product.id, { active: false });
      console.log(`Archived old plan product: "${product.name}" (${product.id})`);
    }
  }
}

async function ensureRecurringProduct(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  plan: (typeof SUBSCRIPTION_PLANS)[number],
) {
  const existing = await stripe.products.search({
    query: `metadata['plan_tier']:'${plan.metadata.plan_tier}' AND active:'true'`,
  });
  if (existing.data.length > 0) {
    // Keep metadata current even if the product already exists.
    await stripe.products.update(existing.data[0].id, {
      name: plan.name,
      description: plan.description,
      metadata: plan.metadata,
    });
    console.log(`✓ "${plan.name}" plan already exists (${existing.data[0].id}) — metadata refreshed`);
    return;
  }
  const product = await stripe.products.create({
    name: plan.name,
    description: plan.description,
    metadata: plan.metadata,
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.price,
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: plan.metadata,
  });
  console.log(`Created plan "${product.name}" (${product.id}) — $${plan.price / 100}/mo (${price.id})`);
}

async function ensureOneTimeFee(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  fee: (typeof ONE_TIME_FEES)[number],
) {
  const existing = await stripe.products.search({
    query: `metadata['fee_type']:'${fee.metadata.fee_type}' AND active:'true'`,
  });
  if (existing.data.length > 0) {
    await stripe.products.update(existing.data[0].id, {
      name: fee.name,
      description: fee.description,
      metadata: fee.metadata,
    });
    const prices = await stripe.prices.list({ product: existing.data[0].id, active: true });
    const match = prices.data.find((p) => p.unit_amount === fee.price);
    if (!match) {
      const price = await stripe.prices.create({
        product: existing.data[0].id,
        unit_amount: fee.price,
        currency: 'usd',
        metadata: fee.metadata,
      });
      console.log(`✓ "${fee.name}" fee exists — added $${fee.price / 100} price (${price.id})`);
    } else {
      console.log(`✓ "${fee.name}" fee already exists (${existing.data[0].id})`);
    }
    return;
  }
  const product = await stripe.products.create({
    name: fee.name,
    description: fee.description,
    metadata: fee.metadata,
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: fee.price,
    currency: 'usd',
    metadata: fee.metadata,
  });
  console.log(`Created fee "${product.name}" (${product.id}) — $${fee.price / 100} one-time (${price.id})`);
}

async function seedProducts() {
  try {
    const stripe = await getUncachableStripeClient();
    console.log('Seeding ServiceHub Stripe catalog...\n');

    await archiveOldPlans(stripe);
    for (const plan of SUBSCRIPTION_PLANS) {
      await ensureRecurringProduct(stripe, plan);
    }
    for (const fee of ONE_TIME_FEES) {
      await ensureOneTimeFee(stripe, fee);
    }

    console.log('\nDone! Webhooks will sync these products to your local database.');
  } catch (error: any) {
    console.error('Error seeding products:', error.message);
    process.exit(1);
  }
}

seedProducts();
