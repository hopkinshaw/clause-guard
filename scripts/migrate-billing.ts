import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { postgresOptions } from "../lib/billing/database";

async function migrate() {
  for (const path of [".env.local", ".env"]) {
    if (existsSync(path)) process.loadEnvFile(path);
  }

  const pool = new Pool({
    ...postgresOptions(process.env, true),
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const sql = await readFile(new URL("../db/billing.sql", import.meta.url), "utf8");
    await pool.query(sql);
    console.log("Billing schema is up to date.");
  } finally {
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  // Do not print driver messages or configuration values that may contain credentials.
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const detail = typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? ` (${code})` : "";
  console.error(`Billing migration failed${detail}. Check the Postgres connection and database role.`);
  process.exitCode = 1;
});
