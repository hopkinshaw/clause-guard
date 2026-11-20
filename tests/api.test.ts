import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { POST as analyze } from "../app/api/analyze/route";
import { verifyReport } from "../app/api/analyze/report";
import { GET as creditStatus } from "../app/api/billing/status/route";
import { setupBillingDatabase, testDatabase } from "./billing-db";
import { billingConfig } from "../lib/billing/config";
import { walletFromRequest } from "../lib/billing/identity";
import { creditPurchase, savePurchase } from "../lib/billing/store";

import { POST as extract } from "../app/api/extract/route";
import { demoAnalysis, demoContract } from "../lib/demo";
import { quotesMatchContract } from "../lib/analysis";

setupBillingDatabase();

const originalKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_BASE_URL;
after(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = originalBase;
});

const jsonRequest = (body: unknown) => new Request("http://localhost/api/analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const fileRequest = (name: string, text: string | Uint8Array) => {
  const form = new FormData();
  form.append("file", new File([typeof text === "string" ? text : new Uint8Array(text)], name));
  return new Request("http://localhost/api/extract", { method: "POST", body: form });
};

test("analysis rejects malformed JSON and short contracts before calling OpenAI", async () => {
  assert.equal((await analyze(new Request("http://localhost/api/analyze", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await analyze(jsonRequest({ contractText: "short" }))).status, 400);
  assert.equal((await analyze(jsonRequest({ contractText: "a".repeat(60_001) }))).status, 400);
});

test("analysis reports missing configuration without returning the sample as real output", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await analyze(jsonRequest({ contractText: demoContract }));
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error.includes("OPENAI_API_KEY"));
});

