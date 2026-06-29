import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "data", "far-index.json");
const ACQ_BASE = "https://www.acquisition.gov";
const FAR_BASE = `${ACQ_BASE}/far`;

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

function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripXml(xml) {
  return decodeEntities(
    String(xml || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function fetchText(url, as = "text") {
  const res = await fetch(url, {
    headers: { "user-agent": "ClauseFinder public acquisition regulation indexer; contact: wayan.com" }
  });
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

async function fetchTextMaybe(url, as = "text") {
  const res = await fetch(url, {
    headers: { "user-agent": "ClauseFinder public acquisition regulation indexer; contact: wayan.com" }
  });
  if (!res.ok) return null;
  return as === "json" ? res.json() : res.text();
}

function titleFromArticle(article, citation) {
  const match =
    article.match(/<h[1-6][^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
    article.match(/<span class="ph autonumber">[\s\S]*?<\/span>\s*([^<]+)/i);
  const title = stripHtml(match?.[1] || "").replace(new RegExp(`^${citation}\\s*`), "").trim();
  return title || citation;
}

function typeFromArticle(article, dataPart, citation) {
  if (/class="[^"]*\bclause\b/i.test(article)) return "clause";
  if (/class="[^"]*\bprovision\b/i.test(article)) return "provision";
  if (/^52\.\d+-/.test(citation) || /^252\.\d+-/.test(citation) || /^5352\.\d+-/.test(citation)) {
    return "clause/provision";
  }
  return dataPart || "section";
}

function prescriptionFromText(text) {
  const match = text.match(/As prescribed in ([^.]{1,260}\.)/i);
  return match ? `As prescribed in ${match[1]}` : "";
}

function typeFromCitation(citation) {
  if (/^(52|252|5352)\.\d+-/.test(String(citation))) return "clause/provision";
  return "section";
}

function relatedFromArticle(article) {
  const links = [...article.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set();
  return links
    .map(([, href, label]) => {
      const clean = stripHtml(label);
      if (!clean || seen.has(`${clean}-${href}`)) return null;
      seen.add(`${clean}-${href}`);
      return {
        label: clean.slice(0, 90),
        url: href.startsWith("http") ? href : `${ACQ_BASE}${href}`,
        relation: "cross-reference"
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function extractEffectiveDate(html) {
  const text = stripHtml(html);
  const match = text.match(/Effective Date:\s*([0-9/.-]+)/i);
  return match?.[1] || "";
}

function parseRegulationPage({ html, part, partUrl, regime, retrievedAt }) {
  const effectiveDate = extractEffectiveDate(html);
  let starts = [...html.matchAll(/<article\b[^>]*id="([^"]+)"[^>]*data-part="([^"]+)"[^>]*data-part-number="([^"]+)"/gi)].map(
    (match) => ({
      index: match.index || 0,
      id: match[1],
      dataPart: match[2],
      citation: match[3]
    })
  );
  if (!starts.length) {
    starts = [...html.matchAll(/<article\b[^>]*id="([^"]+)"[^>]*>[\s\S]{0,1200}?<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map(
      (match) => {
        const heading = stripHtml(match[2]);
        const citation =
          heading.match(/^(?:Part|Subpart)\s+([0-9.]+)/i)?.[1] ||
          heading.match(/^([0-9]{1,4}\.[0-9][0-9A-Za-z.-]*)/)?.[1] ||
          "";
        const dataPart = /^Subpart/i.test(heading) ? "subpart" : /^Part/i.test(heading) ? "part" : "section";
        return {
          index: match.index || 0,
          id: match[1],
          dataPart,
          citation
        };
      }
    );
  }
  const nodes = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (!/^\d+(\.\d+)?(-\d+)?$/.test(start.citation)) continue;
    if (start.dataPart === "part" || start.dataPart === "subpart") continue;
    const end = starts[i + 1]?.index || html.length;
    const article = html.slice(start.index, end);
    const text = stripHtml(article);
    if (text.length < 80 || /\[Reserved\]$/.test(titleFromArticle(article, start.citation))) continue;
    const title = titleFromArticle(article, start.citation);
    const type = typeFromArticle(article, start.dataPart, start.citation);
    const bodyText = text.replace(new RegExp(`^${start.citation}\\s*`), "");
    nodes.push({
      id: `${regime.toLowerCase().replace(/\s+/g, "-")}-${start.citation.replace(/\./g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
      citation: start.citation,
      title,
      type,
      part,
      regime,
      hierarchyPath: `${regime} > Part ${part} > ${start.citation}`,
      sourceUrl: `${partUrl}#${start.id}`,
      retrievedAt,
      effectiveDate,
      excerpt: bodyText.slice(0, 520),
      bodyText: bodyText.slice(0, 12000),
      prescription: prescriptionFromText(bodyText),
      related: relatedFromArticle(article)
    });
  }
  return nodes;
}

function partListFromArgs() {
  const arg = process.argv.find((item) => item.startsWith("--parts="));
  const raw = arg ? arg.split("=")[1] : process.env.FAR_PARTS || "1-53";
  const parts = [];
  for (const segment of raw.split(",")) {
    if (segment.includes("-")) {
      const [start, end] = segment.split("-").map(Number);
      for (let part = start; part <= end; part += 1) parts.push(part);
    } else {
      parts.push(Number(segment));
    }
  }
  return [...new Set(parts.filter(Boolean))].sort((a, b) => a - b);
}

async function indexFar(retrievedAt) {
  const nodes = [];
  const parts = [];
  for (const part of partListFromArgs()) {
    const url = `${FAR_BASE}/part-${part}`;
    const html = await fetchText(url);
    const partNodes = parseRegulationPage({ html, part, partUrl: url, regime: "FAR", retrievedAt });
    parts.push({ regime: "FAR", part, url, nodes: partNodes.length });
    nodes.push(...partNodes);
    console.log(`Indexed FAR Part ${part}: ${partNodes.length} nodes`);
  }
  return { nodes, parts };
}

async function discoverAcquisitionGovParts(indexUrl, hrefPrefix) {
  const html = await fetchText(indexUrl);
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*title="([^"]*Part\s+(\d+)[^"]*)"[^>]*>/gi)]
    .map(([, href, title, part]) => ({
      href: href.startsWith("http") ? href : `${ACQ_BASE}${href}`,
      title: stripHtml(title),
      part: Number(part)
    }))
    .filter((item) => item.href.includes(hrefPrefix));
  return Array.from(new Map(links.map((item) => [item.href, item])).values());
}

async function indexAcquisitionGovRegime({ regime, indexUrl, hrefPrefix, retrievedAt }) {
  const nodes = [];
  const parts = [];
  const links = await discoverAcquisitionGovParts(indexUrl, hrefPrefix);
  for (const link of links) {
    const html = await fetchText(link.href);
    const partNodes = parseRegulationPage({
      html,
      part: link.part,
      partUrl: link.href,
      regime,
      retrievedAt
    });
    parts.push({ regime, part: link.part, url: link.href, nodes: partNodes.length });
    nodes.push(...partNodes);
    console.log(`Indexed ${regime} Part ${link.part}: ${partNodes.length} nodes`);
  }
  return { nodes, parts };
}

async function indexFederalRegister(retrievedAt) {
  const url =
    "https://www.federalregister.gov/api/v1/documents.json?per_page=100&conditions%5Btype%5D%5B%5D=PRORULE&conditions%5Bterm%5D=Federal%20Acquisition%20Regulation%20Revolutionary";
  const data = await fetchText(url, "json");
  const results = data.results || [];
  const nodes = results.map((doc) => ({
    id: `federal-register-${doc.document_number}`,
    citation: doc.citation || doc.document_number,
    title: doc.title,
    type: "proposed rule",
    part: "",
    regime: "Federal Register proposed rule",
    hierarchyPath: `Federal Register > ${doc.type} > ${doc.document_number}`,
    sourceUrl: doc.html_url || doc.pdf_url,
    retrievedAt,
    effectiveDate: doc.publication_date || "",
    excerpt: `${doc.abstract || ""} Comment date: ${doc.comments_close_on || "not listed"}`.slice(0, 520),
    bodyText: `${doc.title}\n${doc.abstract || ""}\n${doc.raw_text_url || ""}`.slice(0, 12000),
    prescription: "",
    related: []
  }));
  console.log(`Indexed Federal Register proposed rules: ${nodes.length} nodes`);
  return {
    nodes,
    parts: [{ regime: "Federal Register proposed rule", part: "proposed", url, nodes: nodes.length }]
  };
}

async function indexFarOverhaul(retrievedAt) {
  const url = `${ACQ_BASE}/far-overhaul`;
  const html = await fetchText(url);
  const text = stripHtml(html);
  const linkNodes = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, label], index) => {
      const clean = stripHtml(label);
      if (!clean || !/FAR|deviation|companion|overhaul|part/i.test(clean)) return null;
      const sourceUrl = href.startsWith("http") ? href : `${ACQ_BASE}${href}`;
      return {
        id: `far-overhaul-${index}`,
        citation: clean.slice(0, 80),
        title: clean,
        type: "overhaul source",
        part: "",
        regime: "FAR Overhaul",
        hierarchyPath: "Acquisition.gov > FAR Overhaul",
        sourceUrl,
        retrievedAt,
        effectiveDate: "",
        excerpt: text.slice(0, 520),
        bodyText: `${clean}\n${text}`.slice(0, 12000),
        prescription: "",
        related: []
      };
    })
    .filter(Boolean)
    .slice(0, 80);
  console.log(`Indexed FAR Overhaul links: ${linkNodes.length} nodes`);
  return {
    nodes: linkNodes,
    parts: [{ regime: "FAR Overhaul", part: "overhaul", url, nodes: linkNodes.length }]
  };
}

async function indexEcfrHistory(retrievedAt) {
  const url = "https://www.ecfr.gov/api/versioner/v1/versions/title-48.json";
  const first = await fetchText(url, "json");
  const totalPages = Number(first.meta?.total_pages || 1);
  const records = [...(first.content_versions || [])];
  for (let page = 2; page <= Math.min(totalPages, 8); page += 1) {
    const data = await fetchText(`${url}?page=${page}`, "json");
    records.push(...(data.content_versions || []));
  }
  const wanted = records.filter((item) => {
    const part = Number(item.part);
    return (
      item.type === "section" &&
      (part <= 53 || (part >= 201 && part <= 253) || (part >= 5301 && part <= 5352))
    );
  });
  const nodes = wanted.slice(0, 2500).map((item, index) => ({
    id: `ecfr-history-${item.identifier}-${item.date}-${index}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    citation: item.identifier,
    title: item.name,
    type: item.removed ? "historical removal" : "historical version",
    part: item.part || "",
    regime: "eCFR history",
    hierarchyPath: `eCFR Title 48 > ${item.identifier}`,
    sourceUrl: `https://www.ecfr.gov/current/title-48/section-${item.identifier}`,
    retrievedAt,
    effectiveDate: item.date || "",
    excerpt: `${item.name}. Amendment date ${item.amendment_date}; issue date ${item.issue_date}; ${item.removed ? "removed" : "active/change record"}.`,
    bodyText: JSON.stringify(item),
    prescription: "",
    related: []
  }));
  console.log(`Indexed eCFR history metadata: ${nodes.length} nodes`);
  return {
    nodes,
    parts: [{ regime: "eCFR history", part: "title-48", url, nodes: nodes.length }]
  };
}

async function ecfrCurrentDate() {
  const data = await fetchText("https://www.ecfr.gov/api/versioner/v1/titles", "json");
  const title48 = (data.titles || []).find((title) => Number(title.number) === 48);
  return title48?.up_to_date_as_of || title48?.latest_issue_date || title48?.latest_amended_on;
}

function parseEcfrPartXml({ xml, part, date, retrievedAt }) {
  const starts = [...xml.matchAll(/<DIV8\b[^>]*\bN="([^"]+)"[^>]*\bTYPE="SECTION"[^>]*>/gi)].map((match) => ({
    index: match.index || 0,
    tag: match[0],
    citation: match[1]
  }));
  const nodes = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1]?.index || xml.length;
    const sectionXml = xml.slice(start.index, end);
    const heading = stripXml(sectionXml.match(/<HEAD>([\s\S]*?)<\/HEAD>/i)?.[1] || start.citation)
      .replace(new RegExp(`^${start.citation}\\s*`), "")
      .trim();
    const text = stripXml(sectionXml);
    if (text.length < 80 || /\[Reserved\]/i.test(heading)) continue;
    const bodyText = text.replace(new RegExp(`^${start.citation}\\s*`), "");
    nodes.push({
      id: `ecfr-current-${start.citation}-${date}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
      citation: start.citation,
      title: heading || start.citation,
      type: typeFromCitation(start.citation),
      part,
      regime: "eCFR current full text",
      hierarchyPath: `eCFR Title 48 > Part ${part} > ${start.citation}`,
      sourceUrl: `https://www.ecfr.gov/current/title-48/section-${start.citation}`,
      retrievedAt,
      effectiveDate: date,
      excerpt: bodyText.slice(0, 520),
      bodyText: bodyText.slice(0, 12000),
      prescription: prescriptionFromText(bodyText),
      related: []
    });
  }
  return nodes;
}

