import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CreditCard, RefreshCw } from "lucide-react";
import type { Pack } from "@/lib/billing/config";

type Balance = {
  remaining: number;
  free: number;
  paid: number;
  used: number;
  purchased: number;
  checkout: "pending" | "credited" | null;
  checkoutCheckFailed: boolean;
  walletCreated: boolean;
  packs: Pack[];
};

type Payment = "checking" | "credited" | "pending" | "canceled" | "unmatched" | "error";
type BalanceError = "session" | "checkout" | "unavailable";

const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const walletSeenKey = "clauseguard-wallet-seen";

class BalanceRequestError extends Error {
  constructor(readonly reason: BalanceError) {
    super(reason);
  }
}

async function loadBalance(signal: AbortSignal, session: string | null, requireWallet = false): Promise<Balance> {
  const params = new URLSearchParams();
  if (session !== null) params.set("session_id", session);
  if (requireWallet) params.set("require_wallet", "1");
  const suffix = params.size ? "?" + params : "";
  const response = await fetch("/api/billing/status" + suffix, {
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    const reason = response.status === 428 ? "session" : response.status === 400 && session !== null ? "checkout" : "unavailable";
    throw new BalanceRequestError(reason);
  }
  return response.json();
}

function clearCheckoutUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  url.searchParams.delete("session_id");
  window.history.replaceState(window.history.state, "", url);
}

export function useBilling() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState<BalanceError>();
  const [walletReplaced, setWalletReplaced] = useState(false);
  const [payment, setPayment] = useState<Payment>();
  const [buying, setBuying] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopRefresh = useCallback(() => {
    request.current?.abort();
    clearTimeout(timer.current);
  }, []);

  const refresh = useCallback(async () => {
    stopRefresh();
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("checkout");
    const session = outcome === "success" ? params.get("session_id") ?? "" : null;
    const deadline = Date.now() + 30_000;

    setBalance(null);
    setBalanceError(undefined);
    if (outcome === "canceled") {
      setPayment("canceled");
      clearCheckoutUrl();
    }
    if (session !== null) setPayment("checking");

    async function check() {
      try {
        let current = await loadBalance(signal, session);
        const created = current.walletCreated;
        if (created) current = await loadBalance(signal, null, true);
        if (signal.aborted) return;
        try {
          if (created && localStorage.getItem(walletSeenKey)) setWalletReplaced(true);
          localStorage.setItem(walletSeenKey, "1");
        } catch { /* Browsers can disable local storage. The signed cookie still determines the balance. */ }
        setBalance(current);
        setBalanceError(undefined);
        if (session === null) return;
        if (current.checkout === "credited") {
          setPayment("credited");
          clearCheckoutUrl();
        } else if (current.checkout === null) {
          setPayment("unmatched");
        } else if (current.checkoutCheckFailed) {
          setPayment("error");
        } else if (Date.now() + 2_000 >= deadline) {
          setPayment("pending");
        } else {
          timer.current = setTimeout(() => void check(), 2_000);
        }
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof BalanceRequestError ? error.reason : "unavailable";
        setBalance(null);
        setBalanceError(reason);
        if (session !== null) setPayment(reason === "unavailable" ? "error" : "unmatched");
      }
    }

    await check();
  }, [stopRefresh]);

  useEffect(() => {
    void refresh();
    function resume() {
      if (document.visibilityState === "visible") void refresh();
    }
    function restore(event: PageTransitionEvent) {
      if (!event.persisted) return;
      setBuying(null);
      void refresh();
    }
    function suspend() {
      stopRefresh();
      setBalance(null);
      setBalanceError(undefined);
    }
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", restore);
    window.addEventListener("pagehide", suspend);
    return () => {
      stopRefresh();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", restore);
      window.removeEventListener("pagehide", suspend);
    };
  }, [refresh, stopRefresh]);

  async function buy(packId: string) {
    if (buying || !balance) return;
    setBuying(packId);
    setCheckoutError("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 428) {
        setCheckoutError("Your credit session could not be found. Check your balance before trying again.");
        setBuying(null);
        void refresh();
        return;
      }
      if (!response.ok) throw new Error("Checkout unavailable");
      const { url } = await response.json();
      if (typeof url !== "string") throw new Error("Missing checkout URL");
      window.location.assign(url);
    } catch {
      setCheckoutError("Could not open Stripe Checkout. Choose a pack to try again.");
      setBuying(null);
    }
  }

  return { balance, balanceError, walletReplaced, payment, buying, checkoutError, refresh, buy };
}

