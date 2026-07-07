import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { groundedAnswer } from "./openai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.FAR_INDEX_PATH || join(__dirname, "data", "far-index.json");
const ACCURACY_CASES_PATH = process.env.ACCURACY_CASES_PATH || join(__dirname, "data", "accuracy-cases.json");
const BENCHMARK_RESULTS_PATH = process.env.BENCHMARK_RESULTS_PATH || join(__dirname, "data", "benchmark-results.json");
const SOURCE_COVERAGE_REPORT_PATH =
  process.env.SOURCE_COVERAGE_REPORT_PATH || join(__dirname, "data", "source-coverage-report.json");
const DATABASE_SEARCH_ENABLED = process.env.ECFR_SEARCH_DATABASE !== "false";
const DATABASE_NODE_LIMIT = Number(process.env.ECFR_SEARCH_NODE_LIMIT || 50000);
const FAR_BASELINE_DATE = process.env.FAR_BASELINE_DATE || "2025-01-01";
const FAR_OVERHAUL_COMMENT_DEADLINE = process.env.FAR_OVERHAUL_COMMENT_DEADLINE || "2026-07-23";

const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "contract",
  "contracts",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "need",
  "of",
  "on",
  "or",
  "should",
  "the",
  "this",
  "to",
  "under",
  "what",
  "when",
  "which",
  "with"
]);

const ACQUISITION_SCOPE_TERMS = new Set([
  "acquisition",
  "acquisitions",
  "agreement",
  "agreements",
  "blanket",
  "cage",
  "clause",
  "clauses",
  "contract",
  "contracts",
  "contracting",
  "contractor",
  "contractors",
  "cots",
  "cui",
  "cyber",
  "daffars",
  "deviation",
  "dfars",
  "dod",
  "ecfr",
  "fapiis",
  "far",
  "invoice",
  "micro-purchase",
  "offeror",
  "offerors",
  "ordering",
  "procurement",
  "proposal",
  "provision",
  "provisions",
  "purchasing",
  "registration",
  "sam",
  "set-aside",
  "simplified",
  "solicitation",
  "source-selection",
  "subcontract",
  "subcontracts",
  "supplies",
  "supply",
  "threshold",
  "uei",
  "usg",
  "vendor",
  "vendors"
]);

const ACQUISITION_CONTEXT_TERMS = new Set([
  "agency",
  "air",
  "award",
  "awards",
  "buy",
  "buying",
  "commercial",
  "competition",
  "competitive",
  "construction",
  "dod",
  "federal",
  "force",
  "funds",
  "government",
  "payment",
  "payments",
  "performance",
  "purchase",
  "purchases",
  "service",
  "services",
  "supplies",
  "supply",
  "usg"
]);

const ACQUISITION_SCOPE_PATTERNS = [
  /\b(?:far|dfars|daffars|ecfr)\b/i,
  /\b48\s+cfr\b/i,
  /\bair\s+force\b/i,
  /\bcontract(?:s|ing|or|ors)?\b/i,
  /\bsystem for award management\b/i,
  /\bfederal acquisition regulation\b/i,
  /\bdefense federal acquisition regulation supplement\b/i,
  /\bdepartment of the air force federal acquisition regulation supplement\b/i,
  /\b(?:micro[-\s]?purchase|simplified acquisition|source[-\s]?selection|set[-\s]?aside)\b/i
];

let indexCache;
let evaluationCache;
let sourceCoverageCache;
let sourceDatabaseLoadWarningLogged = false;
let ecfrDatabaseLoadWarningLogged = false;

