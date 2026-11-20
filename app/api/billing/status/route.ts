import { billingConfig } from "@/lib/billing/config";
import { checkoutSessionPattern, networkFromRequest, newWallet, walletCookie, walletFromRequest } from "@/lib/billing/identity";
import { billingStatus, initializeWallet } from "@/lib/billing/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const config = billingConfig();
    const existing = walletFromRequest(request, config);
    const wallet = existing ?? newWallet();
    if (!existing) await initializeWallet(wallet);
    const network = networkFromRequest(request, config);
    const session = new URL(request.url).searchParams.get("session_id") ?? "";
    const status = await billingStatus(wallet, network, config, checkoutSessionPattern.test(session) ? session : undefined);
    const headers = new Headers({ "Cache-Control": "private, no-store", Vary: "Cookie" });
    if (!existing) headers.set("Set-Cookie", walletCookie(wallet, config));
    return Response.json({ ...status, packs: config.checkoutEnabled ? config.packs : [] }, { headers });
  } catch {
    return Response.json({ error: "Credit balance is temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
