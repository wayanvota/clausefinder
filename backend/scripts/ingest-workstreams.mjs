import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const INDEX_PATH = process.env.FAR_INDEX_PATH || join(DATA_DIR, "far-index.json");
const COVERAGE_PATH = process.env.SOURCE_COVERAGE_REPORT_PATH || join(DATA_DIR, "source-coverage-report.json");
const OUT_PATH = process.env.WORKSTREAM_INGESTION_PATH || join(DATA_DIR, "workstream-ingestion-report.json");
const CROSSWALK_PATH = process.env.CROSSWALK_REVIEW_PATH || join(DATA_DIR, "crosswalk-review-set.json");
const BENCHMARK_PATH = process.env.BENCHMARK_CANDIDATES_PATH || join(DATA_DIR, "benchmark-candidates.jsonl");
const AMENDATORY_PATH = process.env.AMENDATORY_PATH || join(DATA_DIR, "proposed-rule-amendatory-instructions.json");
const USER_AGENT = "ClauseFinder workstream ingestion; public-source parsing; contact: wayan.com";
const PART_LIMIT = Number(process.env.RFO_PART_LIMIT || 0);
const PDF_LIMIT = Number(process.env.RFO_PDF_LIMIT || 40);

const FAR_PART_GUIDE = "https://www.acquisition.gov/far-overhaul/far-part-deviation-guide";
const PRACTITIONER_ALBUMS = "https://www.acquisition.gov/far-overhaul/practitioner-albums";

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"'
};

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => ENTITY_MAP[entity] || " ");
}

function stripMarkup(value) {
  return decodeEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function absoluteUrl(href, base) {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return "";
  }
}

function extractLinks(html, base) {
  return [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, label]) => ({ url: absoluteUrl(href, base), label: stripMarkup(label) }))
    .filter((item) => item.url && item.label);
}

async function fetchText(url, as = "text") {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${url}`);
  return as === "arrayBuffer" ? response.arrayBuffer() : response.text();
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(the|and|for|from|with|that|this|are|was|were|shall|must|will|part|section)$/.test(word));
}

function citationKey(value) {
  return String(value || "").replace(/[^0-9.-]/g, "");
}

function extractCitations(value) {
  return [...new Set([...String(value || "").matchAll(/\b(?:FAR|DFARS|DAFFARS|48\s+CFR)?\s*(\d{1,4}\.\d{1,4}(?:-\d{1,4})?)\b/gi)].map((match) => match[1]))];
}

function parsePartNumber(value) {
  const match = String(value || "").match(/\bpart[-\s_]*(\d{1,2})\b/i) || String(value || "").match(/far-overhaul-part-(\d{1,2})/i);
  return match ? Number(match[1]) : null;
}

async function inventoryRfoPartPages() {
  const html = await fetchText(FAR_PART_GUIDE);
  const links = extractLinks(html, FAR_PART_GUIDE);
  const partPages = Array.from(
    new Map(
      links
        .filter((link) => /far-overhaul-part-\d+$/i.test(link.url))
        .map((link) => [link.url, { ...link, part: parsePartNumber(link.url) }])
    ).values()
  ).sort((a, b) => Number(a.part || 0) - Number(b.part || 0));
  const pdfs = Array.from(
    new Map(
      links
        .filter((link) => /\.pdf(?:$|\?)/i.test(link.url) && /deviation|RFO|FAR|part/i.test(`${link.url} ${link.label}`))
        .map((link) => [link.url, { ...link, part: parsePartNumber(link.url), agency: link.label }])
    ).values()
  );
  const lineOutLinks = pdfs.filter((link) => /line.?out|line.?in|redline|strike|strikethrough/i.test(`${link.url} ${link.label}`));
  return { partPages, pdfs, lineOutLinks };
}

function parseRfoHtmlSections({ html, url, part, retrievedAt }) {
  const articleMatches = [...html.matchAll(/<article\b[^>]*\bid=["']FAR_(\d{1,2})_(\d{3,4})(?:_(\d+))?["'][^>]*>/gi)].map(
    (match, index, matches) => {
      const end = matches[index + 1]?.index ?? html.length;
      const block = html.slice(match.index, end);
      const heading = block.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i)?.[1] || "";
      const afterHeading = block.replace(/^[\s\S]*?<\/h[2-6]>/i, "");
      const citation = `${match[1]}.${match[2].replace(/^0+/, "")}${match[3] ? `-${match[3]}` : ""}`;
      return {
        anchor: `FAR_${match[1]}_${match[2]}${match[3] ? `_${match[3]}` : ""}`,
        citation,
        heading,
        body: afterHeading
      };
    }
  );
  const nodes = [];
  for (const match of articleMatches) {
    const heading = stripMarkup(match.heading);
    const body = stripMarkup(match.body);
    const citation = match.citation;
    if (!citation || body.length < 30 || /reserved/i.test(`${heading} ${body}`)) continue;
    nodes.push({
      id: `rfo-html-${citation.replace(/\./g, "-").replace(/[^a-z0-9-]/gi, "-")}`,
      citation,
      title: heading.replace(citation, "").replace(/^[\s.-]+/, "").trim() || heading,
      part: String(part || citation.split(".")[0]),
      regime: "FAR Overhaul deviation text",
      versionLabel: "deviation",
      sourceUrl: `${url}#${match.anchor}`,
      retrievedAt,
      bodyText: body.slice(0, 16000),
      parseMethod: "official_html_part_page",
      confidence: "high"
    });
  }
  return nodes;
}

