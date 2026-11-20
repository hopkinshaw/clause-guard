import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { test } from "node:test";
import type Stripe from "stripe";
import { POST as checkout } from "../app/api/billing/checkout/route";
import { GET as status } from "../app/api/billing/status/route";
import { POST as webhook } from "../app/api/billing/webhook/route";
import { POST as analyze } from "../app/api/analyze/route";
import { demoAnalysis, demoContract } from "../lib/demo";
import { billingRef } from "../lib/billing/audit";
import { billingConfig } from "../lib/billing/config";
import { postgresOptions } from "../lib/billing/database";
import { networkFromRequest, newWallet, walletCookie, walletFromRequest } from "../lib/billing/identity";
import { AnalysisLimit, billingStatus, completeAnalysis, creditPurchase, releaseAnalysis, reserveAnalysis, savePurchase } from "../lib/billing/store";
import { stripeClient } from "../lib/billing/stripe";
import { setupBillingDatabase, testDatabase } from "./billing-db";

setupBillingDatabase();
const origin = "http://localhost:3000";

test("billing resolves Neon and legacy Postgres environment variables safely", () => {
  const primary = "postgresql://app@primary.test/credits";
  const legacy = "postgresql://app@legacy.test/credits";
  const direct = "postgresql://app@direct.test/credits";
  assert.equal(postgresOptions({ DATABASE_URL: primary, POSTGRES_URL: legacy }).connectionString, primary);
  assert.equal(postgresOptions({ DATABASE_URL: "", POSTGRES_URL: legacy }).connectionString, legacy);
  assert.equal(postgresOptions({ DATABASE_URL: primary, DATABASE_URL_UNPOOLED: direct }, true).connectionString, direct);
  assert.equal(postgresOptions({ POSTGRES_URL_NON_POOLING: direct }).connectionString, direct);

  const neon = postgresOptions({
    DATABASE_URL: "postgresql://app@project-pooler.region.neon.tech/credits?sslmode=require&channel_binding=require",
  });
  assert.equal(new URL(neon.connectionString!).searchParams.get("sslmode"), "verify-full");
  assert.equal(neon.enableChannelBinding, true);

  assert.deepEqual(postgresOptions({
    PGHOST: "project.region.neon.tech", PGUSER: "app", PGDATABASE: "credits", PGPORT: "5433",
  }), {
    host: "project.region.neon.tech", user: "app", database: "credits", port: 5433, password: undefined,
    ssl: true, enableChannelBinding: true,
  });
  assert.throws(() => postgresOptions({ PGHOST: "localhost", PGPORT: "not-a-port" }), /Invalid Postgres port/);
  assert.throws(() => postgresOptions({ DATABASE_URL: "https://invalid.test" }), /Invalid Postgres connection URL/);
  assert.throws(() => postgresOptions({}), /Postgres is not configured/);
});

