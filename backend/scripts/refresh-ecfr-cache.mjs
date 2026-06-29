import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = process.env.ECFR_CACHE_PATH || join(__dirname, "..", "data", "ecfr-cache.json");
const USER_AGENT = "ClauseFinder eCFR cache refresh; contact: wayan.com";
const TITLE = 48;

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

function stripXml(xml) {
  return decodeEntities(
    String(xml || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseList(value, fallback) {
  const raw = String(value || fallback);
  const numbers = [];
  for (const segment of raw.split(",")) {
    const clean = segment.trim();
    if (!clean) continue;
    if (clean.includes("-")) {
      const [start, end] = clean.split("-").map(Number);
      for (let part = start; part <= end; part += 1) numbers.push(part);
    } else {
      numbers.push(Number(clean));
    }
  }
  return [...new Set(numbers.filter(Boolean))].sort((a, b) => a - b);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

async function fetchText(url, as = "text") {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Failed ${url}: ${response.status}`);
  return as === "json" ? response.json() : response.text();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextMaybe(url) {
  const attempts = Number(process.env.ECFR_FETCH_ATTEMPTS || 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (response.status === 404) return null;
    if (response.status === 429 || response.status >= 500) {
      if (attempt === attempts) throw new Error(`eCFR XML endpoint failed after ${attempts} attempts: ${response.status} ${url}`);
      await wait(1000 * attempt);
      continue;
    }
    if (!response.ok) return null;
    const text = await response.text();
    if (text.trim().startsWith("{")) return null;
    if (/503 Service Unavailable/i.test(text)) {
      if (attempt === attempts) throw new Error(`eCFR XML endpoint returned an HTML 503 after ${attempts} attempts: ${url}`);
      await wait(1000 * attempt);
      continue;
    }
    return text;
  }
  return null;
}

async function ecfrCurrentDate() {
  const data = await fetchText("https://www.ecfr.gov/api/versioner/v1/titles", "json");
  const title48 = (data.titles || []).find((title) => Number(title.number) === TITLE);
  if (!title48) throw new Error("Title 48 was not present in eCFR titles response.");
  return title48.latest_issue_date || title48.up_to_date_as_of || title48.latest_amended_on;
}

function typeFromCitation(citation) {
  return /^(52|252|5352)\.\d+-/.test(String(citation)) ? "clause/provision" : "section";
}

function prescriptionFromText(text) {
  const match = text.match(/As prescribed in ([^.]{1,260}\.)/i);
  return match ? `As prescribed in ${match[1]}` : "";
}

function parseEcfrPartXml({ xml, part, date, retrievedAt, snapshotType }) {
  const starts = [...xml.matchAll(/<DIV8\b[^>]*\bN="([^"]+)"[^>]*\bTYPE="SECTION"[^>]*>/gi)].map((match) => ({
    index: match.index || 0,
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
      id: `ecfr-${snapshotType}-${start.citation}-${date}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
      citation: start.citation,
      title: heading || start.citation,
      type: typeFromCitation(start.citation),
      part: String(part),
      regime: snapshotType === "current" ? "eCFR current full text" : "eCFR historical full text",
      sourceUrl: `https://www.ecfr.gov/on/${date}/title-${TITLE}/section-${start.citation}`,
      retrievedAt,
      effectiveDate: date,
      snapshotDate: date,
      snapshotType,
      excerpt: bodyText.slice(0, 520),
      bodyText: bodyText.slice(0, 12000),
      metadata: {
        title: TITLE,
        part: String(part),
        prescription: prescriptionFromText(bodyText)
      }
    });
  }
  return nodes;
}

async function fetchPartSnapshot({ part, date, retrievedAt, snapshotType }) {
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${TITLE}.xml?part=${part}`;
  let xml;
  try {
    xml = await fetchTextMaybe(url);
  } catch (error) {
    if (process.env.ECFR_FAIL_ON_PART_ERROR === "true") throw error;
    console.warn(`Skipped eCFR ${snapshotType} Part ${part} on ${date}: ${error?.message || error}`);
    return {
      nodes: [],
      error: {
        part: String(part),
        date,
        snapshotType,
        url,
        message: String(error?.message || error)
      }
    };
  }
  if (!xml) {
    console.log(`Skipped eCFR ${snapshotType} Part ${part} on ${date}: no XML available`);
    return { nodes: [], error: null };
  }
  const nodes = parseEcfrPartXml({ xml, part, date, retrievedAt, snapshotType });
  console.log(`Indexed eCFR ${snapshotType} Part ${part} on ${date}: ${nodes.length} nodes`);
  return { nodes, error: null };
}

async function allVersionRecords(maxPages) {
  const base = `https://www.ecfr.gov/api/versioner/v1/versions/title-${TITLE}.json`;
  const first = await fetchText(base, "json");
  const totalPages = Number(first.meta?.total_pages || 1);
  const pageLimit = maxPages === "all" ? totalPages : Math.min(totalPages, Number(maxPages || 20));
  const records = [...(first.content_versions || [])];
  for (let page = 2; page <= pageLimit; page += 1) {
    const data = await fetchText(`${base}?page=${page}`, "json");
    records.push(...(data.content_versions || []));
  }
  return records;
}

async function buildNodes({ onSnapshot } = {}) {
  const retrievedAt = new Date().toISOString().slice(0, 10);
  const parts = parseList(process.env.ECFR_PARTS, "1-53,201-253,5301-5352");
  const includeCurrent = process.env.ECFR_INCLUDE_CURRENT !== "false";
  const includeHistory = process.env.ECFR_INCLUDE_HISTORY !== "false";
  const historyLookbackDays = Number(process.env.ECFR_HISTORY_LOOKBACK_DAYS || 365);
  const maxHistorySnapshots = Number(process.env.ECFR_MAX_HISTORY_SNAPSHOTS || 120);
  const maxVersionPages = process.env.ECFR_VERSION_PAGES || "all";
  const nodes = [];
  const skipped = [];

  async function recordSnapshot(snapshot) {
    nodes.push(...snapshot.nodes);
    if (snapshot.error) skipped.push(snapshot.error);
    if (snapshot.nodes.length && onSnapshot) await onSnapshot(snapshot.nodes);
  }

  if (includeCurrent) {
    const currentDate = await ecfrCurrentDate();
    for (const part of parts) {
      await recordSnapshot(await fetchPartSnapshot({ part, date: currentDate, retrievedAt, snapshotType: "current" }));
    }
  }

  if (includeHistory && maxHistorySnapshots > 0) {
    const cutoff = dateDaysAgo(historyLookbackDays);
    const partSet = new Set(parts.map(String));
    const records = await allVersionRecords(maxVersionPages);
    const snapshots = records
      .filter((item) => item.type === "section" && item.date >= cutoff && partSet.has(String(item.part || "")))
      .map((item) => ({ part: Number(item.part), date: item.date }))
      .filter((item) => item.part && item.date)
      .sort((a, b) => b.date.localeCompare(a.date) || a.part - b.part);
    const uniqueSnapshots = Array.from(new Map(snapshots.map((item) => [`${item.part}|${item.date}`, item])).values())
      .slice(0, maxHistorySnapshots);
    for (const snapshot of uniqueSnapshots) {
      await recordSnapshot(
        await fetchPartSnapshot({
          part: snapshot.part,
          date: snapshot.date,
          retrievedAt,
          snapshotType: "historical"
        })
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    retrievedAt,
    source: "eCFR Title 48 XML full text and version metadata",
    nodeCount: nodes.length,
    skippedCount: skipped.length,
    skipped,
    nodes
  };
}

async function ensureSchema(client) {
  await client.query(`
    create table if not exists source_refresh_runs (
      id bigserial primary key,
      source text not null,
      started_at timestamptz not null default now(),
      completed_at timestamptz,
      status text not null default 'running',
      node_count integer not null default 0,
      details jsonb not null default '{}'::jsonb
    );
    create table if not exists ecfr_nodes (
      id text primary key,
      citation text not null,
      title text not null,
      type text not null,
      part text not null,
      regime text not null,
      source_url text not null,
      retrieved_at date not null,
      effective_date date,
      snapshot_date date not null,
      snapshot_type text not null check (snapshot_type in ('current', 'historical')),
      excerpt text not null default '',
      body_text text not null default '',
      metadata jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create index if not exists ecfr_nodes_citation_idx on ecfr_nodes (citation);
    create index if not exists ecfr_nodes_part_snapshot_idx on ecfr_nodes (part, snapshot_date desc);
    create index if not exists ecfr_nodes_regime_idx on ecfr_nodes (regime);
  `);
}

async function insertNodes(client, nodes) {
  for (const node of nodes) {
    await client.query(
      `insert into ecfr_nodes (
        id, citation, title, type, part, regime, source_url, retrieved_at,
        effective_date, snapshot_date, snapshot_type, excerpt, body_text, metadata, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, now()
      )
      on conflict (id) do update set
        citation = excluded.citation,
        title = excluded.title,
        type = excluded.type,
        part = excluded.part,
        regime = excluded.regime,
        source_url = excluded.source_url,
        retrieved_at = excluded.retrieved_at,
        effective_date = excluded.effective_date,
        snapshot_date = excluded.snapshot_date,
        snapshot_type = excluded.snapshot_type,
        excerpt = excluded.excerpt,
        body_text = excluded.body_text,
        metadata = excluded.metadata,
        updated_at = now()`,
      [
        node.id,
        node.citation,
        node.title,
        node.type,
        node.part,
        node.regime,
        node.sourceUrl,
        node.retrievedAt,
        node.effectiveDate,
        node.snapshotDate,
        node.snapshotType,
        node.excerpt,
        node.bodyText,
        JSON.stringify(node.metadata)
      ]
    );
  }
}

async function createDatabaseWriter() {
  if (!process.env.DATABASE_URL || process.env.ECFR_INCREMENTAL_DATABASE === "false") return null;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=require") ? undefined : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  let nodeCount = 0;
  let closed = false;
  const run = { id: null };
  try {
    await ensureSchema(client);
    const result = await client.query(
      "insert into source_refresh_runs (source, details) values ($1, $2) returning id",
      ["ecfr", JSON.stringify({ mode: "incremental" })]
    );
    run.id = result.rows[0].id;
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }

  return {
    async writeNodes(nodes) {
      await client.query("begin");
      try {
        await insertNodes(client, nodes);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
      nodeCount += nodes.length;
      await client.query("update source_refresh_runs set node_count = $1 where id = $2", [nodeCount, run.id]);
    },
    async complete(cache) {
      await client.query(
        "update source_refresh_runs set completed_at = now(), status = $1, node_count = $2, details = $3 where id = $4",
        [
          "complete",
          nodeCount,
          JSON.stringify({
            mode: "incremental",
            generatedAt: cache.generatedAt,
            skippedCount: cache.skippedCount,
            skipped: cache.skipped
          }),
          run.id
        ]
      );
    },
    async fail(error) {
      await client.query(
        "update source_refresh_runs set completed_at = now(), status = $1, node_count = $2, details = $3 where id = $4",
        ["failed", nodeCount, JSON.stringify({ mode: "incremental", error: String(error?.message || error) }), run.id]
      ).catch(() => {});
    },
    async close() {
      if (closed) return;
      closed = true;
      client.release();
      await pool.end();
    }
  };
}

async function writeToDatabase(cache) {
  if (!process.env.DATABASE_URL) return false;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=require") ? undefined : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  let runId;
  try {
    await ensureSchema(client);
    const run = await client.query(
      "insert into source_refresh_runs (source, details) values ($1, $2) returning id",
      ["ecfr", JSON.stringify({ generatedAt: cache.generatedAt, skippedCount: cache.skippedCount, skipped: cache.skipped })]
    );
    runId = run.rows[0].id;
    await client.query("begin");
    await insertNodes(client, cache.nodes);
    await client.query("commit");
    await client.query(
      "update source_refresh_runs set completed_at = now(), status = $1, node_count = $2 where id = $3",
      ["complete", cache.nodes.length, runId]
    );
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (runId) {
      await client.query(
        "update source_refresh_runs set completed_at = now(), status = $1, details = $2 where id = $3",
        ["failed", JSON.stringify({ error: String(error?.message || error) }), runId]
      ).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function writeJson(cache) {
  if (process.env.ECFR_WRITE_JSON === "false") return false;
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  return true;
}

const databaseWriter = await createDatabaseWriter();
let cache;
let databaseWritten = false;
let jsonWritten = false;
try {
  cache = await buildNodes({
    onSnapshot: databaseWriter ? (nodes) => databaseWriter.writeNodes(nodes) : null
  });
  if (!cache.nodes.length && process.env.ECFR_ALLOW_EMPTY !== "true") {
    throw new Error("eCFR refresh produced zero nodes. Upstream XML may be unavailable; set ECFR_ALLOW_EMPTY=true only for diagnostics.");
  }
  if (databaseWriter) {
    await databaseWriter.complete(cache);
    databaseWritten = true;
  } else {
    databaseWritten = await writeToDatabase(cache);
  }
  jsonWritten = await writeJson(cache);
} catch (error) {
  if (databaseWriter) await databaseWriter.fail(error);
  throw error;
} finally {
  if (databaseWriter) await databaseWriter.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      nodeCount: cache.nodeCount,
      skippedCount: cache.skippedCount,
      skipped: cache.skipped,
      databaseWritten,
      jsonWritten,
      cachePath: jsonWritten ? CACHE_PATH : "",
      databaseConfigured: Boolean(process.env.DATABASE_URL)
    },
    null,
    2
  )
);
