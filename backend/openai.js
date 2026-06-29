const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function detectSensitive(value) {
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

function inferContext(question, provided = {}) {
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
  return context;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function normalizeQuestions(value, fallbackQuestions) {
  if (!Array.isArray(value)) return fallbackQuestions;
  return value
    .filter((question) => question && typeof question === "object" && question.id && question.label)
    .slice(0, 4)
    .map((question) => ({
      id: String(question.id),
      label: String(question.label),
      why: String(question.why || "This can affect which clause candidates rank highest."),
      options: Array.isArray(question.options) && question.options.length
        ? [...new Set(["Not sure", ...question.options.map((option) => String(option))])]
        : ["Not sure"]
    }));
}

function normalizeStringList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.citation || item.title || item.note || JSON.stringify(item);
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}

async function openaiJson({ system, user, temperature = 0.1 }) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body.slice(0, 300)}`);
  }
  const payload = await response.json();
  return parseJson(payload.choices?.[0]?.message?.content || "{}");
}

export async function clarifyQuestion({ query, context = {} }) {
  const trimmed = String(query || "").trim();
  const sensitiveHits = detectSensitive(trimmed);
  const inferredContext = inferContext(trimmed, context);
  if (!trimmed || sensitiveHits.length) {
    return {
      query: trimmed,
      context: inferredContext,
      sensitiveHits,
      questions: [],
      readyToSearch: false,
      note: sensitiveHits.length
        ? "Sensitive-looking text was detected. Ask the user to describe attributes instead."
        : "No question was provided."
    };
  }

  const fallbackQuestions = deterministicQuestions(inferredContext);
  const ai = await openaiJson({
    system:
      "You are an acquisition-law search intake assistant. Ask only clarifying questions that materially improve retrieval. Do not give legal advice. Do not mention citations unless the user already provided one. Output strict JSON.",
    user: JSON.stringify({
      task:
        "Given the user question and current context, return JSON with keys: context, questions, readyToSearch, note. questions must be an array of at most 4 objects with id, label, why, options. Each options array should include 'Not sure'.",
      question: trimmed,
      context: inferredContext,
      allowedQuestionIds: [
        "acquisitionType",
        "commerciality",
        "valueBand",
        "competition",
        "fundingLayer",
        "urgency",
        "awardTiming",
        "contractStage"
      ]
    })
  }).catch(() => null);

  if (!ai) {
    return {
      query: trimmed,
      context: inferredContext,
      sensitiveHits: [],
      questions: fallbackQuestions,
      readyToSearch: fallbackQuestions.length === 0,
      note: "Deterministic clarification fallback used."
    };
  }

  return {
    query: trimmed,
    context: { ...inferredContext, ...(ai.context || {}) },
    sensitiveHits: [],
    questions: normalizeQuestions(ai.questions, fallbackQuestions),
    readyToSearch: Boolean(ai.readyToSearch) || !Array.isArray(ai.questions) || ai.questions.length === 0,
    note: ai.note || ""
  };
}

function deterministicQuestions(context) {
  const questions = [];
  if (context.acquisitionType === "Not sure") {
    questions.push({
      id: "acquisitionType",
      label: "What is being acquired?",
      why: "Clause applicability often turns on supply, service, construction, or R&D.",
      options: ["Not sure", "Supply", "Service", "Construction", "R&D", "Other"]
    });
  }
  if (context.commerciality === "Not sure") {
    questions.push({
      id: "commerciality",
      label: "Is this commercial?",
      why: "Commercial product or service determinations change the clause set.",
      options: ["Not sure", "Commercial", "Noncommercial"]
    });
  }
  if (context.valueBand === "Not sure") {
    questions.push({
      id: "valueBand",
      label: "What is the estimated value band?",
      why: "Thresholds affect simplified acquisition and clause requirements.",
      options: [
        "Not sure",
        "At or near micro-purchase",
        "Below simplified acquisition",
        "Above simplified acquisition threshold",
        "Above $5M"
      ]
    });
  }
  return questions;
}

export async function groundedAnswer({ query, context, results }) {
  const top = (results || []).slice(0, 8).map((result) => ({
    citation: result.citation,
    title: result.title,
    regime: result.regime,
    sourceUrl: result.sourceUrl,
    retrievedAt: result.retrievedAt || "",
    effectiveStart: result.version?.effectiveStart || "",
    excerpt: result.excerpt || result.bodyText?.slice(0, 900),
    prescription: result.prescription || ""
  }));
  if (!process.env.OPENAI_API_KEY || !top.length) {
    return {
      summary:
        "Review the ranked candidate authorities. No AI summary was generated for this response.",
      caveats: ["Human verification is required."],
      bestFitCitations: top.map((item) => item.citation).slice(0, 5)
    };
  }
  const ai = await openaiJson({
    system:
      "You explain acquisition-rule search results. Use only the provided retrieved candidates. Never assert compliance. Never say a clause must be used. Return strict JSON.",
    user: JSON.stringify({
      task:
        "Return JSON with summary, caveats, bestFitCitations. summary should be concise and cite candidate citations inline in plain text. caveats must identify missing facts or source limits. Do not say later updates are excluded unless a provided candidate says that. Tell users to verify current source pages when currency matters. bestFitCitations must be citations from candidates only.",
      question: query,
      context,
      candidates: top
    })
  }).catch(() => null);
  if (!ai) {
    return {
      summary: "Review the ranked candidate authorities. AI explanation failed closed.",
      caveats: ["Human verification is required."],
      bestFitCitations: top.map((item) => item.citation).slice(0, 5)
    };
  }
  return {
    summary: String(ai.summary || "Review the ranked candidate authorities."),
    caveats: normalizeStringList(ai.caveats, ["Human verification is required."]),
    bestFitCitations: normalizeStringList(ai.bestFitCitations, top.map((item) => item.citation).slice(0, 5)).slice(0, 5)
  };
}
