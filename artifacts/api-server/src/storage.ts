import { sql } from 'drizzle-orm';
import { db } from '@workspace/db';

export class Storage {
  async getProduct(productId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.products WHERE id = ${productId}`
    );
    return result.rows[0] || null;
  }

  async listProducts(active = true, limit = 20, offset = 0) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.products WHERE active = ${active} LIMIT ${limit} OFFSET ${offset}`
    );
    return result.rows;
  }

  async listProductsWithPrices(active = true, limit = 20, offset = 0) {
    const result = await db.execute(
      sql`
        WITH paginated_products AS (
          SELECT id, name, description, metadata, active
          FROM stripe.products
          WHERE active = ${active}
          ORDER BY id
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT 
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          p.active as product_active,
          p.metadata as product_metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring,
          pr.active as price_active,
          pr.metadata as price_metadata
        FROM paginated_products p
        LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        ORDER BY p.id, pr.unit_amount
      `
    );
    return result.rows;
  }

  async getPrice(priceId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.prices WHERE id = ${priceId}`
    );
    return result.rows[0] || null;
  }

  async listPrices(active = true, limit = 20, offset = 0) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.prices WHERE active = ${active} LIMIT ${limit} OFFSET ${offset}`
    );
    return result.rows;
  }

  async getPricesForProduct(productId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.prices WHERE product = ${productId} AND active = true ORDER BY unit_amount ASC`
    );
    return result.rows;
  }

  async getSubscription(subscriptionId: string) {
    const result = await db.execute(
      sql`SELECT * FROM stripe.subscriptions WHERE id = ${subscriptionId}`
    );
    return result.rows[0] || null;
  }

  async getUser(id: string) {
    const result = await db.execute(
      sql`SELECT * FROM public.users WHERE id = ${id}`
    );
    return result.rows[0] || null;
  }

  async upsertUser(id: string, email: string) {
    const result = await db.execute(
      sql`
        INSERT INTO public.users (id, email) VALUES (${id}, ${email})
        ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
        RETURNING *
      `
    );
    return result.rows[0];
  }

  async updateUserStripeInfo(userId: string, stripeInfo: {
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
  }) {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (stripeInfo.stripe_customer_id !== undefined) {
      sets.push(`stripe_customer_id = $${idx++}`);
      values.push(stripeInfo.stripe_customer_id);
    }
    if (stripeInfo.stripe_subscription_id !== undefined) {
      sets.push(`stripe_subscription_id = $${idx++}`);
      values.push(stripeInfo.stripe_subscription_id);
    }

    if (sets.length === 0) return null;

    values.push(userId);
    const result = await db.execute(
      sql`UPDATE public.users SET stripe_customer_id = ${stripeInfo.stripe_customer_id ?? null}, stripe_subscription_id = ${stripeInfo.stripe_subscription_id ?? null} WHERE id = ${userId} RETURNING *`
    );
    return result.rows[0];
  }
}

export const storage = new Storage();