test("billing normalizes the canonical URL or uses the request origin without trusting headers", () => {
  const savedUrl = process.env.APP_URL;
  const savedSecret = process.env.BILLING_COOKIE_SECRET;
  try {
    process.env.BILLING_COOKIE_SECRET = randomBytes(32).toString("hex");
    const request = new Request("https://preview.example/api/billing/checkout?foo=bar", {
      headers: { origin: "https://unrelated.example", "x-forwarded-host": "unrelated.example" },
    });
    process.env.APP_URL = "https://clauseguard.example///";
    assert.equal(billingConfig(request).app.href, "https://clauseguard.example/");
    delete process.env.APP_URL;
    assert.equal(billingConfig(request).app.href, "https://preview.example/");
    assert.throws(() => billingConfig(new Request("http://preview.example/api/billing/checkout")), /Invalid billing site origin/);
    delete process.env.BILLING_COOKIE_SECRET;
    assert.throws(() => billingConfig(request), /Missing billing cookie secret/);
  } finally {
    if (savedUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.BILLING_COOKIE_SECRET; else process.env.BILLING_COOKIE_SECRET = savedSecret;
  }
});

test("billing migration backfills wallet totals without changing balances and is repeatable", { skip: !testDatabase }, async () => {
  const schema = "legacy_billing_" + randomBytes(6).toString("hex");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("CREATE SCHEMA " + schema);
    await db.query("SET search_path TO " + schema);
    await db.query(`
      CREATE TABLE billing_wallets (
        id uuid PRIMARY KEY, free_used integer NOT NULL DEFAULT 0, paid_balance integer NOT NULL DEFAULT 0
      );
      CREATE TABLE billing_purchases (
        session_id text PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES billing_wallets(id),
        pack_id text NOT NULL, credits integer NOT NULL, amount integer NOT NULL, credited_at timestamptz
      );
    `);
    const wallet = newWallet();
    await db.query("INSERT INTO billing_wallets (id, free_used, paid_balance) VALUES ($1, 1, 3)", [wallet]);
    await db.query(`
      INSERT INTO billing_purchases (session_id, wallet_id, pack_id, credits, amount, credited_at)
      VALUES ('credited-test', $1, 'starter', 5, 499, now()), ('pending-test', $1, 'plus', 10, 899, NULL)
    `, [wallet]);
    const sql = await readFile(new URL("../db/billing.sql", import.meta.url), "utf8");
    const readWallet = () => db.query("SELECT * FROM billing_wallets WHERE id = $1", [wallet]).then(r => r.rows[0]);
    await db.query(sql);
    const migrated = await readWallet();
    assert.equal(migrated.paid_balance, 3);
    assert.equal(migrated.free_used, 1);
    assert.equal(migrated.purchased_credits, "5");
    assert.equal(migrated.used_analyses, "3");
    assert.ok(migrated.updated_at instanceof Date);
    await db.query(sql);
    assert.deepEqual(await readWallet(), migrated);
  } finally {
    try {
      await db.query("ROLLBACK");
      await db.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      db.release();
      await pool.end();
    }
  }
});

test("wallet tokens cannot be forged and Vercel IPv6 addresses share a /64 bucket", () => {
  const config = {
    app: new URL(origin), secret: randomBytes(32).toString("hex"), local: true,
    packs: [], free: 2, freeDaily: 100, daily: 300, checkoutEnabled: false,
  };
  const wallet = newWallet();
  const cookie = walletCookie(wallet, config).split(";")[0];
  assert.equal(walletFromRequest(new Request(origin, { headers: { cookie } }), config), wallet);
  assert.equal(walletFromRequest(new Request(origin, {
    headers: { cookie: cookie.replace(wallet, newWallet()) },
  }), config), null);

  const saved = process.env.VERCEL;
  const network = (ip: string) => networkFromRequest(new Request(origin, {
    headers: { "x-vercel-forwarded-for": ip },
  }), config);
  try {
    process.env.VERCEL = "1";
    assert.equal(network("2001:db8::1"), network("2001:db8::10"));
    assert.notEqual(network("2001:db8::1"), network("2001:db8:0:1::1"));
    assert.equal(network("::ffff:192.0.2.1"), network("192.0.2.1"));
    assert.equal(network("192.0.2.1, 192.0.2.2"), null);
  } finally {
    if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
  }
});

