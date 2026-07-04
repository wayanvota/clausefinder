import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = process.env.SOURCE_COVERAGE_REPORT_PATH || join(__dirname, "..", "data", "source-coverage-report.json");
const USER_AGENT = "ClauseFinder source coverage auditor; public-source verification; contact: wayan.com";

const SOURCES = {
  farOverhaul: "https://www.acquisition.gov/far-overhaul",
  ecfrDocs: "https://www.ecfr.gov/developers/documentation/api/v1",
  ecfrTitles: "https://www.ecfr.gov/api/versioner/v1/titles.json",
  ecfrVersions: "https://www.ecfr.gov/api/versioner/v1/versions/title-48.json",
  federalRegisterDocs: "https://www.federalregister.gov/developers/documentation/api/v1",
  federalRegisterSearch:
    "https://www.federalregister.gov/api/v1/documents.json?per_page=100&conditions%5Btype%5D%5B%5D=PRORULE&conditions%5Bterm%5D=Federal%20Acquisition%20Regulation%20Revolutionary",
  regulationsGovApi: "https://open.gsa.gov/api/regulationsgov/"
};

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

async function fetchText(url, as = "text") {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${url}`);
  return as === "json" ? response.json() : response.text();
}

async function fetchStatus(url) {
  try {
    let response = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, { headers: { "user-agent": USER_AGENT, range: "bytes=0-512" } });
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url || url
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      finalUrl: url,
      error: String(error?.message || error)
    };
  }
}

function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function extractLinks(html, base) {
  const links = [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, label]) => ({
      url: absoluteUrl(decodeEntities(href), base),
      label: stripHtml(label)
    }))
    .filter((item) => item.url && item.label && !item.url.startsWith("mailto:"));
  return Array.from(new Map(links.map((item) => [`${item.url}::${item.label}`, item])).values());
}

function categoryForLink(link) {
  const text = `${link.label} ${link.url}`.toLowerCase();
  if (/far companion/.test(text)) return "far_companion";
  if (/category.*(buying|management)|buying guide/.test(text)) return "category_management_buying_guide";
  if (/practitioner.*album|album/.test(text)) return "practitioner_album";
  if (/line.?out|line.?in|redline|strike|strikethrough/.test(text)) return "line_out_or_redline";
  if (/model deviation|class deviation|deviation|rfo part|revolutionary far overhaul|overhaul/.test(text)) {
    return "overhaul_deviation_material";
  }
  if (/crosswalk|disposition|feedback matrix/.test(text)) return "crosswalk_or_feedback";
  if (/faq|frequently asked/.test(text)) return "faq";
  if (/memorandum|policy|guidance|guide/.test(text)) return "policy_guidance";
  return "other";
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function auditFarOverhaul() {
  const html = await fetchText(SOURCES.farOverhaul);
  const allLinks = extractLinks(html, SOURCES.farOverhaul);
  const candidateLinks = allLinks
    .map((link) => ({ ...link, category: categoryForLink(link) }))
    .filter((link) => link.category !== "other" || /far|rfo|overhaul|deviation|companion|album|guide/i.test(`${link.label} ${link.url}`));
  const verified = [];
  for (const link of candidateLinks.slice(0, Number(process.env.SOURCE_AUDIT_LINK_LIMIT || 250))) {
    verified.push({ ...link, verification: await fetchStatus(link.url) });
  }
  return {
    sourceUrl: SOURCES.farOverhaul,
    status: "checked",
    pageBytes: html.length,
    totalLinks: allLinks.length,
    candidateDocuments: verified.length,
    categoryCounts: countBy(verified, (item) => item.category),
    documents: verified,
    gaps: [
      "Link inventory does not prove a document is fully parsed.",
      "Line-out styling and model-deviation effective dates still require document-level parsing.",
      "Agency adoption is not inferred from the FAR Overhaul page."
    ]
  };
}

async function auditEcfr() {
  const titles = await fetchText(SOURCES.ecfrTitles, "json");
  const title48 = (titles.titles || []).find((title) => Number(title.number) === 48);
  const versions = await fetchText(SOURCES.ecfrVersions, "json");
  const date = title48?.up_to_date_as_of || title48?.latest_issue_date || title48?.latest_amended_on || "";
  const part4Url = date ? `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-48.xml?part=4` : "";
  const part4Status = part4Url ? await fetchStatus(part4Url) : { ok: false, status: 0 };
  return {
    documentationUrl: SOURCES.ecfrDocs,
    title48: {
      name: title48?.name || "",
      latestIssueDate: title48?.latest_issue_date || "",
      latestAmendedOn: title48?.latest_amended_on || "",
      upToDateAsOf: title48?.up_to_date_as_of || ""
    },
    versionsEndpoint: {
      sourceUrl: SOURCES.ecfrVersions,
      totalPages: versions.meta?.total_pages || null,
      firstPageRecords: versions.content_versions?.length || 0
    },
    sampleFullText: {
      sourceUrl: part4Url,
      verification: part4Status
    },
    gaps: [
      "Point-in-time snapshots must be cached by date and part before vintage lookup is complete.",
      "Section-level amendment records require reviewer spot checks against current source pages."
    ]
  };
}

async function auditFederalRegister() {
  const data = await fetchText(SOURCES.federalRegisterSearch, "json");
  const docs = [];
  for (const doc of data.results || []) {
    let detail = {};
    const detailUrl = doc.json_url || `https://www.federalregister.gov/api/v1/documents/${doc.document_number}.json`;
    try {
      detail = await fetchText(detailUrl, "json");
    } catch (error) {
      detail = { auditError: String(error?.message || error) };
    }
    docs.push({
      documentNumber: doc.document_number,
      title: detail.title || doc.title,
      citation: detail.citation || doc.citation,
      publicationDate: detail.publication_date || doc.publication_date,
      commentsCloseOn: detail.comments_close_on || doc.comments_close_on,
      dates: detail.dates || "",
      htmlUrl: detail.html_url || doc.html_url,
      pdfUrl: detail.pdf_url || doc.pdf_url,
      rawTextUrl: detail.raw_text_url || doc.raw_text_url,
      fullTextXmlUrl: detail.full_text_xml_url,
      commentUrl: detail.comment_url,
      regulationsDotGovUrl: detail.regulations_dot_gov_url || doc.regulations_dot_gov_url,
      regulationsDotGovInfo: detail.regulations_dot_gov_info || {},
      docketIds: detail.docket_ids || doc.docket_ids || [],
      cfrReferences: detail.cfr_references || doc.cfr_references || [],
      detailUrl,
      auditError: detail.auditError || ""
    });
  }
  const currentTranche = docs.filter(
    (doc) =>
      doc.publicationDate === "2026-06-23" &&
      /revolutionary federal acquisition regulation overhaul/i.test(String(doc.title || ""))
  );
  return {
    documentationUrl: SOURCES.federalRegisterDocs,
    searchUrl: SOURCES.federalRegisterSearch,
    total: data.count || docs.length,
    returned: docs.length,
    currentTrancheReturned: currentTranche.length,
    documents: docs,
    currentTrancheDocuments: currentTranche,
    deadlineCounts: countBy(docs, (doc) => doc.commentsCloseOn || "no_deadline"),
    currentTrancheDeadlineCounts: countBy(currentTranche, (doc) => doc.commentsCloseOn || "no_deadline"),
    gaps: [
      "Broad Federal Register search results include older FAR proposed rules; current tranche counts are separated by publication date and title pattern.",
      "Document metadata is not enough for Workstream D. Full text and amendatory instructions must be parsed.",
      "Unparsed amendatory instructions must be counted as manual_review rather than guessed."
    ]
  };
}

