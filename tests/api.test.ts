import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { POST as analyze } from "../app/api/analyze/route";
import { POST as extract } from "../app/api/extract/route";
import { demoAnalysis, demoContract } from "../lib/demo";
import { quotesMatchContract } from "../lib/analysis";

const originalKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_BASE_URL;
after(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = originalBase;
});

const jsonRequest = (body: unknown) => new Request("http://localhost/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

test("analysis uses strict structured output and rejects fabricated quotes", async () => {
  let fabricated = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.type, "json_schema");
    const report = structuredClone(demoAnalysis);
    if (fabricated) report.redFlags[0].quote = "This clause does not exist in the contract.";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "resp_test", object: "response", created_at: 1, status: "completed", output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(report), annotations: [] }] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  try {
    const response = await analyze(jsonRequest({ contractText: demoContract, role: "Designer" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), demoAnalysis);
    fabricated = true;
    assert.equal((await analyze(jsonRequest({ contractText: demoContract }))).status, 502);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
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
