import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { BillingConfig, Pack } from "./config";
import { postgresOptions } from "./database";

let database: Pool | undefined;
function db() {
  if (!database) {
    database = new Pool({
      ...postgresOptions(),
      max: 3,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 5000,
    });
    database.on("error", () => console.error("An idle billing database connection was lost."));
  }
  return database;
}

async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type CreditSnapshot = {
  freeLimit: number;
  walletFreeUsed: number;
  networkFreeUsed: number | null;
  networkReservations: number | null;
  paidRemaining: number;
  freeRemaining: number;
  remaining: number;
};

export class AnalysisLimit extends Error {
  constructor(
    readonly code: "NO_CREDITS" | "ANALYSIS_IN_PROGRESS" | "DAILY_LIMIT" | "FREE_DAILY_LIMIT",
    readonly reason: string,
    readonly quota: CreditSnapshot,
  ) {
    super(code);
  }
}

const insertWallet = "INSERT INTO billing_wallets (id) VALUES ($1) ON CONFLICT DO NOTHING";

export async function initializeWallet(wallet: string) {
  await db().query(insertWallet, [wallet]);
}

export async function billingStatus(wallet: string, network: string | null, config: BillingConfig, session?: string) {
  const { rows: [row] } = await db().query<{
    free_used: number;
    paid_balance: number;
    network_used: number;
    used_analyses: string;
    purchased_credits: string;
    updated_at: Date | null;
    checkout: "pending" | "credited" | null;
  }>(`
    SELECT COALESCE(w.free_used, 0) AS free_used, COALESCE(w.paid_balance, 0) AS paid_balance,
           COALESCE(n.free_used, 0) AS network_used,
           COALESCE(w.used_analyses, 0) AS used_analyses,
           COALESCE(w.purchased_credits, 0) AS purchased_credits, w.updated_at,
           CASE WHEN p.credited_at IS NOT NULL THEN 'credited' WHEN p.session_id IS NOT NULL THEN 'pending' END AS checkout
    FROM (VALUES (1)) AS anchor(value)
    LEFT JOIN billing_wallets w ON w.id = $1
    LEFT JOIN billing_networks n ON n.id = $2
    LEFT JOIN billing_purchases p ON p.wallet_id = $1 AND p.session_id = $3
  `, [wallet, network, session ?? null]);
  const free = network ? Math.max(0, config.free - Math.max(row.free_used, row.network_used)) : 0;
  return {
    remaining: free + row.paid_balance,
    free,
    paid: row.paid_balance,
    used: Number(row.used_analyses),
    purchased: Number(row.purchased_credits),
    updatedAt: row.updated_at,
    checkout: row.checkout,
  };
}

export async function reserveAnalysis(wallet: string, network: string | null, config: BillingConfig) {
  return transaction(async client => {
    await client.query(insertWallet, [wallet]);
    const { rows: [balance] } = await client.query<{ free_used: number; paid_balance: number; network_free_used: number }>(`
      SELECT w.free_used, w.paid_balance, COALESCE(n.free_used, 0) AS network_free_used
      FROM billing_wallets w
      LEFT JOIN billing_networks n ON n.id = $2
      WHERE w.id = $1 FOR UPDATE OF w
    `, [wallet, network]);
    let networkFreeUsed = network ? balance.network_free_used : null;
    let networkReservations: number | null = null;
    const snapshot = (): CreditSnapshot => {
      const freeRemaining = networkFreeUsed === null ? 0 : Math.max(
        0, config.free - Math.max(balance.free_used, networkFreeUsed + (networkReservations ?? 0)),
      );
      return {
        freeLimit: config.free, walletFreeUsed: balance.free_used, networkFreeUsed, networkReservations,
        paidRemaining: balance.paid_balance, freeRemaining, remaining: freeRemaining + balance.paid_balance,
      };
    };
    await client.query("DELETE FROM billing_reservations WHERE wallet_id = $1 AND expires_at <= now()", [wallet]);
    if ((await client.query("SELECT 1 FROM billing_reservations WHERE wallet_id = $1", [wallet])).rowCount) {
      throw new AnalysisLimit("ANALYSIS_IN_PROGRESS", "wallet_reservation_active", snapshot());
    }

    let freeNetwork: string | null = null;
    if (balance.paid_balance === 0 && network && balance.free_used < config.free) {
      await client.query("INSERT INTO billing_networks (id) VALUES ($1) ON CONFLICT DO NOTHING", [network]);
      const { rows: [bucket] } = await client.query<{ free_used: number }>(
        "SELECT free_used FROM billing_networks WHERE id = $1 FOR UPDATE", [network],
      );
      const { rows: [active] } = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM billing_reservations WHERE network_id = $1 AND expires_at > now()", [network],
      );
      networkFreeUsed = bucket.free_used;
      networkReservations = active.count;
      if (bucket.free_used + active.count < config.free) freeNetwork = network;
    }
    const quota = snapshot();
    if (!freeNetwork && balance.paid_balance === 0) {
      const reason = config.free === 0 ? "free_disabled"
        : !network ? "network_unavailable"
        : balance.free_used >= config.free ? "wallet_free_limit"
        : (networkFreeUsed ?? 0) >= config.free ? "network_free_limit"
        : "network_reservations_active";
      throw new AnalysisLimit("NO_CREDITS", reason, quota);
    }

    const today = "(now() AT TIME ZONE 'UTC')::date";
    await client.query(`INSERT INTO billing_daily (day) VALUES (${today}) ON CONFLICT DO NOTHING`);
    const { rows: [daily] } = await client.query<{ attempts: number; free_attempts: number }>(
      `SELECT attempts, free_attempts FROM billing_daily WHERE day = ${today} FOR UPDATE`,
    );
    if (daily.attempts >= config.daily) throw new AnalysisLimit("DAILY_LIMIT", "daily_limit", quota);
    if (freeNetwork && daily.free_attempts >= config.freeDaily) {
      throw new AnalysisLimit("FREE_DAILY_LIMIT", "free_daily_limit", quota);
    }

    const id = randomUUID();
    await client.query(`
      INSERT INTO billing_reservations (wallet_id, id, network_id, expires_at)
      VALUES ($1, $2, $3, now() + interval '3 minutes')
    `, [wallet, id, freeNetwork]);
    await client.query(
      `UPDATE billing_daily SET attempts = attempts + 1, free_attempts = free_attempts + $1 WHERE day = ${today}`,
      [freeNetwork ? 1 : 0],
    );
    return { id, source: freeNetwork ? "free" as const : "paid" as const, quota };
  });
}

