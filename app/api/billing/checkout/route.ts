import { billingConfig } from "@/lib/billing/config";
import { walletFromRequest } from "@/lib/billing/identity";
import { savePurchase } from "@/lib/billing/store";
import { stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = billingConfig();
    if (request.headers.get("origin") !== config.app.origin) {
      return Response.json({ error: "Open checkout from the main ClauseGuard site." }, { status: 403 });
    }
    const wallet = walletFromRequest(request, config);
    if (!wallet) return Response.json({ error: "Refresh the page to start a credit session." }, { status: 428 });
    if (!config.checkoutEnabled) return Response.json({ error: "Purchases are currently unavailable." }, { status: 503 });

    const body = await request.json().catch(() => null);
    const pack = config.packs.find(item => item.id === body?.packId);
    if (!pack) return Response.json({ error: "Choose an available credit pack." }, { status: 400 });
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      locale: "en",
      client_reference_id: wallet,
      metadata: { product: "clauseguard_credits", wallet, pack: pack.id, credits: String(pack.credits) },
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: pack.amount,
          product_data: { name: `ClauseGuard — ${pack.credits} analysis credits` },
        },
        quantity: 1,
      }],
      success_url: config.app.href + "?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: config.app.href + "?checkout=canceled",
    });

    if (!session.url) throw new Error("Checkout URL is missing");
    await savePurchase(session.id, wallet, pack);
    return Response.json({ url: session.url }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not start Stripe Checkout. Please try again." }, { status: 503 });
  }
}
