"use client";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ShieldCheck, ArrowUpRight, Upload, FileText, Check, Copy, Sparkles, LockKeyhole, ChevronDown, ChevronRight, AlertTriangle, X, LoaderCircle, CheckCheck, BriefcaseBusiness, ScanLine, MessageSquareText } from "lucide-react";
import { analysisSchema, MAX_FILE_BYTES, MAX_CONTRACT_LENGTH, type Analysis } from "@/lib/analysis";
import { demoAnalysis, demoContract } from "@/lib/demo";
import { BillingPanel, useBilling } from "./billing-panel";

const replyTabs = [
  { key: "politeNegotiation", label: "Negotiate", caption: "Ask for specific changes before signing." },
  { key: "upsellPricing", label: "Adjust pricing", caption: "Quote separately for extra work or rights." },
  { key: "firmDecline", label: "Walk away", caption: "Decline the current terms professionally." },
] as const;

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true); setFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2200);
    } catch { setFailed(true); }
  }
  return <span className="copy-control">
    <button type="button" className="copy-button" onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied!" : label}
    </button>
    <span className="sr-only" role="status">{copied ? "Copied to clipboard" : ""}</span>
    {failed && <span className="copy-failed" role="alert">Select the text to copy manually.</span>}
  </span>;
}

export default function Home() {
  const billing = useBilling();
  const [text, setText] = useState("");
  const [role, setRole] = useState("");
  const [pricing, setPricing] = useState("");
  const [context, setContext] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<Analysis>(demoAnalysis);
  const [isDemo, setIsDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<(typeof replyTabs)[number]["key"]>("politeNegotiation");
  const fileInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);

  async function upload(file?: File) {
    if (!file || busy || extracting) return;
    setError("");
    if (!/\.(pdf|txt)$/i.test(file.name)) { setError("Please choose a PDF or TXT file."); return; }
    if (file.size > MAX_FILE_BYTES) { setError("Please choose a file smaller than 5 MB."); return; }
    setExtracting(true);
    try {
      const form = new FormData(); form.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to read this file.");
      setText(data.text); setFileName(file.name);
    } catch (err) { setError(err instanceof Error ? err.message : "File upload failed. Please try again."); }
    finally { setExtracting(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  function loadSample() {
    setText(demoContract); setRole("Designer"); setPricing("$2,400 fixed"); setContext("Said it’s just their standard contractor agreement."); setFileName(""); setError("");
    setReport(demoAnalysis); setIsDemo(true);
  }
  async function analyze(event: React.FormEvent) {
    event.preventDefault();
    if (busy || extracting || text.trim().length < 80) return;
    if (!billing.balance?.remaining) {
      document.getElementById("analysis-credits")?.scrollIntoView({ block: "nearest" });
      return;
    }
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractText: text, role, pricing, clientContext: context }),
        signal: AbortSignal.timeout(100_000),
      });
      const data = await res.json().catch(() => null);
      if (data?.status === "needs_credits" && data.code === "NO_CREDITS") {
        document.getElementById("analysis-credits")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      if (!res.ok) {
        setError(res.status === 428
          ? "Your credit session could not be found. Check your balance before trying again."
          : res.status === 504
            ? "Analysis timed out. Your contract is still here. Please try again."
            : typeof data?.error === "string" ? data.error : "Analysis is temporarily unavailable. Please try again.");
        return;
      }
      const result = analysisSchema.safeParse(data);
      if (!result.success) {
        setError("The analysis could not be read. Please try again.");
        return;
      }
      setReport(result.data); setIsDemo(false);
      results.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setError(err instanceof DOMException && err.name === "TimeoutError"
        ? "Analysis timed out. Your contract is still here. Please try again."
        : "Could not reach the analysis service. Check your connection and try again.");
    } finally {
      await billing.refresh();
      setBusy(false);
    }
  }

  const activeReply = replyTabs.find(item => item.key === tab);

  return <div className="min-h-screen">
    <header className="site-header"><div className="header-inner"><a className="brand" href="/" aria-label="ClauseGuard home"><span className="brand-icon"><ShieldCheck size={23} strokeWidth={1.8} /></span>Clause<span className="brand-light">Guard</span><span className="beta">BETA</span></a><div className="header-note"><span className="header-line" />Independent work. Better protected.</div><a className="header-link" href="#how-it-works">How it works <ArrowUpRight size={15} /></a></div></header>
    <main className="page-shell">
      <section className="hero"><div className="eyebrow"><span /> YOUR CONTRACT, DECODED</div><h1>Your contract. <span>Your call.</span></h1><p>Spot the red flags before you sign.<br className="mobile-break" /> Turn tricky contract terms into a confident reply.</p><div className="hero-benefits"><span><CheckCheck size={15} /> Built for freelancers</span><span><LockKeyhole size={14} /> No account needed</span><span><Sparkles size={14} /> Plain language, always</span></div></section>
      <div className="workspace">
        <aside className="input-panel"><form onSubmit={analyze}>
          <div className="panel-heading"><span className="section-icon"><FileText size={19} /></span><div><h2>Your contract</h2><p>A little clarity before a big commitment.</p></div></div>
          <button className={`upload-zone ${dragging ? "dragging" : ""}`} type="button" disabled={busy || extracting} onClick={() => fileInput.current?.click()} onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files[0]); }}>
            <span className="upload-icon">{extracting ? <LoaderCircle size={23} className="animate-spin" /> : <Upload size={23} />}</span><strong>{extracting ? "Reading your contract…" : "Drop your contract here"}</strong><span>or <b>browse files</b></span><small>PDF or TXT · up to 5 MB</small>
          </button>
          <input ref={fileInput} className="sr-only" type="file" accept=".pdf,.txt" aria-label="Upload contract file" onChange={(e: ChangeEvent<HTMLInputElement>) => void upload(e.target.files?.[0])} disabled={busy || extracting} />
          {fileName && <div className="file-chip"><FileText size={14} /><span>{fileName}</span><button type="button" aria-label="Remove uploaded file" disabled={busy || extracting} onClick={() => { setFileName(""); setText(""); }}><X size={14} /></button></div>}
          <div className="separator"><span />or paste your text<span /></div>
          <label className="sr-only" htmlFor="contract">Contract text</label><textarea id="contract" className="contract-text" placeholder={"Paste your contract here…\n\nThe fine print is our favorite part."} value={text} onChange={e => { setText(e.target.value); setFileName(""); }} maxLength={MAX_CONTRACT_LENGTH} minLength={80} required disabled={busy || extracting} />
          <div className="text-meta"><span>{text.length.toLocaleString()} / 60,000 characters</span><button type="button" onClick={loadSample} disabled={busy || extracting}>Try a sample</button></div>
          <div className="context-heading"><BriefcaseBusiness size={16} /><h3>Add some context</h3><span>OPTIONAL</span></div>
          <fieldset disabled={busy || extracting} className="context-fields"><div className="two-fields"><div><label htmlFor="role">Your role</label><div className="select-wrap"><select id="role" value={role} onChange={e => setRole(e.target.value)}><option value="">Select your role</option><option>Designer</option><option>Video Editor</option><option>Developer</option><option>Writer</option><option>Consultant</option><option>Other freelancer</option></select><ChevronDown size={14} /></div></div><div><label htmlFor="pricing">Project rate</label><input id="pricing" placeholder="e.g. $40/hr" value={pricing} onChange={e => setPricing(e.target.value)} maxLength={120} /></div></div><label htmlFor="context">Anything we should know?</label><textarea id="context" className="context-text" placeholder={'e.g. “They said it’s just a standard NDA.”'} value={context} onChange={e => setContext(e.target.value)} maxLength={1000} /></fieldset>
          {error && <div className="error-message" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
          <button className="analyze-button" type="submit" disabled={busy || extracting || !billing.balance?.remaining || text.trim().length < 80}>{busy ? <LoaderCircle size={18} className="animate-spin" /> : <ScanLine size={19} />}{busy ? "Reviewing the fine print…" : "Analyze my contract"}</button>
          <p className="privacy-note"><LockKeyhole size={12} /> We analyze your contract only when you click Analyze my contract. We don’t store the contract text.</p>
          <BillingPanel billing={billing} disabled={busy || extracting} />
        </form></aside>
        <section
          className={`results-panel ${busy ? "is-loading" : ""}`}
          ref={results}
          aria-busy={busy}
          aria-label="Contract analysis"
        >
          <div className="result-toolbar">
            <div className="result-title">
              <span className="section-icon"><ShieldCheck size={19} /></span>
              <h2>Your contract, in plain language</h2>
            </div>
            <span className={isDemo ? "sample-badge" : "live-badge"}>{isDemo ? "SAMPLE REPORT" : "YOUR REPORT"}</span>
          </div>
          <p className="sample-banner">
            <ShieldCheck size={15} />
            <strong className="text-slate-700">For reference only. This is not formal legal advice.</strong>
          </p>
          {isDemo && <div className="sample-banner"><Sparkles size={15} /><span>A sneak peek: a startup’s “standard” contractor agreement.</span></div>}
          <div className={`risk-summary risk-${report.riskLevel.toLowerCase()}`}>
            <div className="risk-heading">
              <span className="risk-badge">
                <AlertTriangle size={14} />
                {report.riskLevel} RISK
              </span>
              <span>THE BIG PICTURE</span>
            </div>
            <h3>{report.summary}</h3>
            <p>{{
              HIGH: "A few changes now could save you a lot later.",
              MEDIUM: "Worth a conversation before you commit.",
              LOW: "Review the details and confirm the scope before signing.",
            }[report.riskLevel]}</p>
          </div>
          <div className="section-heading">
            <h3><AlertTriangle size={17} /> The clauses to look at twice</h3>
            <span>{report.redFlags.length} flagged</span>
          </div>
          <div className="flags">
            {report.redFlags.length === 0 && <p className="empty-flags">
              No specific risky clauses were identified. Check the summary for missing information and review the full agreement before signing.
            </p>}
            {report.redFlags.map((flag, i) => (
              <details className="flag-card" key={`${flag.clauseTitle}-${i}`} open={i === 0 ? true : undefined}>
                <summary>
                  <span className="flag-number">{String(i + 1).padStart(2, "0")}</span>
                  <span>{flag.clauseTitle}</span>
                  <ChevronDown size={16} className="flag-chevron" />
                </summary>
                <div className="flag-content">
                  <blockquote>“{flag.quote}”</blockquote>
                  <div className="explanation">
                    <span>WHAT THIS MEANS FOR YOU</span>
                    <p>{flag.plainEnglish}</p>
                  </div>
                  <div className="redline">
                    <div>
                      <span><Check size={13} /> A FAIRER VERSION</span>
                      <CopyButton text={flag.suggestedRedline} />
                    </div>
                    <p>{flag.suggestedRedline}</p>
                  </div>
                </div>
              </details>
            ))}
          </div>
          <div className="reply-section">
            <div className="section-heading">
              <h3><MessageSquareText size={18} /> Your next move, already written</h3>
              <span>READY TO SEND</span>
            </div>
            <div className="reply-tabs" role="tablist" aria-label="Email reply strategy">
              {replyTabs.map(item => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item.key}
                  aria-controls="reply-content"
                  id={`tab-${item.key}`}
                  key={item.key}
                  className={tab === item.key ? "active" : ""}
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="email-card" id="reply-content" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              <div className="email-heading">
                <span>{activeReply?.caption}</span>
                <CopyButton text={report.emailReplies[tab]} label="Copy email" />
              </div>
              <p>{report.emailReplies[tab]}</p>
            </div>
          </div>
          <p className="report-footnote"><ShieldCheck size={14} /> A second set of eyes. The final call is always yours.</p>
        </section>
      </div>
      <section id="how-it-works" className="how-it-works"><div><span><Upload size={18} /></span><p><strong>Drop in the fine print</strong><br />Upload a contract or paste the text.</p></div><ChevronRight size={17} className="step-chevron" /><div><span><ScanLine size={18} /></span><p><strong>See what’s at stake</strong><br />Understand the risks, minus the jargon.</p></div><ChevronRight size={17} className="step-chevron" /><div><span><MessageSquareText size={18} /></span><p><strong>Find the right words</strong><br />Copy a reply. Start the conversation.</p></div></section>
    </main>
    <footer className="site-footer"><div><a className="footer-brand" href="/"><ShieldCheck size={17} />ClauseGuard</a><span>Made for the independently minded.</span></div><p>Disclaimer: ClauseGuard helps freelancers identify contract risks and offers suggested wording for reference. This does not constitute formal legal advice.</p></footer>
  </div>;
}
