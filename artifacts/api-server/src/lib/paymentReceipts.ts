import type Stripe from "stripe";

export function paymentReceipt(amountCents: number | null, currency: string | null) {
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents < 0 ||
      !currency || !/^[a-z]{3}$/i.test(currency)) return null;
  return { amountCents, currency: currency.toLowerCase() };
}

export function checkoutReceipt(session: Pick<Stripe.Checkout.Session, "amount_total" | "currency">) {
  return paymentReceipt(session.amount_total, session.currency);
}
