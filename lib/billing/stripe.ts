import Stripe from "stripe";

let client: Stripe | undefined;

export function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
  return client ??= new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 10_000, maxNetworkRetries: 0 });
}
