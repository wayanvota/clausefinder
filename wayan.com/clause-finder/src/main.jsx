import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { contextOptions, examples } from "./data";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const SOURCE_LINKS = [
  ["FAR", "Current FAR text", "https://www.acquisition.gov/far"],
  ["DFARS", "DoD supplement", "https://www.acquisition.gov/dfars"],
  ["DAFFARS", "Air Force supplement", "https://www.acquisition.gov/daffars"],
  ["FAR Overhaul", "Deviation and companion material", "https://www.acquisition.gov/far-overhaul"],
  ["eCFR Title 48", "Current and point-in-time CFR text", "https://www.ecfr.gov/current/title-48"],
  ["Federal Register", "Proposed-rule notices", "https://www.federalregister.gov/documents/search?conditions%5Bterm%5D=Federal+Acquisition+Regulation+Revolutionary"]
];

function detectSensitive(value) {
  const text = String(value || "").toLowerCase();
  const checks = [
    ["CUI", /\bcui\b|controlled unclassified/i],
    ["source-selection", /source[-\s]?selection|selection sensitive/i],
    ["proposal", /technical proposal|cost proposal|offeror price|source selection plan/i],
    ["proprietary", /proprietary|trade secret|confidential contractor/i],
    ["personal identifier", /\bssn\b|social security|date of birth|bank account/i]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function formatPercent(value) {
  return Math.round(Number(value || 0) * 100);
}

function versionClass(label) {
  return `version version-${String(label || "current").replace(/\s+/g, "-")}`;
}

function truncate(value, max = 1100) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function statusClass(value) {
  const status = String(value || "").toLowerCase();
  if (status.includes("met")) return "met";
  if (status.includes("unknown")) return "unknown";
  return "miss";
}

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `clausefinder-session-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(`API ${path} failed with ${response.status}`);
  return response.json();
}

function Header({ activePage, setActivePage, meta, onExport }) {
  const pages = [
    ["tool", "Tool"],
    ["about", "About"],
    ["method", "Method"],
    ["sources", "Sources"]
  ];
  return (
    <header className="app-header">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          CF
        </div>
        <div>
          <h1>ClauseFinder</h1>
          <p>by Wayan Vota</p>
        </div>
      </div>
      <nav className="page-nav" aria-label="ClauseFinder pages">
        {pages.map(([id, label]) => (
          <button
            className={activePage === id ? "active" : ""}
            type="button"
            key={id}
            onClick={() => setActivePage(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <span>
          {meta?.totalNodes ? `${meta.totalNodes.toLocaleString()} indexed nodes` : "Loading corpus"}
          {meta?.sourceStats?.sourceDatabaseNodes ? " from Neon" : ""}
        </span>
        <button className="secondary-button" type="button" onClick={onExport}>
          Export session
        </button>
      </div>
    </header>
  );
}

function GuardrailStrip() {
  return (
    <section className="guardrail-strip" aria-label="Guardrails">
      <strong>Decision support only</strong>
      <span>Public regulatory sources only</span>
      <span>No compliance verdicts</span>
      <span>Every result links to a public source</span>
    </section>
  );
}

function IntakePanel({
  question,
  setQuestion,
  context,
  setContext,
  onClarify,
  onSearch,
  onExample,
  sensitiveHits,
  loading,
  clarifying
}) {
  return (
    <aside className="panel intake-panel">
      <div className="panel-title">
        <span>Question and context</span>
        <small>Search public acquisition rules</small>
      </div>

      <label className="question-box">
        <span>Your question</span>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={6}
          maxLength={1400}
          placeholder="Ask about a clause, acquisition scenario, threshold, certification, source selection issue, or contract administration question."
        />
        <small>{question.length} / 1400</small>
      </label>

      {sensitiveHits.length > 0 && (
        <div className="warning-box" role="alert">
          <strong>Do not paste sensitive acquisition material.</strong>
          <p>
            Detected possible {sensitiveHits.join(", ")} content. Describe the
            contract attributes instead of pasting CUI, source-selection,
            proposal, or proprietary text.
          </p>
        </div>
      )}

      <div className="context-grid">
        {Object.entries(contextOptions).map(([key, options]) => (
          <label className="context-control" key={key}>
            <span>{key.replace(/([A-Z])/g, " $1")}</span>
            <select
              value={context[key]}
              onChange={(event) => setContext({ ...context, [key]: event.target.value })}
            >
              {options.map((option) => (
                <option value={option} key={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="button-row">
        <button className="primary-button" type="button" onClick={onClarify} disabled={loading || clarifying}>
          {clarifying ? "Checking facts" : "Start clause search"}
        </button>
        <button className="secondary-button" type="button" onClick={onSearch} disabled={loading || clarifying}>
          {loading ? "Searching" : "Search now"}
        </button>
      </div>

      <div className="example-list">
        <span>Try a query</span>
        {examples.map((example) => (
          <button type="button" key={example.id} onClick={() => onExample(example)}>
            {example.label}
          </button>
        ))}
      </div>
    </aside>
  );
}

function ClarifyPanel({ questions, answers, setAnswers, onSearch, onClear, note }) {
  if (!questions.length) return null;
  return (
    <section className="panel clarify-panel">
      <div className="panel-title">
        <span>Clarifying questions</span>
        <small>{note || "Answer what you know, or skip."}</small>
      </div>
      <div className="clarify-grid">
        {questions.map((question) => (
          <label className="clarify-question" key={question.id}>
            <strong>{question.label}</strong>
            <span>{question.why}</span>
            <select
              value={answers[question.id] || "Not sure"}
              onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
            >
              {(question.options || ["Not sure"]).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="button-row clarify-actions">
        <button className="primary-button" type="button" onClick={onSearch}>
          Search with answers
        </button>
        <button className="secondary-button" type="button" onClick={onClear}>
          Hide questions
        </button>
      </div>
    </section>
  );
}

function ScoreBar({ label, value }) {
  return (
    <div className="score-bar">
      <div>
        <span>{label}</span>
        <strong>{formatPercent(value)}</strong>
      </div>
      <meter min="0" max="1" value={Number(value || 0)} />
    </div>
  );
}

function ResultCard({ result, index, selected, onSelect, feedback, setFeedback }) {
  const vote = feedback?.vote || "";
  const missing = result.clausePassport?.missingFacts?.length || 0;
  return (
    <article className={`result-card ${selected ? "selected" : ""}`}>
      <button className="result-main" type="button" onClick={() => onSelect(result.id)}>
        <div className="rank">{index + 1}</div>
        <div className="result-copy">
          <div className="result-heading">
            <h2>{result.citation}</h2>
            <strong>{result.title}</strong>
            <span>{Number(result.score?.composite || 0).toFixed(2)}</span>
          </div>
          <div className="version-row">
            <span className={versionClass(result.version?.label)}>{result.version?.label || "current"}</span>
            <span className="version">{result.regime}</span>
            <span className="version">{result.type}</span>
            <span className="version">Part {result.part}</span>
            {missing > 0 && <span className="version version-warning">{missing} facts unknown</span>}
          </div>
          <p>{result.whyRelevant}</p>
          <div className="score-grid">
            <ScoreBar label="Semantic" value={result.score?.semantic} />
            <ScoreBar label="Keyword" value={result.score?.keyword} />
            <ScoreBar label="Applicability" value={result.score?.applicability} />
            <ScoreBar label="Supplement" value={result.score?.supplement} />
          </div>
          <p className="risk-line">Why this might not apply: {result.mightNotApply}</p>
          <a href={result.sourceUrl} target="_blank" rel="noreferrer">
            Source
          </a>
        </div>
      </button>
      <div className="feedback-row">
        <button
          type="button"
          className={vote === "helpful" ? "active" : ""}
          onClick={() => setFeedback(result.id, { vote: "helpful" })}
        >
          Helpful
        </button>
        <button
          type="button"
          className={vote === "not helpful" ? "active" : ""}
          onClick={() => setFeedback(result.id, { vote: "not helpful" })}
        >
          Not helpful
        </button>
      </div>
    </article>
  );
}

function ResultsPanel({ results, selectedId, setSelectedId, feedback, setFeedback, error, noMatchReason }) {
  return (
    <main className="panel results-panel">
      <div className="panel-title results-title">
        <span>Ranked candidate authorities</span>
        <small>{results.length ? `Showing ${results.length} candidates` : "No result selected"}</small>
      </div>
      {error && <div className="warning-box"><strong>Search failed.</strong><p>{error}</p></div>}
      {results.length ? (
        <div className="results-list">
          {results.map((result, index) => (
            <ResultCard
              result={result}
              index={index}
              key={result.id}
              selected={result.id === selectedId}
              onSelect={setSelectedId}
              feedback={feedback[result.id]}
              setFeedback={setFeedback}
            />
          ))}
        </div>
      ) : (
        <div className="no-match">
          <h2>No confident candidate yet.</h2>
          <p>{noMatchReason || "Enter a question and search the acquisition-rule index."}</p>
          <a href="https://www.acquisition.gov/search-regulations" target="_blank" rel="noreferrer">
            Manual Acquisition.gov search
          </a>
        </div>
      )}
    </main>
  );
}

function AnswerPanel({ answer }) {
  if (!answer) return null;
  return (
    <section className="panel answer-panel">
      <div className="panel-title">
        <span>Grounded summary</span>
        <small>Generated only from retrieved candidates</small>
      </div>
      <p>{answer.summary}</p>
      {Array.isArray(answer.bestFitCitations) && answer.bestFitCitations.length > 0 && (
        <div className="version-row">
          {answer.bestFitCitations.map((citation) => (
            <span className="version" key={citation}>
              {citation}
            </span>
          ))}
        </div>
      )}
      {Array.isArray(answer.caveats) && answer.caveats.length > 0 && (
        <ul>
          {answer.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApplicabilityChecks({ result, context }) {
  const checks = result.clausePassport?.checklist || [
    { label: "Acquisition type", value: context.acquisitionType, status: "unknown", explanation: "No checklist data returned." },
    { label: "Commerciality", value: context.commerciality, status: "unknown", explanation: "No checklist data returned." },
    { label: "Value band", value: context.valueBand, status: "unknown", explanation: "No checklist data returned." },
    { label: "Funding layer", value: context.fundingLayer, status: "unknown", explanation: "No checklist data returned." },
    { label: "Urgency", value: context.urgency, status: "unknown", explanation: "No checklist data returned." }
  ];
  return (
    <div className="check-list">
      {checks.map((item) => (
        <div className="check-row" key={item.label}>
          <span>{item.label}</span>
          <strong className={statusClass(item.status)}>{item.status}</strong>
          <small>{item.value}. {item.explanation}</small>
        </div>
      ))}
    </div>
  );
}

function ClausePassport({ result }) {
  const passport = result.clausePassport || {};
  const items = [
    ["Origin", passport.origin || result.regime],
    ["Version status", passport.versionStatus || result.version?.label || "current"],
    ["Retrieved", passport.retrievedAt || result.retrievedAt || "indexed source"],
    ["Effective date", passport.effectiveDate || result.version?.effectiveStart || "not explicit"],
    ["Prescribed by", passport.prescribedBy || "not extracted"],
    ["Missing facts", passport.missingFacts?.length ? passport.missingFacts.join(", ") : "none flagged"]
  ];
  return (
    <section className="detail-section">
      <h3>Clause Passport</h3>
      <div className="passport-grid">
        {items.map(([label, value]) => (
          <div className="passport-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <h3>Applies when</h3>
      <p>{passport.appliesWhen}</p>
      <h3>May not apply when</h3>
      <p>{passport.doesNotApplyWhen}</p>
    </section>
  );
}

function DiffView({ result }) {
  const diff = result.clausePassport?.diff;
  return (
    <section className="detail-section">
      <h3>2026 version comparison</h3>
      <p>{diff?.summary || "No comparison metadata was returned for this result."}</p>
      <div className="diff-grid">
        <div>
          <span>Earlier state</span>
          <strong>{diff?.beforeLabel || "not indexed"}</strong>
        </div>
        <div>
          <span>Current or proposed state</span>
          <strong>{diff?.afterLabel || result.version?.effectiveStart || "indexed source"}</strong>
        </div>
      </div>
      <h3>Operational text signals</h3>
      <ul className="compact-list">
        {(diff?.textSignals || []).map((signal) => (
          <li key={signal}>{signal}</li>
        ))}
      </ul>
    </section>
  );
}

function RedTeamView({ result }) {
  return (
    <section className="detail-section">
      <h3>Challenge this result</h3>
      <p>
        Use these checks before treating this candidate as useful for a contract
        file or reviewer discussion.
      </p>
      <div className="check-list">
        {(result.clausePassport?.redTeamChecks || []).map((item) => (
          <div className="check-row" key={item}>
            <span>{item}</span>
            <strong className="unknown">review</strong>
            <small>Human verification required.</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function VerificationPanel({ result, context, feedback, setFeedback }) {
  const [tab, setTab] = useState("Passport");
  useEffect(() => setTab("Passport"), [result?.id]);

  if (!result) {
    return (
      <aside className="panel detail-panel empty-detail">
        <h2>Select a result to verify it.</h2>
        <p>ClauseFinder ranks candidate authorities. The user still verifies and decides.</p>
      </aside>
    );
  }

  const note = feedback[result.id]?.note || "";
  return (
    <aside className="panel detail-panel">
      <div className="detail-heading">
        <div>
          <span>{result.regime}</span>
          <h2>
            {result.citation} <small>{result.title}</small>
          </h2>
        </div>
        <a href={result.sourceUrl} target="_blank" rel="noreferrer">
          Source
        </a>
      </div>
      <div className="version-row">
        <span className={versionClass(result.version?.label)}>{result.version?.label || "current"}</span>
        <span className="version">{result.version?.effectiveStart || "current text"}</span>
      </div>

      <div className="tab-row" role="tablist" aria-label="Verification details">
        {["Passport", "Text", "Prescription", "Hierarchy", "Timeline", "Diff", "Challenge"].map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Passport" && <ClausePassport result={result} />}

      {tab === "Text" && (
        <section className="detail-section">
          <h3>Indexed source text</h3>
          <p>{truncate(result.bodyText || result.excerpt, 1500)}</p>
          <h3>Source provenance</h3>
          <p>
            Retrieved {result.retrievedAt || "from index"} from{" "}
            <a href={result.sourceUrl} target="_blank" rel="noreferrer">
              public source
            </a>
            .
          </p>
        </section>
      )}

      {tab === "Prescription" && (
        <section className="detail-section">
          <h3>Prescription or policy signal</h3>
          <p>{result.clausePassport?.appliesWhen || result.prescription || "No prescription phrase was extracted for this node."}</p>
          <h3>Applicability checks</h3>
          <ApplicabilityChecks result={result} context={context} />
        </section>
      )}

      {tab === "Hierarchy" && (
        <section className="detail-section">
          <h3>Regulatory path</h3>
          <p>{result.hierarchyPath}</p>
          <h3>Air Force stack</h3>
          <div className="chain">
            {(result.clausePassport?.airForceStack || result.supplementChain || []).map((item) => (
              <a href={item.url} target="_blank" rel="noreferrer" key={item.label}>
                <strong>{item.label}</strong>
                <span>{item.status}</span>
              </a>
            ))}
          </div>
          <h3>Cross references</h3>
          <div className="related-list">
            {(result.related || []).length ? (
              result.related.map((item) => (
                <a href={item.url} target="_blank" rel="noreferrer" key={`${item.label}-${item.url}`}>
                  {item.label}
                  <span>{item.relation}</span>
                </a>
              ))
            ) : (
              <p>No cross-reference links were extracted for this node.</p>
            )}
          </div>
        </section>
      )}

      {tab === "Diff" && <DiffView result={result} />}

      {tab === "Challenge" && <RedTeamView result={result} />}

      {tab === "Timeline" && (
        <section className="detail-section">
          <h3>Version states</h3>
          <div className="timeline">
            {(result.versions || []).map((version) => (
              <a href={version.sourceUrl} target="_blank" rel="noreferrer" key={`${version.label}-${version.date}`}>
                <strong>{version.label}</strong>
                <span>{version.date}</span>
                <small>{version.note}</small>
              </a>
            ))}
          </div>
        </section>
      )}

      <label className="review-note">
        <span>Reviewer note</span>
        <textarea
          value={note}
          rows={4}
          onChange={(event) => setFeedback(result.id, { note: event.target.value })}
          placeholder="Capture why this result is right, wrong, or incomplete."
        />
      </label>
    </aside>
  );
}

function AboutPage() {
  return (
    <main className="page-panel">
      <h2>ClauseFinder is a public acquisition-rule search tool, not a legal answer machine.</h2>
      <p>
        It was built by Wayan Vota as a showcase for acquisition AI that makes
        uncertainty visible. The tool searches indexed public FAR, DFARS,
        DAFFARS, FAR Overhaul, Federal Register, current eCFR full text, and
        eCFR-history signals, ranks candidate authorities, links back to public
        source pages, and keeps the human verification step in the workflow.
      </p>
      <p>
        The strongest use case is first-pass orientation: a contracting officer,
        reviewer, journalist, or policy analyst can paste a plain-language
        acquisition question and quickly find likely sections or clauses to inspect.
      </p>
      <div className="callout-grid">
        <div>
          <h3>Built by User</h3>
          <p>
            This project demonstrates a procurement-aware tool built by a subject
            matter user with Codex, public sources, OpenAI API support, Render,
            and Neon. The point is not replacing contracting officers. The point
            is giving them an auditable first-pass research aid they can challenge.
          </p>
        </div>
        <div>
          <h3>NCMA demo posture</h3>
          <p>
            The tool is designed to show provenance, version state, source layer,
            and unresolved facts. That makes it safer for a conference demo than
            a general chatbot that hides its retrieval and reasoning steps.
          </p>
        </div>
      </div>
    </main>
  );
}

function MethodPage({ meta }) {
  return (
    <main className="page-panel">
      <h2>How the search works</h2>
      <p>
        The backend fetches public FAR, DFARS, DAFFARS, FAR Overhaul, Federal
        Register proposed-rule, current eCFR Title 48 XML, and eCFR Title 48
        version metadata sources, extracts retrievable nodes into a JSON index,
        then scores user queries with lexical ranking plus context boosts for
        buying type, commerciality, thresholds, competition, funding layer, and
        urgency.
      </p>
      <p>
        The current index contains {meta?.totalNodes?.toLocaleString() || "loading"} nodes.
        The OpenAI API asks clarifying questions and writes a grounded summary
        only from retrieved candidates. eCFR current full text is indexed where
        the public Title 48 XML endpoint exposes the part. Historical eCFR
        coverage is still version metadata, and FAR Overhaul deviation extraction
        still needs a reviewer-grade text pipeline before operational use.
      </p>
      <div className="eval-grid method-eval">
        <div className="eval-item">
          <strong>{meta?.evaluation?.cases || 0} test questions</strong>
          <p>{meta?.evaluation?.label || "Evaluation harness"}</p>
        </div>
        <div className="eval-item">
          <strong>{meta?.evaluation?.topOneCases || 0} top-1 checks</strong>
          <p>{meta?.evaluation?.note || "Run backend tests before demo use."}</p>
        </div>
      </div>
    </main>
  );
}

function SourcesPage({ meta }) {
  return (
    <main className="page-panel">
      <h2>Sources and deployment notes</h2>
      <p>
        The searchable corpus is generated from Acquisition.gov FAR, DFARS,
        DAFFARS, and FAR Overhaul pages, Federal Register proposed-rule metadata,
        current eCFR Title 48 XML, and eCFR Title 48 version metadata. Every
        candidate result links back to its public source page when the source
        provides one.
      </p>
      <div className="source-grid">
        {SOURCE_LINKS.map(([label, note, url]) => (
          <a href={url} target="_blank" rel="noreferrer" key={label}>
            <strong>{label}</strong>
            <span>{note}</span>
            <small>{url}</small>
          </a>
        ))}
      </div>
      <h3 className="section-label">Indexed source stats</h3>
      <div className="source-grid">
        {Object.entries(meta?.sourceStats || {}).map(([label, count]) => (
          <div className="source-stat" key={label}>
            <strong>{label}</strong>
            <span>{Number(count).toLocaleString()} nodes</span>
          </div>
        ))}
        {(meta?.parts || []).slice(0, 20).map((part) => (
          <a href={part.url} target="_blank" rel="noreferrer" key={part.part}>
            <strong>{part.regime || "Source"} {part.part}</strong>
            <span>{part.nodes} indexed nodes</span>
            <small>{part.url}</small>
          </a>
        ))}
      </div>
    </main>
  );
}

function ToolPage({
  question,
  setQuestion,
  context,
  setContext,
  results,
  selected,
  selectedId,
  setSelectedId,
  feedback,
  setFeedback,
  answer,
  questions,
  answers,
  setAnswers,
  clarifyNote,
  onClarify,
  clearQuestions,
  onSearch,
  onExample,
  loading,
  clarifying,
  error,
  noMatchReason,
  responseContext
}) {
  const sensitiveHits = useMemo(() => detectSensitive(question), [question]);
  return (
    <>
      <div className="workspace">
        <IntakePanel
          question={question}
          setQuestion={setQuestion}
          context={context}
          setContext={setContext}
          onClarify={onClarify}
          onSearch={onSearch}
          onExample={onExample}
          sensitiveHits={sensitiveHits}
          loading={loading}
          clarifying={clarifying}
        />
        <ResultsPanel
          results={results}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          feedback={feedback}
          setFeedback={setFeedback}
          error={error}
          noMatchReason={noMatchReason}
        />
        <VerificationPanel
          result={selected}
          context={responseContext || context}
          feedback={feedback}
          setFeedback={setFeedback}
        />
      </div>
      <ClarifyPanel
        questions={questions}
        answers={answers}
        setAnswers={setAnswers}
        onSearch={onSearch}
        onClear={clearQuestions}
        note={clarifyNote}
      />
      <AnswerPanel answer={answer} />
    </>
  );
}

function App() {
  const firstExample = examples[0];
  const [activePage, setActivePage] = useState("tool");
  const [question, setQuestion] = useState(firstExample.question);
  const [context, setContext] = useState(firstExample.context);
  const [responseContext, setResponseContext] = useState(firstExample.context);
  const [results, setResults] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [feedback, setFeedbackState] = useState({});
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [error, setError] = useState("");
  const [noMatchReason, setNoMatchReason] = useState("");
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [clarifyNote, setClarifyNote] = useState("");
  const [answer, setAnswer] = useState(null);

  const selected = results.find((result) => result.id === selectedId) || results[0];

  function setFeedback(id, patch) {
    setFeedbackState((current) => ({
      ...current,
      [id]: { ...(current[id] || {}), ...patch }
    }));
  }

  function contextWithAnswers(base = context) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(answers)) {
      if (value && value !== "Not sure") merged[key] = value;
    }
    return merged;
  }

  async function runClarify() {
    setClarifying(true);
    setError("");
    try {
      const payload = await apiJson("/api/clarify", {
        method: "POST",
        body: JSON.stringify({ query: question, context })
      });
      setContext(payload.context || context);
      setQuestions(payload.questions || []);
      setClarifyNote(payload.note || "");
      if (payload.readyToSearch || !payload.questions?.length) {
        await runSearch(question, payload.context || context);
      }
    } catch (clarifyError) {
      setError(String(clarifyError.message || clarifyError));
    } finally {
      setClarifying(false);
    }
  }

  async function runSearch(nextQuestion = question, nextContext = contextWithAnswers()) {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson("/api/search", {
        method: "POST",
        body: JSON.stringify({ query: nextQuestion, context: nextContext, limit: 8, includeAnswer: true })
      });
      setResults(payload.results || []);
      setResponseContext(payload.context || nextContext);
      setNoMatchReason(payload.noMatchReason || "");
      setSelectedId(payload.results?.[0]?.id || "");
      setAnswer(payload.answer || null);
      if (payload.totalNodes) {
        setMeta((currentMeta) => currentMeta || {
          totalNodes: payload.totalNodes,
          generatedAt: payload.generatedAt,
          sourceBaseUrl: payload.sourceBaseUrl,
          parts: []
        });
      }
    } catch (searchError) {
      setError(String(searchError.message || searchError));
    } finally {
      setLoading(false);
    }
  }

  function onExample(example) {
    setQuestion(example.question);
    setContext(example.context);
    setQuestions([]);
    setAnswers({});
    setAnswer(null);
    setActivePage("tool");
    runSearch(example.question, example.context);
  }

  function exportSession() {
    downloadJson({
      app: "ClauseFinder",
      urlPath: "/clause-finder/",
      packetType: "Reviewer Packet",
      question,
      context: responseContext,
      results: results.map((result) => ({
        citation: result.citation,
        title: result.title,
        regime: result.regime,
        version: result.version,
        score: result.score,
        sourceUrl: result.sourceUrl,
        clausePassport: result.clausePassport,
        feedback: feedback[result.id] || null
      })),
      feedback,
      exportedAt: new Date().toISOString()
    });
  }

  useEffect(() => {
    apiJson("/api/meta")
      .then(setMeta)
      .catch((metaError) => setError(String(metaError.message || metaError)));
    runSearch(firstExample.question, firstExample.context);
  }, []);

  return (
    <div className="app-shell">
      <Header activePage={activePage} setActivePage={setActivePage} meta={meta} onExport={exportSession} />
      <GuardrailStrip />
      {activePage === "tool" && (
        <ToolPage
          question={question}
          setQuestion={setQuestion}
          context={context}
          setContext={setContext}
          results={results}
          selected={selected}
          selectedId={selected?.id || selectedId}
          setSelectedId={setSelectedId}
          feedback={feedback}
          setFeedback={setFeedback}
          answer={answer}
          questions={questions}
          answers={answers}
          setAnswers={setAnswers}
          clarifyNote={clarifyNote}
          onClarify={runClarify}
          clearQuestions={() => setQuestions([])}
          onSearch={() => runSearch(question, contextWithAnswers())}
          onExample={onExample}
          loading={loading}
          clarifying={clarifying}
          error={error}
          noMatchReason={noMatchReason}
          responseContext={responseContext}
        />
      )}
      {activePage === "about" && <AboutPage />}
      {activePage === "method" && <MethodPage meta={meta} />}
      {activePage === "sources" && <SourcesPage meta={meta} />}
      <footer className="footer-note">
        ClauseFinder is a Wayan Vota project under /clause-finder/. It searches
        public regulatory text and returns candidate authorities. It does not
        decide compliance, prescribe clause use, or retain sensitive contract
        material.
      </footer>
    </div>
  );
}

const rootNode = document.getElementById("root");
rootNode.__clauseFinderRoot = rootNode.__clauseFinderRoot || createRoot(rootNode);
rootNode.__clauseFinderRoot.render(<App />);