function normalizeCitation(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:far|dfars|daffars|cfr|title|section|part)\b/g, " ")
    .replace(/\b48\s+/g, " ")
    .replace(/\([a-z0-9]+\)/gi, "")
    .replace(/[^\d.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((piece) => {
      const spacedClause = piece.match(/^(\d{2,4})[.\s-](\d{3})\s+(\d{3,4})$/);
      return spacedClause ? `${spacedClause[1]}.${spacedClause[2]}-${spacedClause[3]}` : piece;
    })
    .join(" ");
}

function citationKey(value) {
  return normalizeCitation(value).replace(/[^0-9a-z.-]/g, "");
}

export function extractCitations(value) {
  const text = String(value || "");
  const direct = [...text.matchAll(/\b(?:FAR|DFARS|DAFFARS|48\s+CFR)?\s*(\d{1,4}\.\d{1,4}(?:-\d{1,4})?)(?:\([a-z0-9]+\))*/gi)].map(
    (match) => match[1]
  );
  const spaced = [...text.matchAll(/\b(?:FAR|DFARS|DAFFARS)?\s*(\d{2,4})[.\s-](\d{3})\s+(\d{3,4})\b/gi)].map(
    (match) => `${match[1]}.${match[2]}-${match[3]}`
  );
  const citations = [...new Set([...direct, ...spaced].map(citationKey).filter(Boolean))];
  return citations.filter(
    (citation) => !citations.some((other) => other !== citation && other.startsWith(`${citation}-`))
  );
}

export function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export function detectSensitive(value) {
  const text = String(value || "").toLowerCase();
  const checks = [
    ["CUI", /\bcui\b|controlled unclassified/],
    ["source-selection", /source[-\s]?selection|selection sensitive|source selection plan/],
    ["proposal", /technical proposal|cost proposal|offeror price|proposal volume/],
    ["proprietary", /proprietary|trade secret|confidential contractor/],
    ["personal identifier", /\bssn\b|social security|date of birth|bank account/]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function isLikelyAcquisitionQuery(query, queryTokens, queryCitations) {
  if (queryCitations.length) return true;
  if (ACQUISITION_SCOPE_PATTERNS.some((pattern) => pattern.test(query))) return true;
  if (queryTokens.some((token) => ACQUISITION_SCOPE_TERMS.has(token))) return true;
  return queryTokens.filter((token) => ACQUISITION_CONTEXT_TERMS.has(token)).length >= 2;
}

function moneyCue(question) {
  const normalized = String(question || "").replace(/,/g, "");
  const match = normalized.match(/\$?\s*(\d{3,10})/);
  return match ? Number(match[1]) : 0;
}

export function inferContext(question, provided = {}) {
  const text = String(question || "").toLowerCase();
  const context = {
    acquisitionType: "Not sure",
    commerciality: "Not sure",
    valueBand: "Not sure",
    competition: "Not sure",
    fundingLayer: "Air Force",
    urgency: "Normal",
    ...provided
  };

  if (/\bsuppl(y|ies)\b|\bproduct\b|\bequipment\b|\bitem\b/.test(text)) context.acquisitionType = "Supply";
  if (/\bservice\b|\bservices\b/.test(text)) context.acquisitionType = "Service";
  if (/\bconstruction\b/.test(text)) context.acquisitionType = "Construction";
  if (/\br&d\b|\bresearch\b|\bdevelopment\b/.test(text)) context.acquisitionType = "R&D";
  if (/\bcommercial\b|\bcots\b/.test(text)) context.commerciality = "Commercial";
  if (/\bnoncommercial\b/.test(text)) context.commerciality = "Noncommercial";
  if (/\bsole source\b|\bsingle source\b/.test(text)) context.competition = "Sole source";
  if (/\bset-aside\b|\bsmall business\b/.test(text)) context.competition = "Set-aside";
  if (/\bfull and open\b/.test(text)) context.competition = "Full and open";
  if (/\burgent\b|\bemergency\b/.test(text)) context.urgency = text.includes("emergency") ? "Emergency" : "Urgent";

  const value = moneyCue(question);
  if (value > 0 && value <= 10000) {
    context.valueBand = "At or near micro-purchase";
  } else if (value > 10000 && value < 250000) {
    context.valueBand = "Below simplified acquisition";
  } else if (value >= 250000 && value < 5000000) {
    context.valueBand = "Above simplified acquisition threshold";
  } else if (value >= 5000000) {
    context.valueBand = "Above $5M";
  }
  return context;
}

function dateValue(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function extractPrescribedBy(node) {
  const text = `${node.prescription || ""} ${node.bodyText || ""}`;
  const match = text.match(/\bas prescribed in\s+([0-9]{1,4}\.[0-9]{1,4}(?:-[0-9]{1,4})?(?:\([a-z0-9]+\))?)/i);
  return match ? match[1] : "";
}

function familyForPart(part) {
  const value = Number.parseInt(String(part || ""), 10);
  if (value >= 5301 && value <= 5353) return "DAFFARS";
  if (value >= 201 && value <= 253) return "DFARS";
  if (value >= 1 && value <= 53) return "FAR";
  return "Source";
}

function farPartForNode(node) {
  const part = Number.parseInt(String(node.part || ""), 10);
  if (!Number.isFinite(part)) return "";
  if (part >= 5301 && part <= 5353) return String(part - 5300);
  if (part >= 201 && part <= 253) return String(part - 200);
  if (part >= 1 && part <= 53) return String(part);
  return String(node.part || "");
}

function versionLabel(node) {
  const regime = String(node.regime || "").toLowerCase();
  if (regime.includes("proposed")) return "proposed";
  if (regime.includes("overhaul")) return "overhaul deviation";
  if (regime.includes("history")) return "pre-overhaul";
  if (node.snapshotType === "historical") return "pre-overhaul";
  return "current";
}

function versionNote(node) {
  const label = versionLabel(node);
  if (label === "proposed") return "Federal Register proposed-rule source. Verify whether it has become final before using it.";
  if (label === "overhaul deviation") return "FAR Overhaul or model-deviation source. Verify agency adoption and date before relying on it.";
  if (label === "pre-overhaul") return "Historical eCFR source. Use for comparison and date-sensitive review.";
  return `Current indexed ${node.regime || "public regulatory"} source.`;
}

function isGuidanceNode(node) {
  const joined = `${node.regime || ""} ${node.title || ""} ${node.type || ""}`.toLowerCase();
  return /companion|practitioner|album|buying guide|category management|guide|overhaul source/.test(joined);
}

function bindingLabel(node) {
  return isGuidanceNode(node) ? "non-regulatory guidance" : "regulatory or proposed-rule source";
}

function compareDate(value, fallback = "") {
  return String(value || fallback || "").slice(0, 10);
}

function versionRank(label) {
  const order = {
    "pre-overhaul": 0,
    current: 1,
    "overhaul deviation": 2,
    proposed: 3
  };
  return order[label] ?? 9;
}

function versionFamily(node, index) {
  const key = node.citationKey || citationKey(node.citation);
  return index.nodes
    .filter((candidate) => candidate.citationKey === key)
    .sort((a, b) => {
      const byRank = versionRank(versionLabel(a)) - versionRank(versionLabel(b));
      if (byRank) return byRank;
      return compareDate(a.effectiveDate || a.snapshotDate || a.retrievedAt).localeCompare(
        compareDate(b.effectiveDate || b.snapshotDate || b.retrievedAt)
      );
    });
}

function buildVersions(node, index) {
  const sameCitation = versionFamily(node, index)
    .map((candidate) => ({
      label: versionLabel(candidate),
      date: candidate.effectiveDate || candidate.snapshotDate || candidate.retrievedAt || "indexed source",
      note: versionNote(candidate),
      sourceUrl: candidate.sourceUrl
    }));
  const unique = [];
  const seen = new Set();
  for (const version of sameCitation) {
    const key = `${version.label}-${version.date}-${version.sourceUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(version);
    }
  }
  return unique.length
    ? unique.slice(0, 8)
    : [
        {
          label: versionLabel(node),
          date: node.effectiveDate || node.retrievedAt || "indexed source",
          note: versionNote(node),
          sourceUrl: node.sourceUrl
        }
      ];
}

function normalizeDiffText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function sentenceChunks(value) {
  const normalized = normalizeDiffText(value);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 18);
}

function computedDiff(before, after) {
  const beforeChunks = sentenceChunks(before);
  const afterChunks = sentenceChunks(after);
  const beforeSet = new Set(beforeChunks.map(normalizeDiffText));
  const afterSet = new Set(afterChunks.map(normalizeDiffText));
  const removed = beforeChunks.filter((item) => !afterSet.has(normalizeDiffText(item))).slice(0, 6);
  const added = afterChunks.filter((item) => !beforeSet.has(normalizeDiffText(item))).slice(0, 6);
  const unchanged = afterChunks.filter((item) => beforeSet.has(normalizeDiffText(item))).slice(0, 4);
  return {
    method: "computed_diff",
    confidence: beforeChunks.length && afterChunks.length ? "medium" : "low",
    removed,
    added,
    unchanged,
    summary:
      removed.length || added.length
        ? "Computed from stored text states. Review the linked sources before treating the difference as authoritative."
        : "No substantive sentence-level difference was detected in the stored excerpts."
  };
}

function buildDelta(node, index) {
  const family = versionFamily(node, index);
  const before =
    family.find((candidate) => versionLabel(candidate) === "pre-overhaul") ||
    family.find((candidate) => versionLabel(candidate) === "current") ||
    family[0];
  const after =
    family.find((candidate) => versionLabel(candidate) === "overhaul deviation") ||
    family.find((candidate) => versionLabel(candidate) === "proposed") ||
    node;
  const method = after?.metadata?.deltaMethod || after?.metadata?.lineoutMethod || "computed_diff";
  const confidence = after?.metadata?.deltaConfidence || (method === "computed_diff" ? "medium" : "high");
  const diff = computedDiff(before?.bodyText || before?.excerpt || "", after?.bodyText || after?.excerpt || "");
  return {
    available: Boolean(before && after && before.id !== after.id),
    from: before
      ? {
          citation: before.citation,
          label: versionLabel(before),
          date: before.effectiveDate || before.snapshotDate || before.retrievedAt || FAR_BASELINE_DATE,
          sourceUrl: before.sourceUrl
        }
      : null,
    to: after
      ? {
          citation: after.citation,
          label: versionLabel(after),
          date: after.effectiveDate || after.snapshotDate || after.retrievedAt || "",
          sourceUrl: after.sourceUrl
        }
      : null,
    method,
    confidence,
    methodLabel: method === "official_lineout" ? "official line-out" : "computed diff",
    adoptionCaveat:
      versionLabel(after) === "overhaul deviation"
        ? "Model deviation text. Whether this deviation governs a specific action depends on the buying agency's adoption. Verify with your agency's policy office."
        : "",
    summary: diff.summary,
    removed: diff.removed,
    added: diff.added,
    unchanged: diff.unchanged
  };
}

function buildCrosswalks(node, index) {
  const part = farPartForNode(node);
  const relatedCitationKeys = new Set([node.citationKey, ...(node.relatedCitationKeys || [])]);
  const guidance = index.nodes
    .filter((candidate) => candidate.id !== node.id && isGuidanceNode(candidate))
    .map((candidate) => {
      const text = `${candidate.citation || ""} ${candidate.title || ""} ${candidate.bodyText || ""}`.toLowerCase();
      const citesPart = part && new RegExp(`\\bpart\\s+${escapeRegex(part)}\\b|\\bfar\\s+${escapeRegex(part)}\\b`, "i").test(text);
      const citesNode = [...relatedCitationKeys].some((key) => key && text.includes(key));
      const titleOverlap = tokenize(node.title).filter((token) => candidate.tokenSet?.has(token)).length;
      const score = (citesNode ? 0.9 : 0) + (citesPart ? 0.25 : 0) + Math.min(0.35, titleOverlap * 0.08);
      return { candidate, score, method: citesNode ? "citation_reference" : "text_match" };
    })
    .filter((item) => item.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!guidance.length) {
    return [
      {
        status: "unresolved",
        method: "no_match",
        confidence: "none",
        note: `No relocated equivalent was found in the indexed guidance corpus as of ${new Date().toISOString().slice(0, 10)}.`,
        binding: "not applicable"
      }
    ];
  }
  return guidance.map(({ candidate, score, method }) => ({
    status: "candidate",
    method,
    confidence: score >= 0.8 ? "high" : score >= 0.45 ? "medium" : "low",
    citation: candidate.citation,
    title: candidate.title,
    sourceUrl: candidate.sourceUrl,
    binding: "non-regulatory guidance",
    note:
      method === "citation_reference"
        ? "Derived from a citation reference in the indexed guidance source."
        : "Derived by conservative text matching against indexed guidance. Treat as a lead, not an official crosswalk."
  }));
}

function buildProposedChanges(node, index) {
  const keys = new Set([node.citationKey, citationKey(farPartForNode(node)), ...(node.relatedCitationKeys || [])].filter(Boolean));
  const proposed = index.nodes
    .filter((candidate) => versionLabel(candidate) === "proposed")
    .map((candidate) => {
      const text = `${candidate.citation || ""} ${candidate.title || ""} ${candidate.bodyText || ""} ${candidate.excerpt || ""}`.toLowerCase();
      const citations = extractCitations(text);
      const citationMatch = citations.some((citation) => keys.has(citationKey(citation)));
      const tokenOverlap = tokenize(node.title).filter((token) => candidate.tokenSet?.has(token)).length;
      const score = (citationMatch ? 0.8 : 0) + Math.min(0.3, tokenOverlap * 0.06);
      return { candidate, score, citationMatch };
    })
    .filter((item) => item.score >= 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return proposed.map(({ candidate, score, citationMatch }) => ({
    status: "pending",
    citation: candidate.citation,
    title: candidate.title,
    sourceUrl: candidate.sourceUrl,
    publishedDate: candidate.effectiveDate || candidate.retrievedAt || "",
    commentDeadline: candidate.metadata?.commentDeadline || FAR_OVERHAUL_COMMENT_DEADLINE,
    docketId: candidate.metadata?.docketId || candidate.metadata?.docket_id || "",
    method: citationMatch ? "amendatory_citation_reference" : "text_match",
    confidence: score >= 0.75 ? "high" : "low",
    badge: `Proposed rule, not in effect. Comments close ${candidate.metadata?.commentDeadline || FAR_OVERHAUL_COMMENT_DEADLINE}.`
  }));
}

function buildCoverage(index, sourceAudit = null) {
  const byRegime = index.nodes.reduce((acc, node) => {
    const regime = node.regime || "Source";
    acc[regime] = (acc[regime] || 0) + 1;
    return acc;
  }, {});
  const familyCounts = new Map();
  for (const node of index.nodes) {
    if (!node.citationKey) continue;
    familyCounts.set(node.citationKey, (familyCounts.get(node.citationKey) || 0) + 1);
  }
  const parts = index.parts || [];
  const sourceNodes = index.sourceStats?.sourceDatabaseNodes || 0;
  const ecfrNodes = index.sourceStats?.ecfrDatabaseNodes || 0;
  const proposedNodes = byRegime["Federal Register proposed rule"] || 0;
  const overhaulNodes = byRegime["FAR Overhaul"] || 0;
  const guidanceNodes = index.nodes.filter(isGuidanceNode).length;
  const historyNodes = byRegime["eCFR history"] || 0;
  const currentEcfrNodes = byRegime["eCFR current full text"] || ecfrNodes;
  const familiesWithVersions = new Set([...familyCounts].filter(([, count]) => count > 1).map(([key]) => key));
  const rows = [
    {
      workstream: "A",
      label: "Version-delta engine",
      status: familiesWithVersions.size ? "partial" : "pending",
      parsed: familiesWithVersions.size,
      total: index.nodes.length,
      method: "computed_diff where no official line-out is stored",
      gap: "Official line-out parsing and agency-adoption source remain unresolved unless future refresh metadata supplies them."
    },
    {
      workstream: "B",
      label: "Guidance crosswalk",
      status: guidanceNodes ? "partial" : "pending",
      parsed: guidanceNodes,
      total: overhaulNodes,
      method: "official_crosswalk when stored, otherwise citation_reference or text_match",
      gap: "No relocated-content edge is treated as official unless the edge method says official_crosswalk."
    },
    {
      workstream: "C",
      label: "Accuracy benchmark",
      status: index.evaluation?.cases ? "interim" : "pending",
      parsed: index.evaluation?.cases || 0,
      total: 70,
      method: "local deterministic harness",
      gap: "Practitioner-reviewed 60 answerable plus 10 trap question threshold has not been met in the stored set."
    },
    {
      workstream: "D",
      label: "Proposed-rule full text and comment support",
      status: proposedNodes ? "partial" : "pending",
      parsed: proposedNodes,
      total: proposedNodes,
      method: "Federal Register indexed nodes with unresolved amendatory mappings unless metadata says parsed",
      gap: "Full amendatory-instruction parsing and docket enrichment are still coverage gaps."
    }
  ];
  return {
    generatedAt: index.generatedAt,
    sourceAuditGeneratedAt: sourceAudit?.generatedAt || "",
    posture: sourceAudit?.posture || "partial corpus",
    claim:
      sourceAudit?.claim ||
      "ClauseFinder reports parsed coverage and unresolved gaps. Full source-ingestion workstreams require reviewer signoff.",
    baselineDate: FAR_BASELINE_DATE,
    commentDeadline: FAR_OVERHAUL_COMMENT_DEADLINE,
    byRegime,
    sourceStats: index.sourceStats || {},
    parts,
    rows,
    totals: {
      nodes: index.nodes.length,
      sourceNodes,
      ecfrNodes,
      currentEcfrNodes,
      historyNodes,
      proposedNodes,
      overhaulNodes,
      guidanceNodes,
      versionFamilies: familiesWithVersions.size
    },
    caveats: [
      "Model deviation adoption is not inferred. Users must verify agency adoption.",
      "Derived crosswalk and proposed-change mappings are labeled by method and confidence.",
      "Coverage gaps are displayed instead of silently filled."
    ],
    sourceAudit: sourceAudit
      ? {
          farOverhaul: {
            sourceUrl: sourceAudit.sources?.farOverhaul?.sourceUrl,
            candidateDocuments: sourceAudit.sources?.farOverhaul?.candidateDocuments || 0,
            categoryCounts: sourceAudit.sources?.farOverhaul?.categoryCounts || {},
            gaps: sourceAudit.sources?.farOverhaul?.gaps || []
          },
          ecfr: {
            title48: sourceAudit.sources?.ecfr?.title48 || {},
            versionsEndpoint: sourceAudit.sources?.ecfr?.versionsEndpoint || {},
            sampleFullText: sourceAudit.sources?.ecfr?.sampleFullText || {},
            gaps: sourceAudit.sources?.ecfr?.gaps || []
          },
          federalRegister: {
            returned: sourceAudit.sources?.federalRegister?.returned || 0,
            total: sourceAudit.sources?.federalRegister?.total || 0,
            currentTrancheReturned: sourceAudit.sources?.federalRegister?.currentTrancheReturned || 0,
            deadlineCounts: sourceAudit.sources?.federalRegister?.deadlineCounts || {},
            currentTrancheDeadlineCounts: sourceAudit.sources?.federalRegister?.currentTrancheDeadlineCounts || {},
            documents: (sourceAudit.sources?.federalRegister?.documents || []).slice(0, 20),
            currentTrancheDocuments: (sourceAudit.sources?.federalRegister?.currentTrancheDocuments || []).slice(0, 20),
            gaps: sourceAudit.sources?.federalRegister?.gaps || []
          },
          regulationsGov: sourceAudit.sources?.regulationsGov || {},
          reviewerSignoff: sourceAudit.reviewerSignoff || [],
          demoRecommendation: sourceAudit.demoRecommendation || {}
        }
      : null
  };
}

function contextChecklist(node, context) {
  const text = `${node.title || ""} ${node.bodyText || ""} ${node.prescription || ""}`.toLowerCase();
  const checks = [
    ["Acquisition type", context.acquisitionType, "supply|service|construction|research|development|r&d"],
    ["Commerciality", context.commerciality, "commercial|noncommercial|commercial product|commercial service"],
    ["Value band", context.valueBand, "micro-purchase|simplified acquisition|threshold|\\$|dollar"],
    ["Competition", context.competition, "full and open|set-aside|sole source|single source|competition"],
    ["Funding layer", context.fundingLayer, "air force|department of the air force|dod|defense"],
    ["Urgency", context.urgency, "urgent|emergency|unusual and compelling"]
  ];
  return checks.map(([label, value, fallbackPattern]) => {
    const known = value && value !== "Not sure" && value !== "Normal";
    const cue = String(value || "").toLowerCase().split(" ")[0];
    const explicit = known && (text.includes(cue) || new RegExp(fallbackPattern, "i").test(text));
    return {
      label,
      value: value || "Not sure",
      status: !known ? "unknown" : explicit ? "met by text signal" : "not explicit in retrieved text",
      explanation: !known
        ? "The user did not provide this fact."
        : explicit
          ? "The retrieved text contains a matching applicability signal."
          : "The retrieved text does not make this condition explicit. A human reviewer should verify."
    };
  });
}

function buildAirForceStack(node) {
  const farPart = farPartForNode(node);
  return [
    {
      label: `FAR Part ${farPart || "unknown"}`,
      status: familyForPart(node.part) === "FAR" ? "Result is in the base FAR layer" : "Base layer to inspect",
      url: farPart ? `https://www.acquisition.gov/far/part-${farPart}` : "https://www.acquisition.gov/far"
    },
    {
      label: `DFARS Part ${farPart ? Number(farPart) + 200 : "unknown"}`,
      status: familyForPart(node.part) === "DFARS" ? "Result is in the DoD supplement layer" : "DoD supplement counterpart",
      url: farPart ? `https://www.acquisition.gov/dfars/part-${Number(farPart) + 200}` : "https://www.acquisition.gov/dfars"
    },
    {
      label: `DAFFARS Part ${farPart ? Number(farPart) + 5300 : "unknown"}`,
      status: familyForPart(node.part) === "DAFFARS" ? "Result is in the Air Force supplement layer" : "Air Force supplement counterpart",
      url: farPart ? `https://www.acquisition.gov/daffars/part-${Number(farPart) + 5300}` : "https://www.acquisition.gov/daffars"
    },
    {
      label: "DAFFARS MP",
      status: "Check Mandatory Procedures when local process detail matters",
      url: "https://www.acquisition.gov/daffars"
    }
  ];
}

function buildClausePassport(node, context, index) {
  const prescribedBy = extractPrescribedBy(node);
  const versions = buildVersions(node, index);
  const checklist = contextChecklist(node, context);
  const missingFacts = checklist.filter((item) => item.status === "unknown").map((item) => item.label);
  const text = `${node.title || ""} ${node.bodyText || ""} ${node.prescription || ""}`;
  const delta = buildDelta(node, index);
  const proposedChanges = buildProposedChanges(node, index);
  const crosswalks = buildCrosswalks(node, index);
  return {
    origin: node.regime || "Public source",
    sourceUrl: node.sourceUrl,
    retrievedAt: node.retrievedAt || "",
    effectiveDate: node.effectiveDate || node.snapshotDate || "",
    versionStatus: versionLabel(node),
    bindingStatus: bindingLabel(node),
    prescribedBy,
    appliesWhen: node.prescription || "No prescription was extracted. Use the indexed text and source link for reviewer verification.",
    doesNotApplyWhen:
      "Facts differ from the prescription, the action uses a different version date, or a FAR, DFARS, DAFFARS, or deviation source changes the analysis.",
    missingFacts,
    checklist,
    airForceStack: buildAirForceStack(node),
    delta,
    crosswalks,
    proposedChanges,
    commentSupport: proposedChanges.map((item) => ({
      docketId: item.docketId,
      commentDeadline: item.commentDeadline,
      sourceUrl: item.sourceUrl,
      method: item.method,
      confidence: item.confidence
    })),
    diff: {
      status: delta.available ? "comparison available" : "single indexed state",
      summary: delta.available
        ? delta.summary
        : "Only one indexed state is available for this result. Use the source link for full verification.",
      beforeLabel: delta.from?.date || "",
      afterLabel: delta.to?.date || node.effectiveDate || "",
      method: delta.method,
      confidence: delta.confidence,
      textSignals: [
        text.includes("shall") ? "Mandatory-language signal found in retrieved text." : "No strong mandatory-language signal found in the retrieved text excerpt.",
        text.includes("commercial") ? "Commerciality signal found." : "Commerciality is not explicit in the retrieved text excerpt.",
        text.includes("threshold") ? "Threshold signal found." : "Threshold signal is not explicit in the retrieved text excerpt."
      ]
    },
    redTeamChecks: [
      "Is this a clause, provision, prescription, policy section, deviation, or proposed-rule source?",
      "Does the solicitation or award date match the version shown?",
      "Does a DFARS, DAFFARS, or Mandatory Procedure layer add or limit the base FAR authority?",
      "Which user-provided facts remain unknown or only weakly matched?",
      "Would a contracting officer still need a separate source, threshold, or file-documentation decision?"
    ]
  };
}

async function loadEvaluationSummary() {
  if (evaluationCache) return evaluationCache;
  let benchmark = null;
  try {
    benchmark = JSON.parse(await readFile(BENCHMARK_RESULTS_PATH, "utf8"));
  } catch {
    benchmark = null;
  }
  try {
    const raw = await readFile(ACCURACY_CASES_PATH, "utf8");
    const cases = JSON.parse(raw);
    const answerable = cases.filter((item) => item.expectedBehavior !== "no_match");
    const traps = cases.filter((item) => item.expectedBehavior === "no_match" || item.expectedBehavior === "caveat_required");
    evaluationCache = {
      label: benchmark?.label || "Local gold-set harness",
      cases: cases.length,
      reviewedCases: cases.filter((item) => Array.isArray(item.reviewedBy) && item.reviewedBy.length).length,
      answerableCases: answerable.length,
      trapCases: traps.length,
      lastRun: benchmark?.generatedAt || "latest backend test run",
      topOneCases: cases.filter((item) => item.expectedTopOne?.length).length,
      topFiveCases: cases.filter((item) => item.expectedTopFive?.length).length,
      topOneRate: benchmark?.topOneRate ?? null,
      topThreeRate: benchmark?.topThreeRate ?? null,
      topFiveRate: benchmark?.topFiveRate ?? null,
      mrr: benchmark?.meanReciprocalRank ?? null,
      refusalPrecision: benchmark?.refusalPrecision ?? null,
      refusalRecall: benchmark?.refusalRecall ?? null,
      citationResolutionRate: benchmark?.citationResolutionRate ?? null,
      benchmarkStatus:
        cases.length >= 70 && cases.every((item) => Array.isArray(item.reviewedBy) && item.reviewedBy.length)
          ? "reviewed"
          : "interim, partial corpus",
      note:
        benchmark?.note ||
        "Use npm --prefix backend test before demos. The public UI reports interim metrics until the practitioner-reviewed set reaches the design threshold."
    };
  } catch {
    evaluationCache = {
      label: "Local gold-set harness",
      cases: 0,
      lastRun: "",
      topOneCases: 0,
      topFiveCases: 0,
      note: "Accuracy case file was unavailable."
    };
  }
  return evaluationCache;
}

async function loadSourceCoverageReport() {
  if (sourceCoverageCache) return sourceCoverageCache;
  try {
    sourceCoverageCache = JSON.parse(await readFile(SOURCE_COVERAGE_REPORT_PATH, "utf8"));
  } catch {
    sourceCoverageCache = null;
  }
  return sourceCoverageCache;
}

function rowToNode(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: row.id,
    citation: row.citation,
    title: row.title,
    type: row.type,
    part: row.part,
    regime: row.regime,
    sourceUrl: row.source_url,
    retrievedAt: dateValue(row.retrieved_at),
    effectiveDate: dateValue(row.effective_date),
    snapshotDate: dateValue(row.snapshot_date),
    snapshotType: row.snapshot_type,
    excerpt: row.excerpt || "",
    bodyText: row.body_text || "",
    prescription: metadata.prescription || "",
    hierarchyPath: ["eCFR", `Title ${metadata.title || 48}`, `Part ${row.part}`],
    related: [],
    metadata
  };
}

function sourceRowToNode(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const hierarchyPath = Array.isArray(row.hierarchy_path) ? row.hierarchy_path : [];
  const related = Array.isArray(row.related) ? row.related : [];
  return {
    id: row.id,
    citation: row.citation,
    title: row.title,
    type: row.type,
    part: row.part,
    regime: row.regime,
    sourceUrl: row.source_url,
    retrievedAt: dateValue(row.retrieved_at),
    effectiveDate: dateValue(row.effective_date),
    excerpt: row.excerpt || "",
    bodyText: row.body_text || "",
    prescription: row.prescription || metadata.prescription || "",
    hierarchyPath,
    related,
    metadata
  };
}

function dbPool() {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=require") ? undefined : { rejectUnauthorized: false }
  });
}

