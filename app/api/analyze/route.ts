import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { analysisSchema, inputSchema } from "@/lib/analysis";
import { analysisInstructions, requiresChineseReport, verifyReport } from "./report";

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
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "Analysis is not configured yet. Add OPENAI_API_KEY to the server environment. You can still explore the sample report." }, { status: 503 });

  const chineseReport = requiresChineseReport(input.data.contractText, input.data.clientContext, request.headers.get("x-ui-language"));
  const instructions = chineseReport
    ? analysisInstructions + "\n\nReport language: natural Chinese for all generated prose. Keep each quote exactly as it appears in the source."
    : analysisInstructions;
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
          ? instructions + "\n\nRegenerate a complete JSON report. Use at most three of the most material risks and short continuous verbatim quotes. Keep the summary and drafts concise. Preserve every essential protection in each selected replacement clause and use the required language throughout."
          : instructions,
      }, { timeout: Math.min(75_000, remainingMs), signal: request.signal });

      const refused = response.output.some(item =>
        item.type === "message" && item.content.some(part => part.type === "refusal"),
      );
      if (refused || response.incomplete_details?.reason === "content_filter") {
        return Response.json({ error: "The AI could not analyze this text. Try a focused excerpt of the contract." }, { status: 422 });
      }
      if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
        retryReason = "truncated";
        continue;
      }
      if (response.status !== "completed") {
        return Response.json({ error: "The AI service did not complete the analysis. Please try again." }, { status: 502 });
      }
      const report = verifyReport(response.output_text, input.data.contractText, chineseReport);
      if (report) return Response.json(report, { headers: { "Cache-Control": "no-store" } });
      retryReason = "unverifiable";
    }

    const error = retryReason === "truncated"
      ? "The analysis was cut off. Try a shorter excerpt of the contract."
      : "The AI could not produce a verifiable report. Try again or use a more focused contract excerpt.";
    return Response.json({ error }, { status: 502 });
  } catch (error) {
    if (error instanceof OpenAI.APIError && error.status === 429) return Response.json({ error: "The AI service is busy or its quota has been reached. Please try again later." }, { status: 429 });
    if (error instanceof OpenAI.APIError && error.code === "context_length_exceeded") return Response.json({ error: "This contract is too long for the configured model. Try a shorter excerpt." }, { status: 413 });
    if (error instanceof OpenAI.APIConnectionTimeoutError) return Response.json({ error: "Analysis timed out. Please try again with a shorter contract." }, { status: 504 });
    return Response.json({ error: "Analysis is temporarily unavailable. Please try again later." }, { status: 502 });
  }
}
