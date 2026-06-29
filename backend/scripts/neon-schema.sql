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