async function ingestRfoHtmlParts(partPages, retrievedAt) {
  const selected = PART_LIMIT ? partPages.slice(0, PART_LIMIT) : partPages;
  const nodes = [];
  const failures = [];
  for (const page of selected) {
    try {
      const html = await fetchText(page.url);
      const parsed = parseRfoHtmlSections({ html, url: page.url, part: page.part, retrievedAt });
      nodes.push(...parsed);
    } catch (error) {
      failures.push({ sourceUrl: page.url, message: String(error?.message || error) });
    }
  }
  return { nodes, failures, attempted: selected.length, totalPartPages: partPages.length };
}

async function pdfToText(url, tmpRoot) {
  const ab = await fetchText(url, "arrayBuffer");
  const pdfPath = join(tmpRoot, `${slug(url)}.pdf`);
  await writeFile(pdfPath, Buffer.from(ab));
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

function parsePdfSections({ text, doc, retrievedAt }) {
  const citations = extractCitations(text);
  const unique = [...new Set(citations)].filter((citation) => Number(citation.split(".")[0]) >= 1);
  const nodes = [];
  for (const citation of unique.slice(0, 80)) {
    const index = text.indexOf(citation);
    const excerpt = index >= 0 ? text.slice(Math.max(0, index - 350), index + 1800).replace(/\s+/g, " ").trim() : text.slice(0, 1600);
    nodes.push({
      id: `rfo-pdf-${slug(doc.agency)}-${slug(citation)}-${slug(doc.url).slice(-24)}`,
      citation,
      title: `${doc.agency} ${citation}`.trim(),
      part: String(doc.part || citation.split(".")[0]),
      regime: "Agency RFO deviation PDF",
      versionLabel: "deviation",
      sourceUrl: doc.url,
      retrievedAt,
      bodyText: excerpt,
      parseMethod: /line.?out|redline|strike/i.test(`${doc.label} ${text.slice(0, 2000)}`) ? "official_lineout_text_layer" : "official_pdf_text_layer",
      confidence: "medium"
    });
  }
  return nodes;
}

function selectPriorityPdfs(pdfs) {
  return pdfs
    .map((doc) => {
      const label = `${doc.label} ${doc.url}`;
      let score = 0;
      if (/Department of Defense|DoD/i.test(label)) score += 20;
      if (/General Services Administration|GSA/i.test(label)) score += 10;
      if (/Part-?0?4|Part_?4|Parts-1-6-10-11-18-29-31-34-39-43and52|Parts-1-53/i.test(label)) score += 8;
      if (/line.?out|redline|strike/i.test(label)) score += 100;
      return { ...doc, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, PDF_LIMIT);
}

async function ingestPdfs(pdfs, retrievedAt) {
  const tmpRoot = await mkdtemp(join(tmpdir(), "clausefinder-rfo-"));
  const selected = selectPriorityPdfs(pdfs);
  const nodes = [];
  const parsedDocuments = [];
  const failures = [];
  try {
    for (const doc of selected) {
      try {
        const text = await pdfToText(doc.url, tmpRoot);
        const parsed = parsePdfSections({ text, doc, retrievedAt });
        nodes.push(...parsed);
        parsedDocuments.push({
          label: doc.label,
          sourceUrl: doc.url,
          part: doc.part,
          textBytes: text.length,
          nodes: parsed.length,
          parseMethod: parsed.some((node) => node.parseMethod === "official_lineout_text_layer")
            ? "official_lineout_text_layer"
            : "official_pdf_text_layer"
        });
      } catch (error) {
        failures.push({ label: doc.label, sourceUrl: doc.url, message: String(error?.message || error) });
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  return { nodes, parsedDocuments, failures, attempted: selected.length, totalPdfs: pdfs.length };
}

async function ingestGuidance(retrievedAt) {
  const coverage = JSON.parse(await readFile(COVERAGE_PATH, "utf8"));
  const mainDocs = coverage.sources.farOverhaul.documents.filter((doc) =>
    /far-companion\.pdf|category-management-buying-guide\.pdf/i.test(doc.url)
  );
  const albumHtml = await fetchText(PRACTITIONER_ALBUMS);
  const albumLinks = extractLinks(albumHtml, PRACTITIONER_ALBUMS).filter((link) => /practitioner_albums\/.+\/content\/index\.html/i.test(link.url));
  const tmpRoot = await mkdtemp(join(tmpdir(), "clausefinder-guidance-"));
  const nodes = [];
  const failures = [];
  try {
    for (const doc of mainDocs) {
      try {
        const text = await pdfToText(doc.url, tmpRoot);
        const chunks = text
          .split(/\n(?=[A-Z][A-Za-z0-9 ,&()/.-]{8,90}\n)/)
          .map((chunk) => chunk.replace(/\s+/g, " ").trim())
          .filter((chunk) => chunk.length > 180)
          .slice(0, 160);
        chunks.forEach((chunk, index) => {
          nodes.push({
            id: `guidance-${slug(doc.label)}-${index + 1}`,
            citation: doc.label,
            title: chunk.slice(0, 90),
            regime: /category/i.test(doc.url) ? "Category Management Buying Guide" : "FAR Companion",
            binding: false,
            sourceUrl: doc.url,
            retrievedAt,
            bodyText: chunk.slice(0, 5000),
            parseMethod: "official_pdf_text_layer"
          });
        });
      } catch (error) {
        failures.push({ label: doc.label, sourceUrl: doc.url, message: String(error?.message || error) });
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  for (const album of albumLinks) {
    nodes.push({
      id: `guidance-album-${slug(album.label)}`,
      citation: album.label,
      title: album.label,
      regime: "Practitioner Album",
      binding: false,
      sourceUrl: album.url,
      retrievedAt,
      bodyText: `${album.label}. Practitioner Album landing page. Content is a dynamic course package and requires deeper asset parsing for full-text extraction.`,
      parseMethod: "official_album_inventory"
    });
  }
  return { nodes, failures, albumCount: albumLinks.length, pdfCount: mainDocs.length };
}

function generateCrosswalkReviewSet(indexNodes, guidanceNodes) {
  const guidanceTokenized = guidanceNodes.map((node) => ({
    node,
    tokens: new Set(tokenize(`${node.title} ${node.bodyText}`)),
    text: `${node.title} ${node.bodyText}`.toLowerCase()
  }));
  const candidates = [];
  for (const source of indexNodes.filter((node) => node.regime === "FAR").slice(0, 1200)) {
    const sourceTokens = tokenize(`${source.title} ${source.bodyText || source.excerpt || ""}`);
    if (sourceTokens.length < 4) continue;
    const sourceSet = new Set(sourceTokens);
    const best = guidanceTokenized
      .map((guidance) => {
        const overlap = [...sourceSet].filter((token) => guidance.tokens.has(token)).length;
        const explicitCitation = guidance.text.includes(String(source.citation).toLowerCase());
        const score = overlap / Math.max(sourceSet.size, 1) + (explicitCitation ? 0.8 : 0);
        return { guidance: guidance.node, score, method: explicitCitation ? "citation_reference" : "text_match" };
      })
      .filter((item) => item.score >= 0.22)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    const riskFlags = [];
    if (best.method !== "citation_reference") riskFlags.push("semantic_only_no_explicit_citation");
    if (best.score < 0.45) riskFlags.push("low_similarity");
    if (best.guidance.binding === false) riskFlags.push("guidance_is_nonbinding");
    candidates.push({
      id: `cw-${slug(source.citation)}-${slug(best.guidance.id)}`,
      review_status: "needs_practitioner_review",
      codex_review: {
        decision: best.method === "citation_reference" && best.score >= 0.65 ? "candidate_keep" : "needs_human_review",
        rationale:
          best.method === "citation_reference"
            ? "The guidance text explicitly references the FAR citation and has overlapping terms."
            : "The match is inferred from text similarity only and needs practitioner validation.",
        risk_flags: riskFlags
      },
      source: {
        citation: source.citation,
        title: source.title,
        regime: source.regime,
        sourceUrl: source.sourceUrl,
        excerpt: (source.bodyText || source.excerpt || "").slice(0, 800)
      },
      guidance: {
        title: best.guidance.title,
        regime: best.guidance.regime,
        binding: false,
        sourceUrl: best.guidance.sourceUrl,
        excerpt: best.guidance.bodyText.slice(0, 800)
      },
      method: best.method,
      confidence: best.score >= 0.65 ? "medium" : "low",
      similarity: Number(best.score.toFixed(3)),
      reviewer_decision: "",
      reviewer: "",
      reviewer_notes: ""
    });
  }
  return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 100);
}

function generateBenchmarkCandidates() {
  const seeds = [];
  const add = (record) => seeds.push({ review_status: "needs_practitioner_review", reviewed_by: [], ...record });
  const known = [
    ["candidate-sam-registration", "Which FAR provision requires an offeror to be registered in SAM before award?", ["52.204-7"], "answer", { commerciality: "Any" }],
    ["candidate-sam-maintenance", "What clause requires a contractor to keep SAM registration active during performance and final payment?", ["52.204-13"], "answer", { commerciality: "Any" }],
    ["candidate-uei-reporting", "Which FAR clause requires reporting first-tier subcontract and executive compensation information for certain awards?", ["52.204-10"], "answer", { valueBand: "Above simplified acquisition threshold" }],
    ["candidate-basic-safeguarding", "Which FAR clause covers basic safeguarding of covered contractor information systems?", ["52.204-21"], "answer", { acquisitionType: "Service" }],
    ["candidate-covered-telecom", "Which FAR clause addresses the prohibition on covered telecommunications equipment or services?", ["52.204-25"], "answer", { fundingLayer: "Air Force" }],
    ["candidate-code-ethics", "Which clause requires a contractor code of business ethics and conduct?", ["52.203-13"], "answer", { valueBand: "Above simplified acquisition threshold" }],
    ["candidate-responsibility-cert", "Which FAR provision asks offerors to certify responsibility matters such as debarment and tax delinquency?", ["52.209-5"], "answer", { competition: "Full and open" }],
    ["candidate-commercial-instructions", "Which provision gives offerors instructions for commercial products and commercial services solicitations?", ["52.212-1"], "answer", { commerciality: "Commercial" }],
    ["candidate-commercial-reps-certs", "Which provision contains offeror representations and certifications for commercial products and commercial services?", ["52.212-3"], "answer", { commerciality: "Commercial" }],
    ["candidate-commercial-terms", "Which clause contains standard terms and conditions for commercial products and commercial services contracts?", ["52.212-4"], "answer", { commerciality: "Commercial" }],
    ["candidate-commercial-required-clauses", "Which clause is used to incorporate required FAR clauses into commercial products and commercial services contracts?", ["52.212-5"], "answer", { commerciality: "Commercial" }],
    ["candidate-micro-purchase", "What FAR authority applies to a 9000 dollar supply buy by government purchase card?", ["13.201"], "answer", { valueBand: "Micro-purchase" }],
    ["candidate-sap-competition", "Which FAR section governs soliciting competition under simplified acquisition procedures?", ["13.106-1"], "answer", { valueBand: "Simplified acquisition threshold" }],
    ["candidate-proposal-analysis", "Which FAR section covers proposal analysis techniques?", ["15.404-1"], "answer", { acquisitionType: "Supply" }],
    ["candidate-cost-pricing-data", "Which clause is used when certified cost or pricing data are required?", ["52.215-20"], "answer", { valueBand: "Above simplified acquisition threshold" }],
    ["candidate-service-contract-labor", "Which FAR clause implements Service Contract Labor Standards for covered service contracts?", ["52.222-41"], "answer", { acquisitionType: "Service" }],
    ["candidate-texting-driving", "Which FAR clause encourages contractor policies to ban text messaging while driving?", ["52.223-18"], "answer", { commerciality: "Any" }],
    ["candidate-buy-american-supplies", "Which FAR clause implements Buy American requirements for supplies?", ["52.225-1"], "answer", { acquisitionType: "Supply" }],
    ["candidate-trade-agreements", "Which FAR clause implements Trade Agreements Act requirements for eligible products?", ["52.225-5"], "answer", { acquisitionType: "Supply" }],
    ["candidate-eft-sam", "Which FAR clause covers payment by electronic funds transfer when payment information is in SAM?", ["52.232-33"], "answer", { commerciality: "Any" }],
    ["candidate-accelerated-subcontractor-payments", "Which FAR clause asks prime contractors to make accelerated payments to small business subcontractors?", ["52.232-40"], "answer", { fundingLayer: "Air Force" }],
    ["candidate-disputes", "Which FAR clause governs contract disputes?", ["52.233-1"], "answer", { commerciality: "Any" }],
    ["candidate-subcontracts-consent", "Which FAR clause addresses Government consent to subcontracting?", ["52.244-2"], "answer", { acquisitionType: "Service" }],
    ["candidate-government-property", "Which FAR clause governs Government property provided to or acquired by the contractor?", ["52.245-1"], "answer", { acquisitionType: "Supply" }],
    ["candidate-inspection-supplies", "Which FAR clause covers inspection of supplies under fixed-price contracts?", ["52.246-2"], "answer", { acquisitionType: "Supply" }],
    ["candidate-fob-destination", "Which FAR clause covers F.O.B. destination delivery?", ["52.247-34"], "answer", { acquisitionType: "Supply" }],
    ["candidate-termination-fixed-price", "Which FAR clause covers termination for convenience of the Government for fixed-price contracts?", ["52.249-2"], "answer", { acquisitionType: "Supply" }],
    ["candidate-fake-citation", "What does FAR 52.299-99 require?", [], "no_match", {}],
    ["candidate-state-procurement", "Which FAR clause governs a state-only grant procurement with no Federal acquisition contract?", [], "no_match", {}],
    ["candidate-agency-adoption", "Does a FAR Council model deviation automatically govern my Air Force contract today?", [], "caveat_required", { fundingLayer: "Air Force" }],
    ["candidate-proposed-rule-binding", "Can a proposed FAR Overhaul rule be treated as binding contract text before final rule adoption or agency deviation adoption?", [], "caveat_required", { fundingLayer: "Air Force" }]
  ];
  for (const [id, question, acceptable, behavior, context] of known) {
    add({
      id,
      question,
      context: { fundingLayer: "Air Force", ...context },
      acceptable_citations: acceptable,
      acceptance_rule: acceptable.length ? "any_of" : "none",
      expected_behavior: behavior,
      version_state: behavior === "caveat_required" ? "deviation" : "current",
      author: "codex-draft",
      notes: "Draft scenario with expected citation from common FAR use cases. Practitioner must approve before it enters scored metrics."
    });
  }
  const unique = Array.from(new Map(seeds.map((item) => [item.id, item])).values());
  return unique.slice(0, 80);
}

function parseInstructionType(text) {
  const match = text.match(/\b(revise|revising|remove|removing|add|adding|redesignate|redesignating|amend|amending|republish|withdraw)\b/i);
  if (!match) return "manual_review";
  const value = match[1].toLowerCase();
  if (value.startsWith("revis")) return "revise";
  if (value.startsWith("remov")) return "remove";
  if (value.startsWith("add")) return "add";
  if (value.startsWith("redesignat")) return "redesignate";
  if (value.startsWith("amend")) return "amend";
  return value;
}

function parseTargets(text) {
  const targets = new Set();
  for (const match of text.matchAll(/\b(?:section|sections|FAR|Sec\.)\s+([0-9]{1,2}\.[0-9]{3,4}(?:-[0-9]+)?)/gi)) {
    targets.add(match[1]);
  }
  for (const match of text.matchAll(/\bparts?\s+([0-9, and]+)\b/gi)) {
    for (const part of match[1].split(/,|and/).map((item) => item.trim()).filter(Boolean)) {
      targets.add(`part-${part}`);
    }
  }
  return [...targets];
}

async function parseAmendatoryInstructions(report) {
  const documents = report.sources.federalRegister.currentTrancheDocuments || [];
  const records = [];
  for (const doc of documents) {
    const url = doc.rawTextUrl || doc.fullTextXmlUrl;
    if (!url) continue;
    const text = await fetchText(url);
    const start = text.search(/propose amending 48 CFR|proposes? amending 48 CFR|set forth below:/i);
    const body = start >= 0 ? text.slice(start) : text;
    const matches = [...body.matchAll(/\n\s*0\s*\n?\s*(\d+)\.\s+([\s\S]*?)(?=\n\s*0\s*\n?\s*\d+\.|\n\s*\[\[Page|\nPART\s+\d+--|$)/g)];
    if (!matches.length) {
      records.push({
        documentNumber: doc.documentNumber,
        title: doc.title,
        sourceUrl: doc.htmlUrl,
        instructionNumber: "",
        instructionText: body.slice(0, 1200),
        instructionType: "manual_review",
        targetCitations: [],
        parseStatus: "manual_review",
        confidence: "none",
        note: "No numbered amendatory instructions matched the parser."
      });
      continue;
    }
    for (const match of matches) {
      const instructionText = match[2].replace(/\s+/g, " ").trim();
      const type = parseInstructionType(instructionText);
      const targets = parseTargets(instructionText);
      records.push({
        documentNumber: doc.documentNumber,
        title: doc.title,
        federalRegisterCitation: doc.citation,
        publicationDate: doc.publicationDate,
        commentDeadline: doc.commentsCloseOn,
        docketIds: doc.docketIds,
        commentUrl: doc.commentUrl,
        sourceUrl: doc.htmlUrl,
        fullTextUrl: url,
        instructionNumber: match[1],
        instructionText,
        instructionType: type,
        targetCitations: targets,
        parseStatus: targets.length && type !== "manual_review" ? "parsed_candidate" : "manual_review",
        confidence: targets.length && type !== "manual_review" ? "medium" : "low",
        reviewer: "",
        reviewerNotes: ""
      });
    }
  }
  return records;
}

const retrievedAt = new Date().toISOString();
const index = JSON.parse(await readFile(INDEX_PATH, "utf8"));
const coverage = JSON.parse(await readFile(COVERAGE_PATH, "utf8"));
await mkdir(DATA_DIR, { recursive: true });

const { partPages, pdfs, lineOutLinks } = await inventoryRfoPartPages();
const rfoHtml = await ingestRfoHtmlParts(partPages, retrievedAt);
const rfoPdfs = await ingestPdfs(pdfs, retrievedAt);
const guidance = await ingestGuidance(retrievedAt);
const crosswalkReviewSet = generateCrosswalkReviewSet(index.nodes || [], guidance.nodes);
const benchmarkCandidates = generateBenchmarkCandidates(index.nodes || []);
const amendatoryInstructions = await parseAmendatoryInstructions(coverage);

const report = {
  generatedAt: retrievedAt,
  posture: "credibility",
  lineOutDocuments: {
    discovered: lineOutLinks.length,
    documents: lineOutLinks,
    status:
      lineOutLinks.length > 0
        ? "official line-out links discovered and queued for parsing"
        : "no official line-out links discovered by current label/url inventory; deviation text and computed diffs remain labeled accordingly"
  },
  rfoHtml: {
    attemptedPartPages: rfoHtml.attempted,
    totalPartPages: rfoHtml.totalPartPages,
    parsedNodes: rfoHtml.nodes.length,
    failures: rfoHtml.failures
  },
  rfoPdfs: {
    attemptedDocuments: rfoPdfs.attempted,
    totalPdfDocuments: rfoPdfs.totalPdfs,
    parsedDocuments: rfoPdfs.parsedDocuments,
    parsedNodes: rfoPdfs.nodes.length,
    failures: rfoPdfs.failures
  },
  guidance: {
    pdfDocuments: guidance.pdfCount,
    practitionerAlbums: guidance.albumCount,
    parsedNodes: guidance.nodes.length,
    failures: guidance.failures
  },
  crosswalk: {
    candidates: crosswalkReviewSet.length,
    status: "needs_practitioner_review",
    outputPath: CROSSWALK_PATH
  },
  benchmark: {
    candidates: benchmarkCandidates.length,
    status: "needs_practitioner_review",
    outputPath: BENCHMARK_PATH,
    publicBadgeRule: "Do not include these in public scored metrics until reviewed_by is populated by practitioners."
  },
  proposedRules: {
    documents: coverage.sources.federalRegister.currentTrancheDocuments?.length || 0,
    amendatoryInstructions: amendatoryInstructions.length,
    parsedCandidates: amendatoryInstructions.filter((item) => item.parseStatus === "parsed_candidate").length,
    manualReview: amendatoryInstructions.filter((item) => item.parseStatus === "manual_review").length,
    outputPath: AMENDATORY_PATH
  },
  nodes: {
    rfoDeviationNodes: [...rfoHtml.nodes, ...rfoPdfs.nodes],
    guidanceNodes: guidance.nodes
  }
};

await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(CROSSWALK_PATH, `${JSON.stringify(crosswalkReviewSet, null, 2)}\n`);
await writeFile(BENCHMARK_PATH, benchmarkCandidates.map((item) => JSON.stringify(item)).join("\n") + "\n");
await writeFile(AMENDATORY_PATH, `${JSON.stringify(amendatoryInstructions, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      outPath: OUT_PATH,
      rfoHtmlNodes: rfoHtml.nodes.length,
      rfoPdfNodes: rfoPdfs.nodes.length,
      guidanceNodes: guidance.nodes.length,
      crosswalkCandidates: crosswalkReviewSet.length,
      benchmarkCandidates: benchmarkCandidates.length,
      amendatoryInstructions: amendatoryInstructions.length,
      officialLineOutLinks: lineOutLinks.length
    },
    null,
    2
  )
);
