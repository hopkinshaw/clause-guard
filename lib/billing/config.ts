import { z } from "zod";

const packList = z.array(z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  credits: z.number().int().min(1).max(1000),
  amount: z.number().int().min(50).max(1_000_000),
}).strict()).min(1).max(8).refine(packs => new Set(packs.map(pack => pack.id)).size === packs.length);

export type Pack = z.infer<typeof packList>[number];

function limit(name: string, fallback: number, max: number) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error("Invalid billing limit");
  return Number(raw);
}

export function billingConfig() {
  const app = new URL(process.env.APP_URL ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname);
  if ((app.protocol !== "https:" && !(local && app.protocol === "http:")) ||
      app.href !== app.origin + "/") throw new Error("APP_URL must be an origin");
  const secret = process.env.BILLING_COOKIE_SECRET ?? "";
  if (Buffer.byteLength(secret) < 32) throw new Error("Missing billing cookie secret");
  const packs = packList.parse(process.env.BILLING_PACKS
    ? JSON.parse(process.env.BILLING_PACKS)
    : [{ id: "starter", credits: 5, amount: 499 }, { id: "plus", credits: 10, amount: 899 }]);

  return {
    app, local, secret, packs,
    free: limit("FREE_ANALYSIS_CREDITS", 2, 1000),
    freeDaily: limit("FREE_ANALYSIS_DAILY_LIMIT", 100, 100_000),
    daily: limit("ANALYSIS_DAILY_LIMIT", 300, 100_000),
    checkoutEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
  };
}

export type BillingConfig = ReturnType<typeof billingConfig>;
