import { createHash, randomUUID } from "node:crypto";
import { postgresSource } from "./database";

export function billingRef(value: string | null | undefined) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
}

export function billingErrorCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" && /^(?:[A-Z0-9]{5}|E[A-Z_]{3,20})$/.test(code) ? code : null;
}

export function billingAudit(route: "analyze" | "status") {
  const requestId = randomUUID();
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  const context = {
    requestId,
    commit: revision && /^[a-f0-9]{7,64}$/i.test(revision) ? revision.slice(0, 12) : null,
    databaseSource: postgresSource(),
  };
  return {
    headers: { "Cache-Control": "no-store", "X-Billing-Request-Id": requestId },
    log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}) {
      console[level](`[billing.${route}] ${event}`, JSON.stringify({ ...context, ...details }));
    },
  };
}
