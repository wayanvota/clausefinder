import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { groundedAnswer } from "./openai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.FAR_INDEX_PATH || join(__dirname, "data", "far-index.json");

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

export async function loadIndex() {
  if (indexCache) return indexCache;
  const raw = await readFile(INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const nodes = parsed.nodes || [];
  const docFreq = new Map();
  let totalLength = 0;

  for (const node of nodes) {
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

function exactCitationHit(node, query) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ");
  return normalized.includes(node.citation.toLowerCase()) ? 1 : 0;
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

function plainReason(result, queryTokens, contextReasons) {
  if (exactCitationHit(result, queryTokens.join(" "))) {
    return "The query names this citation directly.";
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
  const rawScores = index.nodes.map((node) => {
    const lexical = bm25(node, queryTokens, index);
    const exact = exactCitationHit(node, trimmed);
    const ctx = contextBoost(node, inferredContext);
    const phrase = node.bodyText.toLowerCase().includes(trimmed.toLowerCase()) ? 0.5 : 0;
    const composite = lexical + exact * 4 + ctx.score + phrase + domainBoost(node, trimmed, inferredContext);
    return { node, lexical, exact, contextScore: ctx.score, contextReasons: ctx.reasons, composite };
  });
  const max = Math.max(...rawScores.map((item) => item.composite), 1);
  const results = rawScores
    .filter((item) => item.composite > 0)
    .sort((a, b) => b.composite - a.composite)
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
        whyRelevant: plainReason(item.node, queryTokens, item.contextReasons),
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
    parts: index.parts || []
  };
}
