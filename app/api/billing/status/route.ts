import { billingAudit, billingErrorCode, billingRef } from "@/lib/billing/audit";
import { billingConfig } from "@/lib/billing/config";
import { checkoutSessionPattern, networkFromRequest, newWallet, walletCookie, walletFromRequest } from "@/lib/billing/identity";
import { billingStatus, initializeWallet } from "@/lib/billing/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const audit = billingAudit("status");
  let wallet: string | null = null;
  let network: string | null = null;
  try {
    const config = billingConfig(request);
    const existing = walletFromRequest(request, config);
    wallet = existing ?? newWallet();
    if (!existing) await initializeWallet(wallet);
    network = networkFromRequest(request, config);
    const session = new URL(request.url).searchParams.get("session_id") ?? "";
    const status = await billingStatus(wallet, network, config, checkoutSessionPattern.test(session) ? session : undefined);
    audit.log(existing ? "info" : "warn", existing ? "wallet_read" : "wallet_created", {
      walletRef: billingRef(wallet), networkRef: billingRef(network), freeLimit: config.free,
      remaining: status.remaining, free: status.free, paid: status.paid, used: status.used,
    });
    const headers = new Headers({ ...audit.headers, "Cache-Control": "private, no-store", Vary: "Cookie" });
    if (!existing) headers.set("Set-Cookie", walletCookie(wallet, config));
    return Response.json({ ...status, packs: config.checkoutEnabled ? config.packs : [] }, { headers });
  } catch (error) {
    audit.log("error", "read_failed", { walletRef: billingRef(wallet), networkRef: billingRef(network), errorCode: billingErrorCode(error) });
    return Response.json({ error: "Credit balance is temporarily unavailable." }, {
      status: 503, headers: audit.headers,
    });
  }
}
