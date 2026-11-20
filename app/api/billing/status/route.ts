import { billingAudit, billingErrorCode, billingRef } from "@/lib/billing/audit";
import { billingConfig } from "@/lib/billing/config";
import { checkoutSessionPattern, networkFromRequest, newWallet, walletCookie, walletFromRequest } from "@/lib/billing/identity";
import { billingStatus, initializeWallet } from "@/lib/billing/store";
import { fulfillCheckout, stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const audit = billingAudit("status");
  let wallet: string | null = null;
  let network: string | null = null;
  try {
    const config = billingConfig(request);
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("session_id");
    const existing = walletFromRequest(request, config);
    if (!existing && (sessionId !== null || params.get("require_wallet") === "1")) {
      return Response.json({
        code: "BILLING_SESSION_REQUIRED",
        error: "We couldn’t find your credit session. Use the browser and site where you started checkout, or allow cookies and refresh.",
      }, { status: 428, headers: audit.headers });
    }
    if (sessionId !== null && !checkoutSessionPattern.test(sessionId)) {
      return Response.json({
        code: "INVALID_CHECKOUT_SESSION",
        error: "Reopen the original checkout return link to check your payment.",
      }, { status: 400, headers: audit.headers });
    }
    wallet = existing ?? newWallet();
    if (!existing) await initializeWallet(wallet);
    network = networkFromRequest(request, config);
    let status = await billingStatus(wallet, network, config, sessionId ?? undefined);
    let checkoutCheckFailed = false;

    // Only look up a pending purchase already bound to this signed browser wallet.
    if (sessionId && status.checkout === "pending") {
      const refs = { walletRef: billingRef(wallet), sessionRef: billingRef(sessionId) };
      try {
        const session = await stripeClient().checkout.sessions.retrieve(sessionId);
        const fulfilled = session.id === sessionId ? await fulfillCheckout(session, wallet) : false;
        if (fulfilled) {
          status = await billingStatus(wallet, network, config, sessionId);
          audit.log("info", "checkout_confirmed", refs);
        } else if (fulfilled === false || session.payment_status === "paid") {
          checkoutCheckFailed = true;
          audit.log("warn", "checkout_record_mismatch", refs);
        }
      } catch (error) {
        // Keep the balance readable if Stripe is unavailable. A refresh can retry.
        checkoutCheckFailed = true;
        audit.log("warn", "checkout_confirmation_failed", { ...refs, errorCode: billingErrorCode(error) });
      }
    }
    audit.log(existing ? "info" : "warn", existing ? "wallet_read" : "wallet_created", {
      walletRef: billingRef(wallet), networkRef: billingRef(network), freeLimit: config.free,
      remaining: status.remaining, free: status.free, paid: status.paid, used: status.used,
    });
    const headers = new Headers({ ...audit.headers, "Cache-Control": "private, no-store", Vary: "Cookie" });
    if (!existing) headers.set("Set-Cookie", walletCookie(wallet, config));
    return Response.json({
      ...status, walletCreated: !existing, checkoutCheckFailed, packs: config.checkoutEnabled ? config.packs : [],
    }, { headers });
  } catch (error) {
    audit.log("error", "read_failed", { walletRef: billingRef(wallet), networkRef: billingRef(network), errorCode: billingErrorCode(error) });
    return Response.json({ error: "Credit balance is temporarily unavailable." }, {
      status: 503, headers: audit.headers,
    });
  }
}