test("reservations serialize per wallet and per network, and only a completed report uses a credit", { skip: !testDatabase }, async () => {
  const config = billingConfig();
  const network = "reservation-test";
  const wallet = newWallet();
  const other = newWallet();
  const stranger = newWallet();
  const first = await reserveAnalysis(wallet, network, config);
  assert.equal((await billingStatus(wallet, network, config)).remaining, 2);
  await assert.rejects(reserveAnalysis(wallet, network, config), { code: "ANALYSIS_IN_PROGRESS" });

  const contending = await Promise.allSettled([
    reserveAnalysis(other, network, config),
    reserveAnalysis(stranger, network, config),
  ]);
  assert.equal(contending.filter(result => result.status === "fulfilled").length, 1);
  const winner = contending[0].status === "fulfilled" ? 0 : 1;
  const won = contending[winner];
  const lost = contending[1 - winner];
  assert.equal(won.status, "fulfilled");
  assert.equal(lost.status, "rejected");
  assert.ok(lost.reason instanceof AnalysisLimit && lost.reason.code === "NO_CREDITS");
  await completeAnalysis(winner === 0 ? other : stranger, won.value.id);

  await releaseAnalysis(wallet, first.id);
  assert.equal((await billingStatus(wallet, network, config)).remaining, 1);
  const retry = await reserveAnalysis(wallet, network, config);
  await completeAnalysis(wallet, retry.id);
  await assert.rejects(reserveAnalysis(newWallet(), network, config), { code: "NO_CREDITS" });

  const leased = await reserveAnalysis(wallet, "different-test-network", config);
  await completeAnalysis(wallet, leased.id);
  await assert.rejects(reserveAnalysis(wallet, "third-test-network", config), { code: "NO_CREDITS" });
  await assert.rejects(reserveAnalysis(newWallet(), "fourth-test-network", { ...config, freeDaily: 0 }), { code: "FREE_DAILY_LIMIT" });
  await assert.rejects(reserveAnalysis(newWallet(), "fifth-test-network", { ...config, daily: 0 }), { code: "DAILY_LIMIT" });
});

test("a paid reservation is used before free credits and a released reservation spends neither", { skip: !testDatabase }, async () => {
  const config = billingConfig();
  const wallet = newWallet();
  const network = "paid-first-test";
  const pack = config.packs[0];
  const session = "cs_test_" + randomBytes(10).toString("hex");
  await savePurchase(session, wallet, pack);
  assert.equal(await creditPurchase(session, wallet, pack.id, pack.amount), true);

  const released = await reserveAnalysis(wallet, network, config);
  await releaseAnalysis(wallet, released.id);
  const unchanged = await billingStatus(wallet, network, config);
  assert.deepEqual([unchanged.free, unchanged.paid, unchanged.used], [2, pack.credits, 0]);

  const spent = await reserveAnalysis(wallet, network, config);
  await completeAnalysis(wallet, spent.id);
  await assert.rejects(completeAnalysis(wallet, spent.id), /reservation is no longer valid/);
  const afterSpend = await billingStatus(wallet, network, config);
  assert.deepEqual([afterSpend.free, afterSpend.paid, afterSpend.used], [2, pack.credits - 1, 1]);
});

