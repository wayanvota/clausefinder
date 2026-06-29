create table if not exists search_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  query text not null,
  inferred_context jsonb not null default '{}'::jsonb,
  sensitive_hits text[] not null default '{}',
  result_count integer not null default 0,
  top_citations text[] not null default '{}'
);

create table if not exists reviewer_feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  citation text not null,
  vote text check (vote in ('helpful', 'not helpful')),
  note text,
  query text,
  result_snapshot jsonb not null default '{}'::jsonb
);

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