async function loadSourceDatabaseNodes() {
  if (!DATABASE_SEARCH_ENABLED || !process.env.DATABASE_URL) return [];
  const pool = dbPool();
  try {
    const result = await pool.query(
      `select
        id, citation, title, type, part, regime, source_url, retrieved_at,
        effective_date, excerpt, body_text, prescription, hierarchy_path, related, metadata
      from source_nodes
      order by
        case
          when regime = 'FAR' then 0
          when regime = 'DFARS' then 1
          when regime = 'DAFFARS' then 2
          else 3
        end,
        citation asc
      limit $1`,
      [DATABASE_NODE_LIMIT]
    );
    return result.rows.map(sourceRowToNode);
  } catch (error) {
    if (!sourceDatabaseLoadWarningLogged) {
      console.warn(`source_nodes database corpus unavailable: ${error?.message || error}`);
      sourceDatabaseLoadWarningLogged = true;
    }
    return [];
  } finally {
    await pool.end();
  }
}

async function loadEcfrDatabaseNodes() {
  if (!DATABASE_SEARCH_ENABLED || !process.env.DATABASE_URL) return [];
  const pool = dbPool();
  try {
    const result = await pool.query(
      `select
        id, citation, title, type, part, regime, source_url, retrieved_at,
        effective_date, snapshot_date, snapshot_type, excerpt, body_text, metadata
      from ecfr_nodes
      order by
        case when snapshot_type = 'current' then 0 else 1 end,
        snapshot_date desc,
        citation asc
      limit $1`,
      [DATABASE_NODE_LIMIT]
    );
    return result.rows.map(rowToNode);
  } catch (error) {
    if (!ecfrDatabaseLoadWarningLogged) {
      console.warn(`eCFR database search overlay unavailable: ${error?.message || error}`);
      ecfrDatabaseLoadWarningLogged = true;
    }
    return [];
  } finally {
    await pool.end();
  }
}

