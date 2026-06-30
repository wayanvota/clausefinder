import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.FAR_INDEX_PATH || join(__dirname, "..", "data", "far-index.json");
const BATCH_SIZE = Number(process.env.SOURCE_IMPORT_BATCH_SIZE || 250);

function dbPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to import the static index into Neon.");
  }
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=require") ? undefined : { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 5000
  });
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
    create table if not exists source_nodes (
      id text primary key,
      citation text not null,
      title text not null,
      type text not null,
      part text,
      regime text not null,
      source_url text,
      retrieved_at text,
      effective_date text,
      excerpt text not null default '',
      body_text text not null default '',
      prescription text not null default '',
      hierarchy_path jsonb not null default '[]'::jsonb,
      related jsonb not null default '[]'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create index if not exists source_nodes_citation_idx on source_nodes (citation);
    create index if not exists source_nodes_regime_idx on source_nodes (regime);
    create index if not exists source_nodes_part_idx on source_nodes (part);
  `);
}

async function insertBatch(client, nodes) {
  for (const node of nodes) {
    await client.query(
      `insert into source_nodes (
        id, citation, title, type, part, regime, source_url, retrieved_at,
        effective_date, excerpt, body_text, prescription, hierarchy_path, related,
        metadata, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14,
        $15, now()
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
        excerpt = excluded.excerpt,
        body_text = excluded.body_text,
        prescription = excluded.prescription,
        hierarchy_path = excluded.hierarchy_path,
        related = excluded.related,
        metadata = excluded.metadata,
        updated_at = now()`,
      [
        node.id,
        node.citation || "",
        node.title || node.citation || "",
        node.type || "section",
        node.part || null,
        node.regime || "Source",
        node.sourceUrl || "",
        node.retrievedAt || "",
        node.effectiveDate || "",
        node.excerpt || "",
        node.bodyText || "",
        node.prescription || "",
        JSON.stringify(node.hierarchyPath || []),
        JSON.stringify(node.related || []),
        JSON.stringify({
          sourceBaseUrl: node.sourceBaseUrl || "",
          snapshotType: node.snapshotType || "",
          snapshotDate: node.snapshotDate || "",
          importedFrom: "backend/data/far-index.json"
        })
      ]
    );
  }
}

function countByRegime(nodes) {
  return nodes.reduce((acc, node) => {
    const regime = node.regime || "Source";
    acc[regime] = (acc[regime] || 0) + 1;
    return acc;
  }, {});
}

const raw = await readFile(INDEX_PATH, "utf8");
const index = JSON.parse(raw);
const nodes = index.nodes || [];
if (!nodes.length) throw new Error(`No nodes found in ${INDEX_PATH}`);

const pool = dbPool();
pool.on("error", (error) => {
  console.warn(`Neon idle connection closed during static import: ${error?.message || error}`);
});

let runId;
let imported = 0;
try {
  const client = await pool.connect();
  try {
    await ensureSchema(client);
  } finally {
    client.release();
  }
  const run = await pool.query(
    "insert into source_refresh_runs (source, details) values ($1, $2) returning id",
    [
      "static-index",
      JSON.stringify({
        generatedAt: index.generatedAt || "",
        sourceBaseUrl: index.sourceBaseUrl || "",
        totalNodes: nodes.length,
        byRegime: countByRegime(nodes)
      })
    ]
  );
  runId = run.rows[0].id;

  for (let offset = 0; offset < nodes.length; offset += BATCH_SIZE) {
    const batch = nodes.slice(offset, offset + BATCH_SIZE);
    const client = await pool.connect();
    await client.query("begin");
    try {
      await insertBatch(client, batch);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    imported += batch.length;
    await pool.query("update source_refresh_runs set node_count = $1 where id = $2", [imported, runId]);
    console.log(`Imported static source nodes: ${imported}/${nodes.length}`);
  }

  await pool.query(
    "update source_refresh_runs set completed_at = now(), status = $1, node_count = $2 where id = $3",
    ["complete", imported, runId]
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        imported,
        indexPath: INDEX_PATH,
        byRegime: countByRegime(nodes)
      },
      null,
      2
    )
  );
} catch (error) {
  if (runId) {
    await pool.query(
      "update source_refresh_runs set completed_at = now(), status = $1, node_count = $2, details = details || $3::jsonb where id = $4",
      ["failed", imported, JSON.stringify({ error: String(error?.message || error) }), runId]
    ).catch(() => {});
  }
  throw error;
} finally {
  await pool.end();
}