test("analysis recovers from provider output failures while preserving quote verification", { skip: !testDatabase }, async () => {
  type ProviderReply = { text: string; status?: "completed" | "incomplete"; reason?: string; refusal?: boolean };
  const replies: ProviderReply[] = [];
  const requests: { store: boolean; text: { format: { strict: boolean; type: string } }; input: string; max_output_tokens: number; instructions: string }[] = [];

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const reply = replies.shift();
    if (!reply) { res.writeHead(500).end(); return; }
    const content = reply.refusal
      ? { type: "refusal", refusal: "Cannot analyze this input." }
      : { type: "output_text", text: reply.text, annotations: [] };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: reply.status ?? "completed",
      incomplete_details: reply.reason ? { reason: reply.reason } : null,
      output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [content] }],
    }));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  const bootstrap = await creditStatus(new Request("http://localhost:3000/api/billing/status"));
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.equal(bootstrap.status, 200);
  assert.ok(cookie);
  const wallet = walletFromRequest(new Request("http://localhost:3000", { headers: { cookie } }), billingConfig());
  assert.ok(wallet);
  const pack = { id: "test-report-fixture", credits: 18, amount: 499 };
  await savePurchase("cs_test_report_fixture", wallet, pack);
  assert.equal(await creditPurchase("cs_test_report_fixture", wallet, pack.id, pack.amount), true);
  const readCredits = () => creditStatus(new Request("http://localhost:3000/api/billing/status", {
    headers: { cookie },
  })).then(response => response.json());
  const run = (body = { contractText: demoContract, role: "Designer", pricing: "$500 fixed", clientContext: "Client is rushing the signature; more pages may be needed." }) =>
    analyze(new Request(jsonRequest(body), { headers: { "Content-Type": "application/json", cookie } }));

  try {
    replies.push({ text: JSON.stringify(demoAnalysis) });
    const valid = await run();
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), demoAnalysis);
    const afterSuccess = await readCredits();
    assert.deepEqual([afterSuccess.remaining, afterSuccess.used], [19, 1]);
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].text.format.strict, true);
    assert.equal(requests[0].text.format.type, "json_schema");
    const input = JSON.parse(requests[0].input);
    assert.equal(input.role, "Designer");
    assert.equal(input.pricing, "$500 fixed");
    assert.match(input.clientContext, /more pages/);

    const literalQuote = "El cliente pagará dentro de los noventa días\n  siguientes a la aceptación del trabajo.";
    const foreignContract = "Contrato de prestación de servicios. " + literalQuote;
    // Simulate the provider returning a non-Latin character in a generated field.
    const wrongScript = String.fromCodePoint(0x0410);
    const draft = {
      riskLevel: " high ",
      summary: "  An undefined acceptance deadline could delay payment.  ",
      redFlags: [
        { quote: "“El cliente pagará dentro de los noventa días siguientes a la aceptación del trabajo.”", plainEnglish: "The client can delay acceptance.", suggestedRedline: "The client shall pay undisputed amounts within fourteen days of delivery." },
        { quote: "This sentence is not in the contract.", plainEnglish: "Unfounded risk.", suggestedRedline: "Unfounded suggestion." },
      ],
      emailReplies: { politeNegotiation: "Hello, could we review the payment terms?", upsellPricing: wrongScript, firmDecline: "  " },
    };
    const foreignInput = { contractText: foreignContract, role: "Designer", pricing: "500 EUR", clientContext: "" };
    replies.push({ text: "\x60\x60\x60json\n" + JSON.stringify(draft) + "\n\x60\x60\x60" });
    const recovered = await run(foreignInput);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("content-language"), "en");
    const partial = await recovered.json();
    assert.equal(partial.riskLevel, "HIGH");
    assert.match(partial.summary, /Some findings were omitted/);
    assert.equal(partial.redFlags.length, 1);
    assert.equal(partial.redFlags[0].quote, literalQuote);
    assert.equal(partial.redFlags[0].clauseTitle, "Contract clause");
    assert.equal(partial.emailReplies.politeNegotiation, draft.emailReplies.politeNegotiation);
    assert.match(partial.emailReplies.upsellPricing, /separate quote/);
    assert.match(partial.emailReplies.firmDecline, /won't be moving forward/);
    assert.equal(requests.length, 2);
    assert.match(requests[1].instructions, /in clear English regardless of the input language/);

    const beforeLanguageRetry = requests.length;
    replies.push(
      { text: JSON.stringify({ ...draft, summary: "Payment risk " + wrongScript }) },
      { text: JSON.stringify(draft) },
    );
    const languageRetry = await run(foreignInput);
    assert.equal(languageRetry.status, 200);
    assert.equal((await languageRetry.json()).redFlags[0].quote, literalQuote);
    assert.equal(requests.length, beforeLanguageRetry + 2);
    assert.match(requests[beforeLanguageRetry + 1].instructions, /write all generated prose in English/);

    const beforeTruncation = requests.length;
    replies.push(
      { text: '{"summary":', status: "incomplete", reason: "max_output_tokens" },
      { text: JSON.stringify(demoAnalysis) },
    );
    const retried = await run();
    assert.equal(retried.status, 200);
    const compactRetry = requests[beforeTruncation + 1];
    assert.ok(compactRetry.max_output_tokens > requests[beforeTruncation].max_output_tokens);
    assert.match(compactRetry.instructions, /at most three/);

    const allFabricated = { ...demoAnalysis, redFlags: [{ ...demoAnalysis.redFlags[0], quote: "This clause does not exist in the contract." }] };
    replies.push({ text: JSON.stringify(allFabricated) }, { text: JSON.stringify(allFabricated) });
    const rejected = await run();
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error, /verifiable/);

    replies.push({ text: "{invalid", refusal: true });
    assert.equal((await run()).status, 422);
    assert.equal(requests.length, 9);
    assert.equal(replies.length, 0);
    const afterFailures = await readCredits();
    assert.deepEqual([afterFailures.remaining, afterFailures.used], [16, 4]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("duplicate action drafts use strategy-specific fallbacks without replacing a distinct draft", () => {
  const draft = {
    ...demoAnalysis,
    summary: "The payment deadline needs clarification.",
    redFlags: [],
    emailReplies: {
      politeNegotiation: "Hello, please revise the payment terms.",
      upsellPricing: "Hi,\nPlease revise the payment terms!",
      firmDecline: "Thank you for the offer. I am declining the agreement on its current terms.",
    },
  };
  const report = verifyReport(JSON.stringify(draft), demoContract);
  assert.ok(report);
  assert.match(report.emailReplies.politeNegotiation, /confirm the scope and payment terms in writing/);
  assert.match(report.emailReplies.upsellPricing, /separate quote.*scope, cost, and timing/);
  assert.equal(report.emailReplies.firmDecline, draft.emailReplies.firmDecline);
  assert.equal(new Set(Object.values(report.emailReplies)).size, 3);

  const misplaced = verifyReport(JSON.stringify({
    ...draft,
    emailReplies: { ...draft.emailReplies, politeNegotiation: "", upsellPricing: report.emailReplies.politeNegotiation },
  }), demoContract);
  assert.deepEqual(misplaced?.emailReplies, report.emailReplies);
});

test("quote matching tolerates whitespace while requiring real excerpts", () => {
  assert.ok(quotesMatchContract(demoAnalysis, demoContract.replaceAll(" ", "  ")));
  assert.equal(quotesMatchContract(demoAnalysis, "Unrelated contract"), false);
});

test("TXT extraction preserves contract text and rejects unsupported, empty and fake PDF files", async () => {
  const response = await extract(fileRequest("contract.txt", demoContract));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, demoContract);
  assert.equal((await extract(fileRequest("contract.docx", demoContract))).status, 400);
  assert.equal((await extract(fileRequest("empty.txt", ""))).status, 422);
  assert.equal((await extract(fileRequest("fake.pdf", demoContract))).status, 400);
  assert.equal((await extract(fileRequest("huge.txt", "x".repeat(5 * 1024 * 1024 + 1)))).status, 413);
});

test("real text PDF is extracted by the parser", async () => {
  // A complete single-page PDF generated in memory; no fixture or scratch file is needed.
  const text = "Independent contractor agreement. Payment due within 14 days. Two revision rounds included. Ownership transfers after full payment.";
  const stream = `BT /F1 10 Tf 20 200 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const response = await extract(fileRequest("contract.pdf", pdf));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).text.includes("Payment due within 14 days"));
});