async function auditRegulationsGov() {
  const html = await fetchText(SOURCES.regulationsGovApi);
  const text = stripHtml(html);
  return {
    sourceUrl: SOURCES.regulationsGovApi,
    mentionsApiKey: /api key/i.test(text),
    mentionsCommentPostingActivation: /comment posting|activation|api.data.gov/i.test(text),
    verifiedAt: new Date().toISOString(),
    gaps: [
      "Regulations.gov API enrichment needs a free API key.",
      "Comment posting is out of scope for ClauseFinder. The safer feature is export-only comment packets."
    ]
  };
}

function reviewerSignoff() {
  return [
    {
      workstream: "A",
      required: [
        "Approve the pre-overhaul baseline date.",
        "Spot-check at least 10 section deltas across at least 4 FAR parts.",
        "Approve the model-deviation adoption caveat.",
        "Decide whether computed diffs can appear in demos or only official line-outs."
      ]
    },
    {
      workstream: "B",
      required: [
        "Confirm every guidance document is labeled non-regulatory.",
        "Review 25 inferred crosswalk edges before treating the feature as reliable.",
        "Choose the similarity threshold for text-match crosswalks.",
        "Approve the no-relocated-equivalent message."
      ]
    },
    {
      workstream: "C",
      required: [
        "Approve 60 or more answerable questions and 10 or more trap questions.",
        "Record acceptable citations and caveat requirements.",
        "Set the public demo floor for top-5 hit rate and refusal behavior."
      ]
    },
    {
      workstream: "D",
      required: [
        "Verify the discovered Federal Register proposed-rule set.",
        "Review manual_review amendatory instructions.",
        "Approve the CUI worked-example mapping before public demo use.",
        "Approve the export-only comment packet disclaimer."
      ]
    }
  ];
}

const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  posture: "credibility",
  claim: "ClauseFinder reports live source coverage and reviewer-signoff gaps. Partial or inferred coverage is labeled instead of presented as complete.",
  sources: {
    farOverhaul: await auditFarOverhaul(),
    ecfr: await auditEcfr(),
    federalRegister: await auditFederalRegister(),
    regulationsGov: await auditRegulationsGov()
  },
  reviewerSignoff: reviewerSignoff(),
  demoRecommendation: {
    publicClaim: "partial coverage with visible gaps",
    doNotClaim: [
      "Complete official line-out parsing for all FAR parts.",
      "Agency adoption status for model deviations.",
      "Official guidance crosswalks unless source_edges.method is official_crosswalk.",
      "Practitioner-reviewed benchmark until reviewedBy fields meet the target set size."
    ],
    nextBestSlice: "Prioritize SAM registration and CUI as vertical slices because they exercise version deltas, proposed-rule alerts, and comment-packet export."
  }
};

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, outPath: OUT_PATH, generatedAt }, null, 2));
