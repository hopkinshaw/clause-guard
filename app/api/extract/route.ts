import { PDFParse } from "pdf-parse";
import { MAX_CONTRACT_LENGTH, MAX_FILE_BYTES } from "@/lib/analysis";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_FILE_BYTES + 100_000) return Response.json({ error: "Please use a file smaller than 5 MB." }, { status: 413 });
  try {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File) || !/\.(pdf|txt)$/i.test(file.name)) return Response.json({ error: "Please upload a PDF or TXT file." }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: "Please use a file smaller than 5 MB." }, { status: 413 });
    let text: string;
    if (/\.txt$/i.test(file.name)) {
      text = await file.text();
    } else {
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return Response.json({ error: "This file is not a valid PDF." }, { status: 400 });
      const parser = new PDFParse({ data: buffer });
      try {
        const info = await parser.getInfo();
        if (info.total > 100) return Response.json({ error: "Please upload a PDF with 100 pages or fewer." }, { status: 413 });
        text = (await parser.getText({ pageJoiner: "\n" })).text;
      } finally {
        await parser.destroy();
      }
    }
    text = text.replace(/\u0000/g, "").trim();
    if (text.length < 80) return Response.json({ error: "Not enough text found. Scanned PDFs need OCR first; you can also paste the contract text." }, { status: 422 });
    if (text.length > MAX_CONTRACT_LENGTH) return Response.json({ error: "This contract exceeds 60,000 characters. Please upload a shorter excerpt." }, { status: 413 });
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to read this file. It may be damaged or password-protected. Try a TXT file or paste the text." }, { status: 422 });
  }
}
