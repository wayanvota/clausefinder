import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { groundedAnswer } from "./openai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.FAR_INDEX_PATH || join(__dirname, "data", "far-index.json");
const DATABASE_SEARCH_ENABLED = process.env.ECFR_SEARCH_DATABASE !== "false";
const DATABASE_NODE_LIMIT = Number(process.env.ECFR_SEARCH_NODE_LIMIT || 50000);

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

let indexCache;
let databaseLoadWarningLogged = false;

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

async function loadDatabaseNodes() {
  if (!DATABASE_SEARCH_ENABLED || !process.env.DATABASE_URL) return [];
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=require") ? undefined : { rejectUnauthorized: false }
  });
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
    if (!databaseLoadWarningLogged) {
      console.warn(`eCFR database search overlay unavailable: ${error?.message || error}`);
      databaseLoadWarningLogged = true;
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
  const staticNodes = parsed.nodes || [];
  const databaseNodes = await loadDatabaseNodes();
  const nodes = [...staticNodes, ...databaseNodes];
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
      staticNodes: staticNodes.length,
      ecfrDatabaseNodes: databaseNodes.length
    },
    docFreq,
    averageLength: nodes.length ? totalLength / nodes.length : 1
  };
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
        version: {
          label: "current",
          effectiveStart: item.node.effectiveDate || ""
        },
        versions: [
          {
            label: "current",
            date: item.node.effectiveDate || "current indexed source",
            note: `Current indexed ${item.node.regime || "regulatory"} source.`,
            sourceUrl: item.node.sourceUrl
          }
        ],
        related: item.node.related || [],
        supplementChain: [
          { label: item.node.citation, status: `${item.node.regime || "Source"} hit`, url: item.node.sourceUrl },
          { label: "FAR", status: "Indexed", url: "https://www.acquisition.gov/far" },
          { label: "DFARS", status: "Indexed", url: "https://www.acquisition.gov/dfars" },
          { label: "DAFFARS", status: "Indexed", url: "https://www.acquisition.gov/daffars" }
        ]
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
    sourceStats: index.sourceStats || {}
  };
}