async function indexEcfrCurrentFullText(retrievedAt, candidateParts) {
  const date = await ecfrCurrentDate();
  const partsToFetch = [...new Set(candidateParts.map(Number).filter(Boolean))]
    .filter((part) => part <= 53 || (part >= 201 && part <= 253) || (part >= 5301 && part <= 5352))
    .sort((a, b) => a - b);
  const nodes = [];
  const parts = [];
  for (const part of partsToFetch) {
    const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-48.xml?part=${part}`;
    const xml = await fetchTextMaybe(url);
    if (!xml || xml.trim().startsWith("{")) {
      console.log(`Skipped eCFR current Part ${part}: no XML available`);
      continue;
    }
    const partNodes = parseEcfrPartXml({ xml, part, date, retrievedAt });
    parts.push({ regime: "eCFR current full text", part, url, nodes: partNodes.length });
    nodes.push(...partNodes);
    console.log(`Indexed eCFR current Part ${part}: ${partNodes.length} nodes`);
  }
  return { nodes, parts };
}

const retrievedAt = new Date().toISOString().slice(0, 10);
const bundles = [];

bundles.push(await indexFar(retrievedAt));
bundles.push(await indexAcquisitionGovRegime({
  regime: "DFARS",
  indexUrl: `${ACQ_BASE}/dfars`,
  hrefPrefix: "/dfars/part-",
  retrievedAt
}));
bundles.push(await indexAcquisitionGovRegime({
  regime: "DAFFARS",
  indexUrl: `${ACQ_BASE}/daffars`,
  hrefPrefix: "/daffars/part-",
  retrievedAt
}));
const currentParts = bundles
  .flatMap((bundle) => bundle.parts)
  .filter((part) => ["FAR", "DFARS", "DAFFARS"].includes(part.regime) && Number(part.nodes) > 0)
  .map((part) => part.part);
bundles.push(await indexEcfrCurrentFullText(retrievedAt, currentParts));
bundles.push(await indexFarOverhaul(retrievedAt));
bundles.push(await indexFederalRegister(retrievedAt));
bundles.push(await indexEcfrHistory(retrievedAt));

const nodes = bundles.flatMap((bundle) => bundle.nodes);
const parts = bundles.flatMap((bundle) => bundle.parts);
const uniqueNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values()).sort((a, b) =>
  String(a.citation).localeCompare(String(b.citation), undefined, { numeric: true })
);

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(
  OUT_PATH,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Acquisition.gov FAR/DFARS/DAFFARS, Acquisition.gov FAR Overhaul, Federal Register API, eCFR Title 48 current full text and versions APIs",
      sourceBaseUrl: FAR_BASE,
      parts,
      nodes: uniqueNodes
    },
    null,
    2
  )
);

console.log(`Wrote ${uniqueNodes.length} acquisition regulation nodes to ${OUT_PATH}`);
