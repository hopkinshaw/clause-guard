import Stripe from "stripe";

let client: Stripe | undefined;

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured");
  return client ??= new Stripe(key, { timeout: 10_000, maxNetworkRetries: 0 });
}