export async function loadIndex() {
  if (indexCache) return indexCache;
  const raw = await readFile(INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const evaluation = await loadEvaluationSummary();
  const sourceAudit = await loadSourceCoverageReport();
  const staticNodes = parsed.nodes || [];
  const sourceDatabaseNodes = await loadSourceDatabaseNodes();
  const primaryNodes = sourceDatabaseNodes.length ? sourceDatabaseNodes : staticNodes;
  const ecfrDatabaseNodes = await loadEcfrDatabaseNodes();
  const nodes = [...primaryNodes, ...ecfrDatabaseNodes];
  const docFreq = new Map();
  let totalLength = 0;

  for (const node of nodes) {
    node.citationKey = citationKey(node.citation);
    node.relatedCitationKeys = (node.related || []).map((item) => citationKey(item.label)).filter(Boolean);
    node.searchTokens = tokenize(
      `${node.citation} ${node.title} ${node.type} ${node.bodyText} ${node.prescription || ""}`
    );
    node.tokenSet = new Set(node.searchTokens);
    totalLength += node.searchTokens.length || 1;
    for (const token of node.tokenSet) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  indexCache = {
    ...parsed,
    nodes,
    sourceStats: {
      staticNodes: sourceDatabaseNodes.length ? 0 : staticNodes.length,
      sourceDatabaseNodes: sourceDatabaseNodes.length,
      ecfrDatabaseNodes: ecfrDatabaseNodes.length
    },
    evaluation,
    sourceAudit,
    docFreq,
    averageLength: nodes.length ? totalLength / nodes.length : 1
  };
  indexCache.coverage = buildCoverage(indexCache, sourceAudit);
  return indexCache;
}

function contextBoost(node, context) {
  const joined = `${node.title} ${node.bodyText} ${node.prescription || ""}`.toLowerCase();
  let score = 0;
  const reasons = [];
  if (context.acquisitionType !== "Not sure" && joined.includes(context.acquisitionType.toLowerCase())) {
    score += 0.12;
    reasons.push(context.acquisitionType);
  }
  if (context.commerciality !== "Not sure" && joined.includes("commercial")) {
    score += context.commerciality === "Commercial" ? 0.14 : 0.05;
    reasons.push(context.commerciality);
  }
  if (context.competition !== "Not sure" && joined.includes(context.competition.toLowerCase().split(" ")[0])) {
    score += 0.08;
    reasons.push(context.competition);
  }
  if (context.valueBand !== "Not sure" && /micro-purchase|simplified acquisition|threshold|\$/.test(joined)) {
    score += 0.11;
    reasons.push(context.valueBand);
  }
  if (context.fundingLayer === "Air Force") {
    score += 0.04;
    reasons.push("Air Force review context");
  }
  return { score, reasons };
}

function bm25(node, queryTokens, index) {
  const k1 = 1.35;
  const b = 0.72;
  const counts = new Map();
  for (const token of node.searchTokens) counts.set(token, (counts.get(token) || 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    const tf = counts.get(token) || 0;
    if (!tf) continue;
    const df = index.docFreq.get(token) || 0;
    const idf = Math.log(1 + (index.nodes.length - df + 0.5) / (df + 0.5));
    const denominator = tf + k1 * (1 - b + b * (node.searchTokens.length / index.averageLength));
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

function hasPrescriptionUseCue(query) {
  return /as prescribed in/i.test(String(query || "")) && /use the following (clause|provision)/i.test(String(query || ""));
}

function citationHitScore(node, queryCitations, query) {
  if (!queryCitations.length) return 0;
  let score = 0;
  const prescribedClauseCue = hasPrescriptionUseCue(query) && /clause|provision/i.test(String(node.type || ""));
  for (const queryCitation of queryCitations) {
    if (node.citationKey === queryCitation) score = Math.max(score, 1);
    else if (node.citationKey.startsWith(queryCitation) || queryCitation.startsWith(node.citationKey)) {
      score = Math.max(score, 0.82);
    } else if (node.relatedCitationKeys?.includes(queryCitation)) {
      score = Math.max(score, prescribedClauseCue ? 1.08 : 0.55);
    }
  }
  return score;
}

function normalizedPhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCueBoost(node, query) {
  const rawTitle = String(node.title || "").toLowerCase().replace(/[.:;\s]+$/g, "").trim();
  const rawQuery = String(query || "").toLowerCase();
  if (rawTitle.length >= 24 && new RegExp(`\\b${escapeRegex(rawTitle)}\\s*[.:;]`).test(rawQuery)) {
    return 10;
  }
  const title = normalizedPhrase(node.title);
  if (title.length < 24) return 0;
  return normalizedPhrase(query).includes(title) ? 2 : 0;
}

function domainBoost(node, query, context) {
  const text = String(query || "").toLowerCase();
  let boost = 0;
  if (/(micro-purchase|micro purchase|purchase card|simplified acquisition|\b9000\b|\$?\s*9,?000|supply buy|buy.*options)/.test(text)) {
    if (String(node.citation).startsWith("13.")) boost += 7;
    if (node.citation === "13.201") boost += 10;
    if (/micro-purchase|simplified acquisition|purchase card/i.test(`${node.title} ${node.bodyText}`)) boost += 3;
    if (String(node.citation).startsWith("25.")) boost -= 6;
  }
  if (/(sam|system for award management|unique entity|registration|registered)/.test(text)) {
    if (/^(4\.11|52\.204)/.test(String(node.citation))) boost += 1.6;
    if (/system for award management|sam registration|registered in sam/i.test(`${node.title} ${node.bodyText}`)) boost += 1.2;
  }
  if (/(electronic funds transfer|\beft\b|payment information|payment by electronic funds transfer)/.test(text)) {
    if (String(node.citation) === "52.232-33") boost += 11;
    if (/payment by electronic funds transfer|system for award management/i.test(`${node.title} ${node.bodyText}`)) boost += 2.5;
    if (/^(4\.11|52\.204)/.test(String(node.citation))) boost -= 1.5;
  }
  if (/(safeguard|covered contractor information|cyber|information system|security requirement)/.test(text)) {
    if (/52\.204-(2|21)/.test(String(node.citation))) boost += 2;
    if (/safeguarding|covered contractor information systems|security requirements/i.test(`${node.title} ${node.bodyText}`)) boost += 1.1;
  }
  if (context.commerciality === "Commercial" && String(node.citation).startsWith("12.")) {
    boost += 0.4;
  }
  return boost;
}

function plainReason(result, queryTokens, contextReasons, citationScore) {
  if (citationScore >= 1) {
    return "The query names this citation directly.";
  }
  if (citationScore > 0) {
    return "The query appears to name this citation family or a cited related authority.";
  }
  const matched = queryTokens.filter((token) => result.tokenSet.has(token)).slice(0, 5);
  const context = contextReasons.length ? ` Context signals: ${contextReasons.join(", ")}.` : "";
  return matched.length
    ? `Matched acquisition terms: ${matched.join(", ")}.${context}`
    : `Ranked by context and related FAR language.${context}`;
}

function noCandidateAnswer(reason) {
  return {
    summary: reason,
    caveats: [
      "ClauseFinder searches public acquisition-rule sources and returns candidate authorities only. It does not answer general preference, office, catering, or non-procurement questions.",
      "No compliance conclusion is provided. Reframe the question as a FAR, DFARS, DAFFARS, eCFR, deviation, proposed-rule, contract clause, prescription, or acquisition scenario if you need regulatory research."
    ],
    bestFitCitations: []
  };
}

export async function searchFar({ query, context = {}, limit = 8, includeAnswer = true }) {
  const trimmed = String(query || "").trim();
  const inferredContext = inferContext(trimmed, context);
  const sensitiveHits = detectSensitive(trimmed);
  if (!trimmed || sensitiveHits.length) {
    return {
      query: trimmed,
      context: inferredContext,
      sensitiveHits,
      results: [],
      noMatchReason: sensitiveHits.length
        ? "Sensitive-looking text was detected. Describe contract attributes instead."
        : "Enter a FAR question or contract scenario."
    };
  }

  const index = await loadIndex();
  const queryTokens = tokenize(trimmed);
  const queryCitations = extractCitations(trimmed);
  const scopeReason =
    "No acquisition-rule signal was detected. Ask a FAR, DFARS, DAFFARS, eCFR, deviation, proposed-rule, clause, prescription, or contract-scenario question.";
  if (!isLikelyAcquisitionQuery(trimmed, queryTokens, queryCitations)) {
    return {
      query: trimmed,
      context: inferredContext,
      sensitiveHits,
      generatedAt: index.generatedAt,
      sourceBaseUrl: index.sourceBaseUrl,
      totalNodes: index.nodes.length,
      results: [],
      noMatchReason: scopeReason,
      answer: includeAnswer ? noCandidateAnswer(scopeReason) : null
    };
  }
  const rawScores = index.nodes.map((node) => {
    const lexical = bm25(node, queryTokens, index);
    const citationScore = citationHitScore(node, queryCitations, trimmed);
    const ctx = contextBoost(node, inferredContext);
    const phrase = node.bodyText.toLowerCase().includes(trimmed.toLowerCase()) ? 0.5 : 0;
    const composite = lexical + citationScore * 18 + ctx.score + phrase + titleCueBoost(node, trimmed) + domainBoost(node, trimmed, inferredContext);
    return { node, lexical, citationScore, contextScore: ctx.score, contextReasons: ctx.reasons, composite };
  });
  const max = Math.max(...rawScores.map((item) => item.composite), 1);
  const results = rawScores
    .filter((item) => item.composite > 0)
    .sort((a, b) => {
      if (queryCitations.length && Math.abs(b.citationScore - a.citationScore) >= 0.2) {
        return b.citationScore - a.citationScore;
      }
      return b.composite - a.composite;
    })
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map((item) => {
      const normalized = item.composite / max;
      const semantic = Math.min(1, item.lexical / Math.max(max, 1));
      const keyword = queryTokens.length
        ? queryTokens.filter((token) => item.node.tokenSet.has(token)).length / queryTokens.length
        : 0;
      const applicability = Math.min(1, item.contextScore * 4);
      const supplement = inferredContext.fundingLayer === "Air Force" ? 0.7 : 0.45;
      return {
        id: item.node.id,
        citation: item.node.citation,
        title: item.node.title,
        type: item.node.type,
        part: item.node.part,
        regime: item.node.regime,
        sourceUrl: item.node.sourceUrl,
        retrievedAt: item.node.retrievedAt,
        bodyText: item.node.bodyText,
        excerpt: item.node.excerpt,
        prescription: item.node.prescription,
        hierarchyPath: item.node.hierarchyPath,
        score: {
          composite: Number(normalized.toFixed(3)),
          semantic: Number(semantic.toFixed(3)),
          keyword: Number(keyword.toFixed(3)),
          applicability: Number(applicability.toFixed(3)),
          supplement: Number(supplement.toFixed(3))
        },
        whyRelevant: plainReason(item.node, queryTokens, item.contextReasons, item.citationScore),
        mightNotApply:
          "This is a candidate authority, not a compliance verdict. Verify the prescription, dates, agency supplements, and contract facts.",
        badges: [
          versionLabel(item.node) === "proposed" ? `Proposed rule, not in effect. Comments close ${FAR_OVERHAUL_COMMENT_DEADLINE}.` : "",
          versionLabel(item.node) === "overhaul deviation" ? "Model deviation. Verify buying-agency adoption." : "",
          isGuidanceNode(item.node) ? "Non-regulatory guidance." : "",
          buildProposedChanges(item.node, index).length ? `In flux. Proposed-rule material may affect this area by ${FAR_OVERHAUL_COMMENT_DEADLINE}.` : ""
        ].filter(Boolean),
        version: {
          label: versionLabel(item.node),
          effectiveStart: item.node.effectiveDate || item.node.snapshotDate || ""
        },
        related: item.node.related || [],
        supplementChain: buildAirForceStack(item.node),
        clausePassport: buildClausePassport(item.node, inferredContext, index),
        versions: buildVersions(item.node, index)
      };
    });

  const response = {
    query: trimmed,
    context: inferredContext,
    sensitiveHits,
    generatedAt: index.generatedAt,
    sourceBaseUrl: index.sourceBaseUrl,
    totalNodes: index.nodes.length,
    results,
    noMatchReason: results.length ? "" : "No candidate authority crossed the search threshold."
  };
  response.answer = includeAnswer
    ? await groundedAnswer({ query: trimmed, context: inferredContext, results })
    : null;
  return response;
}

export async function getMeta() {
  const index = await loadIndex();
  return {
    generatedAt: index.generatedAt,
    sourceBaseUrl: index.sourceBaseUrl,
    totalNodes: index.nodes.length,
    parts: index.parts || [],
    sourceStats: index.sourceStats || {},
    evaluation: index.evaluation,
    coverage: index.coverage
  };
}

export async function getCoverage() {
  const index = await loadIndex();
  return index.coverage;
}
