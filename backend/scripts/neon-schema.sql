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

create table if not exists source_edges (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  from_node_id text not null,
  to_node_id text,
  edge_type text not null check (edge_type in ('version_of', 'delta', 'removed_content_relocated_to', 'proposed_change')),
  method text not null,
  confidence text not null check (confidence in ('high', 'medium', 'low', 'none')),
  source_url text,
  retrieved_at text,
  version_label text,
  details jsonb not null default '{}'::jsonb
);

create table if not exists amendment_history (
  id bigserial primary key,
  citation text not null,
  part text,
  amendment_date date,
  source_url text not null,
  retrieved_at date not null default current_date,
  details jsonb not null default '{}'::jsonb
);

create table if not exists coverage_gaps (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  workstream text not null,
  source_family text not null,
  status text not null,
  source_url text,
  detail text not null default '',
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists benchmark_runs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  build_label text not null default 'local',
  mode text not null default 'deterministic',
  case_count integer not null default 0,
  reviewed_case_count integer not null default 0,
  top_one_rate numeric,
  top_three_rate numeric,
  top_five_rate numeric,
  mean_reciprocal_rank numeric,
  refusal_precision numeric,
  refusal_recall numeric,
  caveat_compliance numeric,
  citation_resolution_rate numeric,
  details jsonb not null default '{}'::jsonb
);

create index if not exists source_nodes_citation_idx on source_nodes (citation);
create index if not exists source_nodes_regime_idx on source_nodes (regime);
create index if not exists source_nodes_part_idx on source_nodes (part);
create index if not exists ecfr_nodes_citation_idx on ecfr_nodes (citation);
create index if not exists ecfr_nodes_part_snapshot_idx on ecfr_nodes (part, snapshot_date desc);
create index if not exists ecfr_nodes_regime_idx on ecfr_nodes (regime);
create index if not exists source_edges_from_idx on source_edges (from_node_id);
create index if not exists source_edges_type_idx on source_edges (edge_type);
create index if not exists amendment_history_citation_idx on amendment_history (citation, amendment_date desc);
create index if not exists coverage_gaps_workstream_idx on coverage_gaps (workstream, status);
