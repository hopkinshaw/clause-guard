import { z } from "zod";

export const MAX_CONTRACT_LENGTH = 60_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const inputSchema = z.object({
  contractText: z.string().trim().min(80, "Please provide at least 80 characters of contract text.").max(MAX_CONTRACT_LENGTH),
  role: z.string().trim().max(120).default(""),
  pricing: z.string().trim().max(120).default(""),
  clientContext: z.string().trim().max(1000).default(""),
}).strict();

export const analysisSchema = z.object({
  riskLevel: z.enum(["HIGH", "MEDIUM", "LOW"]),
  summary: z.string(),
  redFlags: z.array(z.object({
    clauseTitle: z.string(),
    quote: z.string(),
    plainEnglish: z.string(),
    suggestedRedline: z.string(),
  })).max(5),
  emailReplies: z.object({
    politeNegotiation: z.string(),
    upsellPricing: z.string(),
    firmDecline: z.string(),
  }),
});

export type Analysis = z.infer<typeof analysisSchema>;

export function quotesMatchContract(analysis: Analysis, contract: string) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const source = normalize(contract);
  return analysis.redFlags.every(flag => flag.quote.trim().length > 0 && source.includes(normalize(flag.quote)));
}