test("two analyses, quota block, and verified Stripe payment restore credits on the same wallet", { skip: !testDatabase }, async t => {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  for (const level of ["info", "warn", "error"] as const) {
    t.mock.method(console, level, (event: string, detail: string) => {
      logs.push({ event, fields: JSON.parse(detail) });
    });
  }
  process.env.STRIPE_SECRET_KEY = "sk_test_" + randomBytes(16).toString("hex");
  const webhookSecret = "whsec_" + randomBytes(16).toString("hex");
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  const stripe = stripeClient();
  const sessionId = "cs_test_" + randomBytes(10).toString("hex");
  let params: Stripe.Checkout.SessionCreateParams | undefined;
  t.mock.method(stripe.checkout.sessions, "create", async (input: Stripe.Checkout.SessionCreateParams) => {
    params = input;
    return { id: sessionId, url: "https://checkout.stripe.com/test-checkout" };
  });

  // A stale production setting must not grant a third free report.
  process.env.FREE_ANALYSIS_CREDITS = "3";
  process.env.APP_URL = origin + "///";
  const initial = await status(new Request(origin + "/api/billing/status"));
  assert.equal(initial.status, 200);
  const fresh = await initial.json();
  assert.deepEqual([fresh.remaining, fresh.used, fresh.purchased], [2, 0, 0]);
  assert.ok(Number.isFinite(Date.parse(fresh.updatedAt)));
  const signed = initial.headers.get("set-cookie");
  assert.ok(signed && signed.includes("HttpOnly"));
  const cookie = signed.split(";")[0];
  const config = billingConfig();
  const wallet = walletFromRequest(new Request(origin, { headers: { cookie } }), config);
  assert.ok(wallet);
  process.env.OPENAI_API_KEY = randomBytes(16).toString("hex");
  process.env.OPENAI_BASE_URL = "https://model.example.invalid/v1";
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    assert.equal(new URL(url).hostname, "model.example.invalid");
    modelCalls++;
    return Response.json({
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(demoAnalysis) }] }],
    });
  });
  const runAnalysis = (credential = cookie) => analyze(new Request(origin + "/api/analyze", {
    method: "POST",
    headers: { cookie: credential, origin, "Content-Type": "application/json" },
    body: JSON.stringify({ contractText: demoContract }),
  }));
  const readBalance = (query = "", credential = cookie) =>
    status(new Request(origin + "/api/billing/status" + query, { headers: { cookie: credential } })).then(res => res.json());

  for (const remaining of [1, 0]) {
    const analyzed = await runAnalysis();
    assert.equal(analyzed.status, 200);
    assert.deepEqual(await analyzed.json(), demoAnalysis);
    assert.equal((await readBalance()).remaining, remaining);
  }

  const blocked = await runAnalysis();
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  const blockedLog = logs.find(log => log.fields.requestId === blocked.headers.get("x-billing-request-id"));
  assert.equal(blockedLog?.event, "[billing.analyze] blocked");
  assert.equal(blockedLog?.fields.walletRef, billingRef(wallet));
  assert.equal(blockedLog?.fields.reason, "wallet_free_limit");
  assert.equal((blockedLog?.fields.quota as { remaining: number }).remaining, 0);
  assert.ok(logs.some(log => log.event === "[billing.status] wallet_created" && log.fields.walletRef === billingRef(wallet)));
  const walletLogs = logs.filter(log => log.event === "[billing.analyze] charged" && log.fields.walletRef === billingRef(wallet));
  assert.deepEqual(walletLogs.map(log => log.fields.walletFreeUsed), [1, 2]);
  assert.ok(!JSON.stringify(logs).includes(cookie) && !JSON.stringify(logs).includes(wallet));
  assert.deepEqual(await blocked.json(), {
    status: "needs_credits",
    code: "NO_CREDITS",
    remaining: 0,
    message: "You’ve used all your available analyses.",
    checkout: { endpoint: "/api/billing/checkout", packs: config.packs },
  });
  assert.equal(modelCalls, 2);
  const rotated = await status(new Request(origin + "/api/billing/status"));
  const otherCookie = rotated.headers.get("set-cookie")?.split(";")[0];
  assert.ok(otherCookie && otherCookie !== cookie);
  assert.equal((await rotated.json()).remaining, 0);
  assert.equal((await (await runAnalysis(otherCookie)).json()).code, "NO_CREDITS");
  assert.equal(modelCalls, 2);

  const start = (packId: string, requestOrigin = origin) => checkout(new Request(origin + "/api/billing/checkout", {
    method: "POST", headers: { cookie, origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ packId, amount: 1 }),
  }));
  assert.equal((await start("starter", "https://unrelated.example")).status, 403);
  assert.equal((await start("unknown")).status, 400);
  assert.equal(params, undefined);
  delete process.env.APP_URL;
  const checkoutResponse = await start("starter");
  assert.equal(checkoutResponse.status, 200);
  assert.deepEqual(await checkoutResponse.json(), { url: "https://checkout.stripe.com/test-checkout" });
  const captured = params as Stripe.Checkout.SessionCreateParams | undefined;
  assert.equal(captured?.line_items?.[0].price_data?.unit_amount, 499);
  assert.equal(captured?.client_reference_id, wallet);
  assert.equal(captured?.locale, "en");
  assert.equal(captured?.success_url, origin + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(captured?.cancel_url, origin + "/?checkout=canceled");

  const read = (credential = cookie) => readBalance("?session_id=" + sessionId, credential);
  assert.deepEqual([(await read()).checkout, (await read()).remaining], ["pending", 0]);

  const notify = (type: string, paymentStatus: string, amount: number, validSignature = true) => {
    const payload = JSON.stringify({
      id: "evt_" + randomBytes(8).toString("hex"),
      type,
      data: { object: {
        id: sessionId, mode: "payment", currency: "usd", amount_total: amount,
        payment_status: paymentStatus, client_reference_id: wallet, metadata: captured?.metadata,
      } },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    return webhook(new Request(origin + "/api/billing/webhook", {
      method: "POST", body: payload, headers: { "stripe-signature": validSignature ? header : "invalid" },
    }));
  };

  assert.equal((await notify("checkout.session.completed", "paid", 499, false)).status, 400);
  assert.equal((await notify("checkout.session.completed", "unpaid", 499)).status, 200);
  assert.equal((await notify("checkout.session.completed", "paid", 1)).status, 503);
  assert.equal((await read()).remaining, 0);
  const delivered = await Promise.all([
    notify("checkout.session.completed", "paid", 499),
    notify("checkout.session.async_payment_succeeded", "paid", 499),
  ]);
  assert.deepEqual(delivered.map(response => response.status), [200, 200]);
  const paid = await read();
  assert.equal(paid.checkout, "credited");
  assert.equal(paid.remaining, 5);
  assert.deepEqual([paid.used, paid.purchased], [2, 5]);
  const other = await read(otherCookie);
  assert.deepEqual([other.checkout, other.paid], [null, 0]);
  const resumed = await runAnalysis();
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), demoAnalysis);
  assert.equal(modelCalls, 3);
  const afterSpend = await read();
  assert.deepEqual([afterSpend.paid, afterSpend.used, afterSpend.purchased], [4, 3, 5]);

  const ledger = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const sql = await readFile(new URL("../db/inspect-billing.sql", import.meta.url), "utf8");
    const { rows: [inspection] } = await ledger.query(sql);
    assert.ok(inspection.billing_audit.billing_wallets.recent.some(
      (row: { wallet_ref: string }) => row.wallet_ref === billingRef(wallet),
    ));
    assert.equal(inspection.billing_audit.billing_reservations.active, 0);

    await ledger.query("ALTER TABLE billing_reservations RENAME TO audit_hidden_reservations");
    try {
      const unavailable = await runAnalysis();
      assert.equal(unavailable.status, 503);
      assert.equal(modelCalls, 3);
      assert.ok(logs.some(log => log.event === "[billing.analyze] validation_failed" && log.fields.errorCode === "42P01"));
    } finally {
      await ledger.query("ALTER TABLE audit_hidden_reservations RENAME TO billing_reservations");
    }

    await ledger.query("ALTER TABLE billing_wallets ADD CONSTRAINT audit_reject_charge CHECK (used_analyses < 4) NOT VALID");
    try {
      const failedCharge = await runAnalysis();
      assert.equal(failedCharge.status, 503);
      assert.equal(modelCalls, 4);
      assert.equal((await failedCharge.json()).riskLevel, undefined);
      assert.equal((await read()).paid, 4);
      assert.ok(logs.some(log => log.event === "[billing.analyze] charge_failed" && log.fields.errorCode === "23514"));
      assert.ok(logs.some(log => log.event === "[billing.analyze] analysis_not_charged" && log.fields.released === true));
    } finally {
      await ledger.query("ALTER TABLE billing_wallets DROP CONSTRAINT audit_reject_charge");
    }
  } finally {
    await ledger.end();
  }
});
