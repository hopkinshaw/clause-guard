import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { POST as analyze } from "../app/api/analyze/route";
import { verifyReport } from "../app/api/analyze/report";
import { POST as extract } from "../app/api/extract/route";
import { demoAnalysis, demoContract } from "../lib/demo";
import { quotesMatchContract } from "../lib/analysis";

const originalKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_BASE_URL;
after(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = originalBase;
});

const jsonRequest = (body: unknown, uiLanguage = "en") => new Request("http://localhost/api/analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-UI-Language": uiLanguage },
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

test("analysis recovers from provider output failures while preserving quote verification", async () => {
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
  const run = (body = { contractText: demoContract, role: "Designer", pricing: "$500 fixed", clientContext: "Client is rushing the signature; more pages may be needed." }, uiLanguage?: string) =>
    analyze(jsonRequest(body, uiLanguage));

  try {
    replies.push({ text: JSON.stringify(demoAnalysis) });
    const valid = await run();
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), demoAnalysis);
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].text.format.strict, true);
    assert.equal(requests[0].text.format.type, "json_schema");
    const input = JSON.parse(requests[0].input);
    assert.equal(input.role, "Designer");
    assert.equal(input.pricing, "$500 fixed");
    assert.match(input.clientContext, /more pages/);

    const literalQuote = "甲方应在验收通过后\n  九十日内支付合同价款。";
    const zhContract = "服务合同。".repeat(16) + literalQuote;
    const zhReport = {
      riskLevel: " 高风险 ",
      summary: "  验收时间不明确会拖延回款。  ",
      redFlags: [
        { quote: "「甲方应在验收通过后 九十日内支付合同价款。」", plainEnglish: "客户可能拖着不验收。", suggestedRedline: "甲方应在交付后十四日内支付无争议款项。" },
        { quote: "这是合同里不存在的句子。", plainEnglish: "错误条款", suggestedRedline: "错误建议" },
      ],
      emailReplies: { politeNegotiation: "您好，我们可以讨论付款条款吗？", firmDecline: "  " },
    };
    replies.push({ text: "\x60\x60\x60json\n" + JSON.stringify(zhReport) + "\n\x60\x60\x60" });
    const recovered = await run({ contractText: zhContract, role: "设计师", pricing: "500元", clientContext: "" });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("content-language"), "zh");
    const partial = await recovered.json();
    assert.equal(partial.riskLevel, "HIGH");
    assert.match(partial.summary, /未列入报告/);
    assert.equal(partial.redFlags.length, 1);
    assert.equal(partial.redFlags[0].quote, literalQuote);
    assert.equal(partial.redFlags[0].clauseTitle, "合同条款");
    assert.equal(partial.emailReplies.politeNegotiation, zhReport.emailReplies.politeNegotiation);
    assert.match(partial.emailReplies.upsellPricing, /单独报价/);
    assert.match(partial.emailReplies.firmDecline, /暂时无法/);
    assert.equal(requests.length, 2);
    assert.match(requests[1].instructions, /Report language: natural Chinese/);

    const englishQuote = demoAnalysis.redFlags[0].quote;
    const localizedReport = {
      ...zhReport,
      redFlags: [{ ...zhReport.redFlags[0], quote: englishQuote, clauseTitle: "Payment risk" }],
      emailReplies: { ...zhReport.emailReplies, upsellPricing: "Hello, let's discuss extra scope." },
    };
    const beforeLocalized = requests.length;
    replies.push({ text: JSON.stringify(demoAnalysis) }, { text: JSON.stringify(localizedReport) });
    const localized = await run(undefined, "zh-CN");
    assert.equal(localized.status, 200);
    const localizedBody = await localized.json();
    assert.equal(localizedBody.redFlags[0].quote, englishQuote);
    assert.equal(localizedBody.redFlags[0].clauseTitle, "合同条款");
    assert.match(localizedBody.emailReplies.upsellPricing, /单独报价/);
    assert.equal(requests.length, beforeLocalized + 2);
    assert.match(requests[beforeLocalized].instructions, /Report language: natural Chinese/);

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
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("duplicate action drafts use strategy-specific fallbacks without replacing a distinct draft", () => {
  const draft = {
    ...demoAnalysis,
    summary: "付款期限需要澄清。",
    redFlags: [],
    emailReplies: {
      politeNegotiation: "您好，请修改付款条款。",
      upsellPricing: "你好，\n请修改付款条款！",
      firmDecline: "谢谢您的邀请。按现有条款，我决定婉拒这个项目。",
    },
  };
  const report = verifyReport(JSON.stringify(draft), demoContract, true);
  assert.ok(report);
  assert.match(report.emailReplies.politeNegotiation, /书面方式确认.*付款条件/);
  assert.match(report.emailReplies.upsellPricing, /单独报价.*费用和排期/);
  assert.equal(report.emailReplies.firmDecline, draft.emailReplies.firmDecline);
  assert.equal(new Set(Object.values(report.emailReplies)).size, 3);

  const misplaced = verifyReport(JSON.stringify({
    ...draft,
    emailReplies: { ...draft.emailReplies, politeNegotiation: "", upsellPricing: report.emailReplies.politeNegotiation },
  }), demoContract, true);
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
