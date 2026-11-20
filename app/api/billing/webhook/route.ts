import type Stripe from "stripe";
import { checkoutSessionPattern, walletPattern } from "@/lib/billing/identity";
import { creditPurchase } from "@/lib/billing/store";
import { stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return new Response("Webhook is unavailable", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(await request.text(), signature, secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    const metadata = session.metadata;
    if (session.mode === "payment" && session.payment_status === "paid" && session.currency === "usd" &&
        session.amount_total !== null && Number.isSafeInteger(session.amount_total) &&
        metadata?.product === "clauseguard_credits" && metadata.pack && metadata.wallet &&
        metadata.wallet === session.client_reference_id && walletPattern.test(metadata.wallet) &&
        checkoutSessionPattern.test(session.id)) {
      try {
        // The database verifies the checkout snapshot and credits each session at most once.
        await creditPurchase(session.id, metadata.wallet, metadata.pack, session.amount_total);
      } catch {
        return new Response("Could not credit purchase", { status: 503 });
      }
    }
  }
  return Response.json({ received: true });
}
