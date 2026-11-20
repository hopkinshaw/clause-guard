import { after, before } from "node:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

export const testDatabase = process.env.TEST_DATABASE_URL;

export function setupBillingDatabase() {
  if (!testDatabase) return;
  const schema = "billing_test_" + randomBytes(6).toString("hex");
  const admin = new Pool({ connectionString: testDatabase });
  let created = false;
  before(async () => {
    const url = new URL(testDatabase);
    url.searchParams.set("options", "-c search_path=" + schema);
    await admin.query("CREATE SCHEMA " + schema);
    created = true;
    const fixture = new Pool({ connectionString: url.href });
    try {
      await fixture.query(await readFile(new URL("../db/billing.sql", import.meta.url), "utf-8"));
    } finally {
      await fixture.end();
    }
    process.env.DATABASE_URL = url.href;
    process.env.APP_URL = "http://localhost:3000";
    process.env.BILLING_COOKIE_SECRET = randomBytes(32).toString("hex");
    delete process.env.FREE_ANALYSIS_CREDITS;
    process.env.FREE_ANALYSIS_DAILY_LIMIT = "100";
    process.env.ANALYSIS_DAILY_LIMIT = "300";
    delete process.env.BILLING_PACKS;
    delete process.env.VERCEL;
  });

  after(async () => {
    try {
      if (created) await admin.query("DROP SCHEMA " + schema + " CASCADE");
    } finally {
      await admin.end();
    }
  });
}
