import Stripe from "stripe";
import { checkoutSessionPattern, walletPattern } from "./identity";
import { creditPurchase } from "./store";

let client: Stripe | undefined;

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured");
  return client ??= new Stripe(key, { timeout: 10_000, maxNetworkRetries: 0 });
}

export async function fulfillCheckout(session: Stripe.Checkout.Session, expectedWallet?: string) {
  const { metadata, amount_total: amount } = session;
  const wallet = metadata?.wallet;
  if (session.mode !== "payment" || session.payment_status !== "paid" || session.currency !== "usd" ||
      typeof amount !== "number" || !Number.isSafeInteger(amount) ||
      metadata?.product !== "clauseguard_credits" || !metadata.pack ||
      !wallet || wallet !== session.client_reference_id || !walletPattern.test(wallet) ||
      (expectedWallet !== undefined && wallet !== expectedWallet) || !checkoutSessionPattern.test(session.id)) {
    return null;
  }

  // The stored checkout snapshot determines the wallet, price and credit count.
  return creditPurchase(session.id, wallet, metadata.pack, amount);
}