export function BillingPanel({
  billing, disabled,
}: { billing: ReturnType<typeof useBilling>; disabled: boolean }) {
  const { balance, balanceError, walletReplaced, payment, buying, checkoutError, refresh, buy } = billing;
  const checking = !balance && !balanceError;
  const exhausted = balance?.remaining === 0;
  const showPacks = balance?.packs.length && (!payment || payment === "credited" || payment === "canceled");
  const bestValue = balance?.packs.reduce<Pack | undefined>((best, pack) =>
    !best || pack.amount / pack.credits < best.amount / best.credits ? pack : best, undefined);

  return <section id="analysis-credits" className="mt-5 scroll-mt-6 overflow-hidden rounded-xl border border-slate-300 bg-white" aria-labelledby="analysis-credits-title">
    <div className={exhausted ? "bg-amber-50 p-4" : "bg-slate-50 p-4"}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h2 id="analysis-credits-title" className="text-sm font-semibold text-slate-900" aria-live="polite">
          {balance
            ? `${balance.remaining} ${balance.remaining === 1 ? "analysis" : "analyses"} remaining`
            : checking ? "Checking balance…" : "Analysis credits"}
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          className="inline-flex items-center gap-1.5 text-slate-700 underline-offset-2 hover:underline disabled:no-underline"
        >
          <RefreshCw size={13} className={checking ? "animate-spin" : ""} aria-hidden="true" />
          <span className="text-xs font-semibold">Refresh balance</span>
        </button>
      </div>
      {balance && <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
        {([["Free left", balance.free], ["Paid left", balance.paid], ["Used", balance.used], ["Purchased", balance.purchased]] as const).map(([label, count]) =>
          <div key={label} className="flex gap-1"><dt>{label}</dt><dd className="font-semibold text-slate-800">{count}</dd></div>,
        )}
      </dl>}
      {exhausted && <p className="mt-2 text-xs leading-relaxed text-amber-950">
        {payment === "checking" || payment === "pending" || payment === "error"
          ? "You’re out of analyses. Your balance will update when the payment is confirmed."
          : balance.packs.length && showPacks
            ? "You’re out of analyses. Add credits to review another contract."
            : "You’re out of analyses."}
      </p>}
      {balanceError && <p className="mt-2 text-xs leading-relaxed text-red-800" role="alert">{{
        session: payment === "unmatched"
          ? "We couldn’t find the credit session for this payment. Open the return link in the browser and on the site you used to pay."
          : "We couldn’t verify your credit session. Allow cookies for this site, then refresh your balance.",
        checkout: "This checkout link is incomplete or invalid. Reopen the original return link to check your payment.",
        unavailable: "We couldn’t load your balance. Refresh your balance to try again.",
      }[balanceError]}</p>}
      {walletReplaced && balance && <p className="mt-2 text-xs leading-relaxed text-slate-700" role="status">
        Your previous credit session was unavailable. This is a new session. To use existing credits, return to the browser and site where you purchased them.
      </p>}
      {payment && !(payment === "unmatched" && balanceError) && <p className="mt-2 text-xs leading-relaxed text-slate-700" role="status">{{
        checking: "Checking your Stripe payment…",
        credited: "Payment confirmed. Your credits are ready.",
        pending: "Your payment is still being confirmed. Refresh your balance shortly to check this purchase again.",
        canceled: "Checkout was canceled.",
        unmatched: "This purchase doesn’t match the current credit session. Reopen the return link in the browser you used to pay.",
        error: "We couldn’t confirm this payment right now. Refresh your balance to check the same purchase again.",
      }[payment]}</p>}
      {checkoutError && <p className="mt-2 text-xs leading-relaxed text-red-800" role="alert">{checkoutError}</p>}
    </div>
    {showPacks ? <div className="border-t border-slate-200 bg-teal-50/50 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CreditCard size={16} aria-hidden="true" /> Add analysis credits</h3>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-2.5">
        {balance.packs.map(pack => <button
          key={pack.id}
          type="button"
          onClick={() => void buy(pack.id)}
          disabled={disabled || Boolean(buying)}
          className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${exhausted && pack === bestValue
            ? "border-teal-900 bg-teal-900 text-white enabled:hover:bg-teal-800"
            : "border-teal-600 bg-white text-teal-950 enabled:hover:border-teal-800 enabled:hover:bg-teal-50"}`}
        >
          <span className="flex items-center justify-between gap-1 text-xs font-semibold">
            {buying === pack.id ? "Opening Stripe…" : `Buy ${pack.credits} credits`}
            <ArrowUpRight size={14} className="shrink-0" aria-hidden="true" />
          </span>
          <span className="mt-1.5 block text-lg font-semibold tabular-nums">{price.format(pack.amount / 100)}</span>
          <span className="block text-xs opacity-85">{price.format(pack.amount / pack.credits / 100)} per analysis</span>
        </button>)}
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-slate-600">Pay with Stripe. Credits stay with this browser on this site.</p>
    </div> : balance && exhausted && !balance.packs.length && !payment &&
      <p className="border-t border-slate-200 p-4 text-xs text-slate-700">Purchases are temporarily unavailable. Refresh your balance to check again.</p>}
  </section>;
}
