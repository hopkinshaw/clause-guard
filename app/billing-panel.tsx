import { useCallback, useEffect, useState } from "react";
import type { Pack } from "@/lib/billing/config";

type Balance = {
  remaining: number;
  free: number;
  paid: number;
  checkout: "pending" | "credited" | null;
  packs: Pack[];
};

async function loadBalance(session?: string): Promise<Balance> {
  const suffix = session ? "?session_id=" + encodeURIComponent(session) : "";
  const response = await fetch("/api/billing/status" + suffix, { cache: "no-store" });
  if (!response.ok) throw new Error("Credit balance is unavailable");
  return response.json();
}

export function useBilling() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [payment, setPayment] = useState<"checking" | "credited" | "pending" | "canceled">();
  const [buying, setBuying] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState(false);
  const [creditNotice, setCreditNotice] = useState("");

  const refresh = useCallback(async () => {
    const session = new URLSearchParams(window.location.search).get("session_id");
    try {
      const current = await loadBalance(session ?? undefined);
      setBalance(current);
      setUnavailable(false);
      if (current.checkout === "credited") setPayment("credited");
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("checkout");
    const session = outcome === "success" ? params.get("session_id") : null;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    function clearCheckoutUrl() {
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("session_id");
      window.history.replaceState(window.history.state, "", url);
    }

    async function check(attempt: number) {
      if (session && attempt === 0) setPayment("checking");
      if (outcome === "canceled") {
        setPayment("canceled");
        clearCheckoutUrl();
      }
      try {
        const current = await loadBalance(session ?? undefined);
        if (!active) return;
        setBalance(current);
        setUnavailable(false);
        if (!session) return;
        if (current.checkout === "credited") {
          setPayment("credited");
          clearCheckoutUrl();
          return;
        }
      } catch {
        if (!active) return;
        setUnavailable(true);
      }
      if (session) {
        if (attempt < 14) timer = setTimeout(() => void check(attempt + 1), 2000);
        else setPayment("pending");
      }
    }

    void check(0);
    function restore(event: PageTransitionEvent) {
      if (!event.persisted) return;
      setBuying(null);
      void refresh();
    }
    window.addEventListener("pageshow", restore);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("pageshow", restore);
    };
  }, [refresh]);

  async function buy(packId: string) {
    if (buying) return;
    setBuying(packId);
    setCheckoutError(false);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      if (!response.ok) throw new Error("Checkout unavailable");
      const { url } = await response.json();
      if (typeof url !== "string") throw new Error("Missing checkout URL");
      window.location.assign(url);
    } catch {
      setCheckoutError(true);
      setBuying(null);
    }
  }

  return { balance, unavailable, payment, buying, checkoutError, creditNotice, setCreditNotice, refresh, buy };
}

export function BillingPanel({
  billing, disabled,
}: { billing: ReturnType<typeof useBilling>; disabled: boolean }) {
  const { balance, unavailable, payment, buying, checkoutError, creditNotice, setCreditNotice, refresh, buy } = billing;
  const showCreditNotice = creditNotice || (!unavailable && balance?.remaining === 0);
  const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

  return <section className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3" aria-label="Analysis credits">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="text-sm text-slate-800" aria-live="polite">
        {balance
          ? `${balance.remaining} ${balance.remaining === 1 ? "analysis" : "analyses"} remaining`
          : "Analysis credits"}
      </strong>
      <button
        type="button"
        onClick={() => { setCreditNotice(""); void refresh(); }}
        className="text-xs font-medium text-slate-700 underline"
      >
        Refresh balance
      </button>
    </div>
    {unavailable && <p className="mt-1 text-xs text-slate-600" role="status">Credit balance is unavailable. Please refresh.</p>}
    {showCreditNotice && <p className="mt-1 text-xs text-slate-700" role="status">
      {creditNotice || "You’ve used all your available analyses."}{" "}
      {balance?.packs.length
        ? "Choose a credit pack below to keep going."
        : "Purchases are currently unavailable. Please check back later."}
    </p>}
    {balance && !unavailable && !showCreditNotice && <p className="mt-1 text-xs text-slate-600">
      {balance.free} free · {balance.paid} purchased
    </p>}
    {payment && <p className="mt-2 text-xs text-slate-700" role="status">{{
      checking: "Checking your Stripe payment…",
      credited: "Payment confirmed. Your credits are ready.",
      pending: "Payment is still being confirmed. Refresh your balance in this browser shortly.",
      canceled: "Checkout was canceled.",
    }[payment]}</p>}
    {Boolean(balance?.packs.length) && <>
      <div className="mt-3 flex flex-wrap gap-2">
        {balance?.packs.map(pack => <button
          key={pack.id}
          type="button"
          onClick={() => void buy(pack.id)}
          disabled={disabled || Boolean(buying)}
          className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
        >
          {buying === pack.id
            ? "Opening Stripe…"
            : `Buy ${pack.credits} credits · ${price.format(pack.amount / 100)}`}
        </button>)}
      </div>
      <p className="mt-2 text-xs text-slate-600">Checkout opens in Stripe. Credits are tied to this browser’s cookies.</p>
    </>}
    {checkoutError && <p className="mt-2 text-xs text-red-700" role="alert">Could not open checkout. Please try again.</p>}
  </section>;
}
