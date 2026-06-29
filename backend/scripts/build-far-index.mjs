import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "data", "far-index.json");
const BASE_URL = "https://www.acquisition.gov/far";

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

function sourceUrlForCitation(citation, part) {
  const anchor = citation.replace(/\./g, "_").replace(/-/g, "_");
  if (/^\d+\.\d/.test(citation) && !citation.startsWith("52.")) {
    return `${BASE_URL}/${citation}`;
  }
  if (citation.startsWith("52.")) {
    return `${BASE_URL}/${citation}`;
  }
  return `${BASE_URL}/part-${part}#FAR_${anchor}`;
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
  if (citation.startsWith("52.") && citation.includes("-")) return "clause/provision";
  return dataPart || "section";
}

function prescriptionFromText(text) {
  const match = text.match(/As prescribed in ([^.]{1,260}\.)/i);
  return match ? `As prescribed in ${match[1]}` : "";
}

function relatedFromArticle(article) {
  const links = [...article.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set();
  return links
    .map(([, href, label]) => {
      const clean = stripHtml(label);
      if (!clean || seen.has(clean)) return null;
      seen.add(clean);
      return {
        label: clean.slice(0, 80),
        url: href.startsWith("http") ? href : `https://www.acquisition.gov${href}`,
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

function parsePartPage(html, part, retrievedAt) {
  const effectiveDate = extractEffectiveDate(html);
  const starts = [...html.matchAll(/<article\b[^>]*id="([^"]+)"[^>]*data-part="([^"]+)"[^>]*data-part-number="([^"]+)"/gi)].map(
    (match) => ({
      index: match.index || 0,
      id: match[1],
      dataPart: match[2],
      citation: match[3]
    })
  );
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
    const sourceUrl = sourceUrlForCitation(start.citation, part);
    const bodyText = text.replace(new RegExp(`^${start.citation}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "");
    nodes.push({
      id: `far-${start.citation.replace(/\./g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
      citation: start.citation,
      title,
      type,
      part,
      regime: "FAR",
      hierarchyPath: `FAR > Part ${part} > ${start.citation}`,
      sourceUrl,
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

async function fetchPart(part) {
  const url = `${BASE_URL}/part-${part}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "ClauseFinder public FAR indexer; contact: wayan.com"
    }
  });
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  const html = await res.text();
  return { url, html };
}

const parts = partListFromArgs();
const retrievedAt = new Date().toISOString().slice(0, 10);
const nodes = [];
const indexedParts = [];

for (const part of parts) {
  const { url, html } = await fetchPart(part);
  const partNodes = parsePartPage(html, part, retrievedAt);
  indexedParts.push({ part, url, nodes: partNodes.length });
  nodes.push(...partNodes);
  console.log(`Indexed FAR Part ${part}: ${partNodes.length} nodes`);
}

const uniqueNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values()).sort((a, b) =>
  a.citation.localeCompare(b.citation, undefined, { numeric: true })
);

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(
  OUT_PATH,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Acquisition.gov public FAR part pages",
      sourceBaseUrl: BASE_URL,
      parts: indexedParts,
      nodes: uniqueNodes
    },
    null,
    2
  )
);

console.log(`Wrote ${uniqueNodes.length} FAR nodes to ${OUT_PATH}`);
