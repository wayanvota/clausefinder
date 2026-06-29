import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { contextDefaults, contextOptions, examples } from "./data";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE || "";

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
        <span>{meta?.totalNodes ? `${meta.totalNodes.toLocaleString()} FAR nodes` : "Loading corpus"}</span>
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
      <span>Public regulatory text only</span>
      <span>No compliance verdicts</span>
      <span>Every result links to Acquisition.gov</span>
    </section>
  );
}

function IntakePanel({
  question,
  setQuestion,
  context,
  setContext,
  onSearch,
  onExample,
  sensitiveHits,
  loading
}) {
  return (
    <aside className="panel intake-panel">
      <div className="panel-title">
        <span>Question and context</span>
        <small>Search public FAR text</small>
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
        <button className="primary-button" type="button" onClick={onSearch} disabled={loading}>
          {loading ? "Searching" : "Find FAR clauses"}
        </button>
        <button className="secondary-button" type="button" onClick={() => setContext(contextDefaults)}>
          Reset context
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
            <span className="version">{result.type}</span>
            <span className="version">Part {result.part}</span>
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
            Acquisition.gov source
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
          <p>{noMatchReason || "Enter a question and search the FAR index."}</p>
          <a href="https://www.acquisition.gov/search-regulations" target="_blank" rel="noreferrer">
            Manual Acquisition.gov search
          </a>
        </div>
      )}
    </main>
  );
}

function ApplicabilityChecks({ result, context }) {
  const body = `${result.title} ${result.bodyText || ""}`.toLowerCase();
  const checks = [
    ["Acquisition type", context.acquisitionType],
    ["Commerciality", context.commerciality],
    ["Value band", context.valueBand],
    ["Funding layer", context.fundingLayer],
    ["Urgency", context.urgency]
  ];
  return (
    <div className="check-list">
      {checks.map(([label, value]) => {
        const known = value !== "Not sure" && value !== "Normal";
        const cue = String(value).toLowerCase().split(" ")[0];
        const met = known && body.includes(cue);
        return (
          <div className="check-row" key={label}>
            <span>{label}</span>
            <strong className={!known ? "unknown" : met ? "met" : "miss"}>
              {!known ? "unknown" : met ? "text match" : "not explicit"}
            </strong>
            <small>{value}</small>
          </div>
        );
      })}
    </div>
  );
}

function VerificationPanel({ result, context, feedback, setFeedback }) {
  const [tab, setTab] = useState("Text");
  useEffect(() => setTab("Text"), [result?.id]);

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
        {["Text", "Prescription", "Hierarchy", "Timeline"].map((item) => (
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

      {tab === "Text" && (
        <section className="detail-section">
          <h3>Indexed FAR text</h3>
          <p>{truncate(result.bodyText || result.excerpt, 1500)}</p>
          <h3>Source provenance</h3>
          <p>
            Retrieved {result.retrievedAt || "from index"} from{" "}
            <a href={result.sourceUrl} target="_blank" rel="noreferrer">
              Acquisition.gov
            </a>
            .
          </p>
        </section>
      )}

      {tab === "Prescription" && (
        <section className="detail-section">
          <h3>Prescription or policy signal</h3>
          <p>{result.prescription || "No prescription phrase was extracted for this node."}</p>
          <h3>Applicability checks</h3>
          <ApplicabilityChecks result={result} context={context} />
        </section>
      )}

      {tab === "Hierarchy" && (
        <section className="detail-section">
          <h3>Regulatory path</h3>
          <p>{result.hierarchyPath}</p>
          <div className="chain">
            {result.supplementChain?.map((item) => (
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
      <h2>ClauseFinder is a public FAR search tool, not a legal answer machine.</h2>
      <p>
        It was built by Wayan Vota as a showcase for acquisition AI that makes
        uncertainty visible. The tool searches indexed public FAR text, ranks
        candidate authorities, links back to Acquisition.gov, and keeps the
        human verification step in the workflow.
      </p>
      <p>
        The strongest use case is first-pass orientation: a contracting officer,
        reviewer, journalist, or policy analyst can paste a plain-language
        acquisition question and quickly find likely FAR sections or clauses to
        inspect.
      </p>
    </main>
  );
}

function MethodPage({ meta }) {
  return (
    <main className="page-panel">
      <h2>How the search works</h2>
      <p>
        The backend fetches public FAR part pages from Acquisition.gov, extracts
        sections, provisions, and clauses into a JSON index, then scores user
        queries with a lexical ranking method plus context boosts for buying
        type, commerciality, thresholds, competition, funding layer, and urgency.
      </p>
      <p>
        The current index contains {meta?.totalNodes?.toLocaleString() || "loading"} nodes.
        It does not yet include full DFARS, DAFFARS, eCFR point-in-time history,
        or the complete FAR overhaul deviation corpus. Those are the next
        accuracy upgrades before any operational use.
      </p>
    </main>
  );
}

function SourcesPage({ meta }) {
  return (
    <main className="page-panel">
      <h2>Sources and deployment notes</h2>
      <p>
        The searchable corpus is generated from{" "}
        <a href="https://www.acquisition.gov/far" target="_blank" rel="noreferrer">
          Acquisition.gov FAR pages
        </a>
        . Every candidate result links back to its public source page.
      </p>
      <div className="source-grid">
        {(meta?.parts || []).map((part) => (
          <a href={part.url} target="_blank" rel="noreferrer" key={part.part}>
            <strong>FAR Part {part.part}</strong>
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
  onSearch,
  onExample,
  loading,
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
          onSearch={onSearch}
          onExample={onExample}
          sensitiveHits={sensitiveHits}
          loading={loading}
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
  const [error, setError] = useState("");
  const [noMatchReason, setNoMatchReason] = useState("");

  const selected = results.find((result) => result.id === selectedId) || results[0];

  function setFeedback(id, patch) {
    setFeedbackState((current) => ({
      ...current,
      [id]: { ...(current[id] || {}), ...patch }
    }));
  }

  async function runSearch(nextQuestion = question, nextContext = context) {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson("/api/search", {
        method: "POST",
        body: JSON.stringify({ query: nextQuestion, context: nextContext, limit: 8 })
      });
      setResults(payload.results || []);
      setResponseContext(payload.context || nextContext);
      setNoMatchReason(payload.noMatchReason || "");
      setSelectedId(payload.results?.[0]?.id || "");
    } catch (searchError) {
      setError(String(searchError.message || searchError));
    } finally {
      setLoading(false);
    }
  }

  function onExample(example) {
    setQuestion(example.question);
    setContext(example.context);
    setActivePage("tool");
    runSearch(example.question, example.context);
  }

  function exportSession() {
    downloadJson({
      app: "ClauseFinder",
      urlPath: "/clause-finder/",
      question,
      context: responseContext,
      results: results.map((result) => ({
        citation: result.citation,
        title: result.title,
        score: result.score,
        sourceUrl: result.sourceUrl,
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
          onSearch={() => runSearch()}
          onExample={onExample}
          loading={loading}
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

createRoot(document.getElementById("root")).render(<App />);
