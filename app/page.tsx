"use client";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ShieldCheck, ArrowUpRight, Upload, FileText, Check, Copy, Sparkles, LockKeyhole, ChevronDown, ChevronRight, AlertTriangle, X, LoaderCircle, CheckCheck, BriefcaseBusiness, ScanLine, MessageSquareText } from "lucide-react";
import { analysisSchema, MAX_FILE_BYTES, MAX_CONTRACT_LENGTH, type Analysis } from "@/lib/analysis";
import { demoAnalysis, demoContract } from "@/lib/demo";

const replyTabs = [
  { key: "politeNegotiation", label: "Negotiate", caption: "Ask for specific changes before signing.", zh: ["协商条款", "签署前提出具体修改。"] },
  { key: "upsellPricing", label: "Adjust pricing", caption: "Quote separately for extra work or rights.", zh: ["调整报价", "新增工作或扩大授权可另行报价。"] },
  { key: "firmDecline", label: "Walk away", caption: "Decline the current terms professionally.", zh: ["礼貌婉拒", "清楚说明决定，保持专业。"] },
] as const;

function CopyButton({ text, label, chinese }: { text: string; label?: string; chinese: boolean }) {
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
      {copied ? (chinese ? "已复制" : "Copied!") : label ?? (chinese ? "复制" : "Copy")}
    </button>
    <span className="sr-only" role="status">{copied ? (chinese ? "已复制到剪贴板" : "Copied to clipboard") : ""}</span>
    {failed && <span className="copy-failed" role="alert">{chinese ? "请选择文本并手动复制。" : "Select the text to copy manually."}</span>}
  </span>;
}

