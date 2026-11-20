import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { analysisSchema, inputSchema } from "@/lib/analysis";
import { billingAudit, billingErrorCode, billingRef } from "@/lib/billing/audit";
import { billingConfig } from "@/lib/billing/config";
import { networkFromRequest, walletFromRequest } from "@/lib/billing/identity";
import { AnalysisLimit, completeAnalysis, releaseAnalysis, reserveAnalysis } from "@/lib/billing/store";
import { analysisInstructions, verifyReport } from "./report";

export const runtime = "nodejs";
export const maxDuration = 90;

const INITIAL_OUTPUT_TOKENS = 6500;
const TRUNCATION_RETRY_TOKENS = 10_000;
const ANALYSIS_BUDGET_MS = 80_000;
const MIN_RETRY_TIME_MS = 15_000;
const reportFormat = zodTextFormat(analysisSchema, "contract_analysis");

export async function POST(request: Request) {
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 300_000) return Response.json({ error: "Request is too large." }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Please send a valid JSON request." }, { status: 400 });
  }
  const input = inputSchema.safeParse(body);
  if (!input.success) return Response.json({ error: input.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  const audit = billingAudit("analyze");
  const reply = (payload: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(payload, { status, headers: { ...audit.headers, ...headers } });
  if (!process.env.OPENAI_API_KEY) {
    audit.log("error", "blocked", { reason: "model_not_configured" });
    return reply({ error: "Analysis is not configured yet. Add OPENAI_API_KEY to the server environment. You can still explore the sample report." }, 503);
  }

  let config: ReturnType<typeof billingConfig> | undefined;
  let wallet: string | null = null;
  let network: string | null = null;
  let reservation: Awaited<ReturnType<typeof reserveAnalysis>> | undefined;
  const refs = () => ({
    walletRef: billingRef(wallet),
    networkRef: billingRef(network),
    reservationRef: billingRef(reservation?.id),
  });
  try {
    config = billingConfig(request);
    const origin = request.headers.get("origin");
    if (origin && origin !== config.app.origin) {
      audit.log("warn", "blocked", { reason: "origin_mismatch" });
      return reply({ error: "Open analysis from the main ClauseGuard site." }, 403);
    }
    wallet = walletFromRequest(request, config);
    if (!wallet) {
      audit.log("warn", "blocked", { reason: "wallet_cookie_missing_or_invalid" });
      return reply({ error: "Refresh the page to start a credit session.", code: "BILLING_SESSION_REQUIRED" }, 428);
    }
    network = networkFromRequest(request, config);
    reservation = await reserveAnalysis(wallet, network, config);
    audit.log("warn", "authorized", { ...refs(), source: reservation.source, quota: reservation.quota });
  } catch (error) {
    if (error instanceof AnalysisLimit) {
      audit.log("warn", "blocked", { ...refs(), code: error.code, reason: error.reason, quota: error.quota });
      if (error.code === "NO_CREDITS") {
        return reply({
          status: "needs_credits",
          code: "NO_CREDITS",
          remaining: 0,
          message: "You’ve used all your available analyses.",
          checkout: config?.checkoutEnabled ? { endpoint: "/api/billing/checkout", packs: config.packs } : null,
        });
      }
      const details = {
        ANALYSIS_IN_PROGRESS: [409, "An analysis is already in progress. Please wait for it to finish."],
        DAILY_LIMIT: [429, "Today’s analysis limit has been reached. Please try again tomorrow (UTC)."],
        FREE_DAILY_LIMIT: [429, "Today’s free analysis limit has been reached. Buy credits or try again tomorrow (UTC)."],
      } as const;
      const [status, message] = details[error.code];
      return reply({ error: message, code: error.code }, status);
    }
    audit.log("error", "validation_failed", {
      ...refs(), stage: config ? "reserve" : "configuration", errorCode: billingErrorCode(error),
    });
    return reply({ error: "Credit validation is temporarily unavailable." }, 503);
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
    const deadline = performance.now() + ANALYSIS_BUDGET_MS;
    const params = {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      store: false,
      input: JSON.stringify(input.data),
      text: { format: reportFormat },
    };
    let retryReason: "truncated" | "unverifiable" | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (request.signal.aborted || (attempt > 0 && remainingMs < MIN_RETRY_TIME_MS)) break;
      // Read status and refusal before parsing JSON. Truncated output may end mid-field.
      const response = await client.responses.create({
        ...params,
        max_output_tokens: retryReason === "truncated" ? TRUNCATION_RETRY_TOKENS : INITIAL_OUTPUT_TOKENS,
        instructions: retryReason
          ? analysisInstructions + "\n\nRegenerate a complete JSON report. Use at most three of the most material risks and short continuous verbatim quotes. Keep the summary and drafts concise. Preserve every essential protection in each selected replacement clause and write all generated prose in English."
          : analysisInstructions,
      }, { timeout: Math.min(75_000, remainingMs), signal: request.signal });

      const refused = response.output.some(item =>
        item.type === "message" && item.content.some(part => part.type === "refusal"),
      );
      if (refused || response.incomplete_details?.reason === "content_filter") {
        return reply({ error: "The AI could not analyze this text. Try a focused excerpt of the contract." }, 422);
      }
      if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
        retryReason = "truncated";
        continue;
      }
      if (response.status !== "completed") {
        return reply({ error: "The AI service did not complete the analysis. Please try again." }, 502);
      }
      const report = verifyReport(response.output_text, input.data.contractText);
      if (report) {
        if (request.signal.aborted) break;
        const held = reservation;
        try {
          const charged = await completeAnalysis(wallet, held.id);
          audit.log("warn", "charged", {
            ...refs(), source: held.source, ...charged,
            walletFreeRemaining: Math.max(0, (config?.free ?? 0) - charged.walletFreeUsed),
          });
          reservation = undefined;
        } catch (error) {
          audit.log("error", "charge_failed", { ...refs(), source: held.source, errorCode: billingErrorCode(error) });
          return reply({ error: "Could not confirm the analysis credit. Please refresh and check your balance." }, 503);
        }
        return reply(report, 200, { "Content-Language": "en" });
      }
      retryReason = "unverifiable";
    }

    const error = retryReason === "truncated"
      ? "The analysis was cut off. Try a shorter excerpt of the contract."
      : "The AI could not produce a verifiable report. Try again or use a more focused contract excerpt.";
    return reply({ error }, 502);
  } catch (error) {
    if (error instanceof OpenAI.APIError && error.status === 429) return reply({ error: "The AI service is busy or its quota has been reached. Please try again later." }, 429);
    if (error instanceof OpenAI.APIError && error.code === "context_length_exceeded") return reply({ error: "This contract is too long for the configured model. Try a shorter excerpt." }, 413);
    if (error instanceof OpenAI.APIConnectionTimeoutError) return reply({ error: "Analysis timed out. Please try again with a shorter contract." }, 504);
    return reply({ error: "Analysis is temporarily unavailable. Please try again later." }, 502);
  } finally {
    if (reservation) {
      try {
        const released = await releaseAnalysis(wallet, reservation.id);
        audit.log("warn", "analysis_not_charged", { ...refs(), released, aborted: request.signal.aborted });
      } catch (error) {
        audit.log("error", "release_failed", { ...refs(), errorCode: billingErrorCode(error) });
      }
    }
  }
}