export async function completeAnalysis(wallet: string, id: string) {
  return transaction(async client => {
    await client.query("SELECT id FROM billing_wallets WHERE id = $1 FOR UPDATE", [wallet]);
    const { rows: [hold] } = await client.query<{ network_id: string | null }>(
      "SELECT network_id FROM billing_reservations WHERE wallet_id = $1 AND id = $2 AND expires_at > now() FOR UPDATE", [wallet, id],
    );
    if (!hold) throw new Error("Analysis reservation is no longer valid");
    if (hold.network_id) {
      const network = await client.query("UPDATE billing_networks SET free_used = free_used + 1 WHERE id = $1", [hold.network_id]);
      if (network.rowCount !== 1) throw new Error("Reserved free network no longer exists");
    }
    const walletUpdate = hold.network_id
      ? "UPDATE billing_wallets SET free_used = free_used + 1, used_analyses = used_analyses + 1, updated_at = now() WHERE id = $1"
      : "UPDATE billing_wallets SET paid_balance = paid_balance - 1, used_analyses = used_analyses + 1, updated_at = now() WHERE id = $1 AND paid_balance > 0";
    const { rows: [charged] } = await client.query<{ free_used: number; paid_balance: number; used_analyses: string }>(
      walletUpdate + " RETURNING free_used, paid_balance, used_analyses", [wallet],
    );
    if (!charged) throw new Error("Reserved credit is no longer available");
    await client.query("DELETE FROM billing_reservations WHERE id = $1", [id]);
    return { walletFreeUsed: charged.free_used, paidRemaining: charged.paid_balance, used: Number(charged.used_analyses) };
  });
}

export async function releaseAnalysis(wallet: string, id: string) {
  const released = await db().query("DELETE FROM billing_reservations WHERE wallet_id = $1 AND id = $2", [wallet, id]);
  return released.rowCount === 1;
}

export async function savePurchase(session: string, wallet: string, pack: Pack) {
  await transaction(async client => {
    await client.query(insertWallet, [wallet]);
    await client.query(
      "INSERT INTO billing_purchases (session_id, wallet_id, pack_id, credits, amount) VALUES ($1, $2, $3, $4, $5)",
      [session, wallet, pack.id, pack.credits, pack.amount],
    );
  });
}

export async function creditPurchase(session: string, wallet: string, packId: string, amount: number) {
  const values = [session, wallet, packId, amount];
  const credited = await db().query(`
    WITH purchase AS (
      UPDATE billing_purchases SET credited_at = now()
      WHERE session_id = $1 AND wallet_id = $2 AND pack_id = $3 AND amount = $4 AND credited_at IS NULL
      RETURNING wallet_id, credits
    )
    UPDATE billing_wallets w
    SET paid_balance = w.paid_balance + p.credits,
        purchased_credits = w.purchased_credits + p.credits,
        updated_at = now()
    FROM purchase p WHERE w.id = p.wallet_id
  `, values);
  if (credited.rowCount === 1) return true;

  const existing = await db().query(`
    SELECT 1 FROM billing_purchases
    WHERE session_id = $1 AND wallet_id = $2 AND pack_id = $3 AND amount = $4 AND credited_at IS NOT NULL
  `, values);
  return existing.rowCount === 1;
}