export default function Home() {
  const [text, setText] = useState("");
  const [role, setRole] = useState("");
  const [pricing, setPricing] = useState("");
  const [context, setContext] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<Analysis>(demoAnalysis);
  const [isDemo, setIsDemo] = useState(true);
  const [chineseReport, setChineseReport] = useState(false);
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
    setReport(demoAnalysis); setIsDemo(true); setChineseReport(false);
  }
  async function analyze(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-UI-Language": document.documentElement.lang },
        body: JSON.stringify({ contractText: text, role, pricing, clientContext: context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed. Please try again.");
      setReport(analysisSchema.parse(data)); setIsDemo(false);
      setChineseReport(res.headers.get("content-language") === "zh");
      results.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) { setError(err instanceof Error ? err.message : "Connection failed. Please try again."); }
    finally { setBusy(false); }
  }

  const reportLabel = (en: string, zh: string) => chineseReport ? zh : en;
  const activeReply = replyTabs.find(item => item.key === tab);

  return <div className="min-h-screen">
    <header className="site-header"><div className="header-inner"><a className="brand" href="/" aria-label="ClauseGuard home"><span className="brand-icon"><ShieldCheck size={23} strokeWidth={1.8} /></span>Clause<span className="brand-light">Guard</span><span className="beta">BETA</span></a><div className="header-note"><span className="header-line" />Independent work. Better protected.</div><a className="header-link" href="#how-it-works">How it works <ArrowUpRight size={15} /></a></div></header>
    <main className="page-shell">
      <section className="hero"><div className="eyebrow"><span /> YOUR CONTRACT, DECODED</div><h1>你的合同，<span>你做主。</span></h1><p>Spot the red flags before you sign.<br className="mobile-break" /> Turn tricky contract terms into a confident reply.</p><div className="hero-benefits"><span><CheckCheck size={15} /> Built for freelancers</span><span><LockKeyhole size={14} /> No account needed</span><span><Sparkles size={14} /> {reportLabel("Plain language, always", "始终用通俗语言")}</span></div></section>
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
          <button className="analyze-button" type="submit" disabled={busy || extracting || text.trim().length < 80}>{busy ? <LoaderCircle size={18} className="animate-spin" /> : <ScanLine size={19} />}{busy ? "Reviewing the fine print…" : "Analyze my contract"}</button>
          <p className="privacy-note"><LockKeyhole size={12} /> 仅在点击分析时处理您的合同内容，且不会存储合同文本。</p>
        </form></aside>
        <section
          className={`results-panel ${busy ? "is-loading" : ""}`}
          ref={results}
          aria-busy={busy}
          lang={chineseReport ? "zh" : "en"}
          aria-label={reportLabel("Contract analysis", "合同分析")}
        >
          <div className="result-toolbar">
            <div className="result-title">
              <span className="section-icon"><ShieldCheck size={19} /></span>
              <h2>{reportLabel("Your contract, in plain language", "用通俗语言读懂合同")}</h2>
            </div>
            <span className={isDemo ? "sample-badge" : "live-badge"}>{isDemo ? "SAMPLE REPORT" : reportLabel("YOUR REPORT", "你的报告")}</span>
          </div>
          <p className="sample-banner">
            <ShieldCheck size={15} />
            <strong className="text-slate-700">{reportLabel("For reference only. This is not formal legal advice.", "仅供参考，不构成正式法律建议。")}</strong>
          </p>
          {isDemo && <div className="sample-banner"><Sparkles size={15} /><span>A sneak peek: a startup’s “standard” contractor agreement.</span></div>}
          <div className={`risk-summary risk-${report.riskLevel.toLowerCase()}`}>
            <div className="risk-heading">
              <span className="risk-badge">
                <AlertTriangle size={14} />
                {reportLabel(`${report.riskLevel} RISK`, { HIGH: "高风险", MEDIUM: "中风险", LOW: "低风险" }[report.riskLevel])}
              </span>
              <span>{reportLabel("THE BIG PICTURE", "风险概览")}</span>
            </div>
            <h3>{report.summary}</h3>
            <p>{{
              HIGH: reportLabel("A few changes now could save you a lot later.", "建议签署前先处理关键风险。"),
              MEDIUM: reportLabel("Worth a conversation before you commit.", "建议在承诺前与客户确认要点。"),
              LOW: reportLabel("Review the details and confirm the scope before signing.", "签署前请核对细节并确认项目范围。"),
            }[report.riskLevel]}</p>
          </div>
          <div className="section-heading">
            <h3><AlertTriangle size={17} /> {reportLabel("The clauses to look at twice", "值得重点核对的条款")}</h3>
            <span>{reportLabel(`${report.redFlags.length} flagged`, `标出 ${report.redFlags.length} 条`)}</span>
          </div>
          <div className="flags">
            {report.redFlags.length === 0 && <p className="empty-flags">{reportLabel(
              "No specific risky clauses were identified. Check the summary for missing information and review the full agreement before signing.",
              "未标出具体风险条款。签署前请查看摘要中的缺失信息，并核对合同全文。",
            )}</p>}
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
                    <span>{reportLabel("WHAT THIS MEANS FOR YOU", "这对你意味着什么")}</span>
                    <p>{flag.plainEnglish}</p>
                  </div>
                  <div className="redline">
                    <div>
                      <span><Check size={13} /> {reportLabel("A FAIRER VERSION", "更公平的版本")}</span>
                      <CopyButton text={flag.suggestedRedline} chinese={chineseReport} />
                    </div>
                    <p>{flag.suggestedRedline}</p>
                  </div>
                </div>
              </details>
            ))}
          </div>
          <div className="reply-section">
            <div className="section-heading">
              <h3><MessageSquareText size={18} /> {reportLabel("Your next move, already written", "下一步怎么沟通")}</h3>
              <span>{reportLabel("READY TO SEND", "沟通草稿")}</span>
            </div>
            <div className="reply-tabs" role="tablist" aria-label={reportLabel("Email reply strategy", "沟通策略")}>
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
                  {reportLabel(item.label, item.zh[0])}
                </button>
              ))}
            </div>
            <div className="email-card" id="reply-content" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              <div className="email-heading">
                <span>{activeReply && reportLabel(activeReply.caption, activeReply.zh[1])}</span>
                <CopyButton text={report.emailReplies[tab]} label={reportLabel("Copy email", "复制邮件")} chinese={chineseReport} />
              </div>
              <p>{report.emailReplies[tab]}</p>
            </div>
          </div>
          <p className="report-footnote"><ShieldCheck size={14} /> {reportLabel("A second set of eyes. The final call is always yours.", "多一个视角，最终决定由你做出。")}</p>
        </section>
      </div>
      <section id="how-it-works" className="how-it-works"><div><span><Upload size={18} /></span><p><strong>Drop in the fine print</strong><br />Upload a contract or paste the text.</p></div><ChevronRight size={17} className="step-chevron" /><div><span><ScanLine size={18} /></span><p><strong>See what’s at stake</strong><br />Understand the risks, minus the jargon.</p></div><ChevronRight size={17} className="step-chevron" /><div><span><MessageSquareText size={18} /></span><p><strong>Find the right words</strong><br />Copy a reply. Start the conversation.</p></div></section>
    </main>
    <footer className="site-footer"><div><a className="footer-brand" href="/"><ShieldCheck size={17} />ClauseGuard</a><span>Made for the independently minded.</span></div><p>免责声明：ClauseGuard 为自由职业者提供合同风险梳理与条款参考，但不构成正式的法律建议。</p></footer>
  </div>;
}
