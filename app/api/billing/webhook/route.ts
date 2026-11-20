import type Stripe from "stripe";
import { billingAudit, billingErrorCode, billingRef } from "@/lib/billing/audit";
import { fulfillCheckout, stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !process.env.STRIPE_SECRET_KEY?.trim()) return new Response("Webhook is unavailable", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(await request.text(), signature, secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const audit = billingAudit("webhook");
    const session = event.data.object;
    const refs = { sessionRef: billingRef(session.id), event: event.type };
    try {
      const fulfilled = await fulfillCheckout(session);
      if (fulfilled === false) {
        audit.log("warn", "checkout_record_mismatch", refs);
        return new Response("Checkout record could not be confirmed", { status: 503 });
      }
      if (fulfilled) audit.log("info", "checkout_confirmed", refs);
    } catch (error) {
      audit.log("error", "checkout_confirmation_failed", { ...refs, errorCode: billingErrorCode(error) });
      return new Response("Could not credit purchase", { status: 503 });
    }
  }
  return Response.json({ received: true });
}
