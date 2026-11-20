import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import ipaddr from "ipaddr.js";
import type { BillingConfig } from "./config";

const name = "clauseguard_wallet";
export const walletPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const checkoutSessionPattern = /^cs_(?:test|live)_[a-zA-Z0-9]{1,220}$/;

function sign(config: BillingConfig, value: string) {
  return createHmac("sha256", config.secret).update(value).digest("base64url");
}

export function walletFromRequest(request: Request, config: BillingConfig) {
  const cookie = request.headers.get("cookie")?.split(";")
    .map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1);
  if (!cookie) return null;
  const [wallet, signature, extra] = cookie.split(".");
  if (extra !== undefined || !walletPattern.test(wallet) || !/^[a-zA-Z0-9_-]{43}$/.test(signature ?? "")) return null;
  const expected = sign(config, "wallet:" + wallet);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? wallet : null;
}

export function walletCookie(wallet: string, config: BillingConfig) {
  const value = wallet + "." + sign(config, "wallet:" + wallet);
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000" +
    (config.app.protocol === "https:" ? "; Secure" : "");
}

export function newWallet() {
  return randomUUID();
}

export function networkFromRequest(request: Request, config: BillingConfig) {
  if (process.env.VERCEL !== "1") return config.local ? sign(config, "network:local") : null;
  const header = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (!header || !ipaddr.isValid(header)) return null;
  const address = ipaddr.process(header);
  // One free bucket per IPv4 address or IPv6 /64. Never store a raw address.
  const key = address.kind() === "ipv4" ? address.toString() : address.toByteArray().slice(0, 8).join(".");
  return sign(config, "network:" + key);
}
