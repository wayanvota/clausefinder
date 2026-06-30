# Deployment

## Render

This repo includes `render.yaml` with two services.

1. Connect the GitHub repository to Render.
2. Create the services from `render.yaml` as a Blueprint.
3. Deploy the backend service first: `clausefinder-api`.
4. Copy the backend URL, for example `https://clausefinder-api.onrender.com`.
5. Set `VITE_API_BASE` on the static site to that backend URL.
6. Deploy the frontend service: `wayan-clause-finder`.
7. Copy the frontend origin.
8. Set `FRONTEND_ORIGIN` on the backend to the frontend origin.
9. Set `OPENAI_API_KEY` on the backend as a Render secret.
10. Optionally set `OPENAI_MODEL`; the default is `gpt-4.1-mini`.
11. Add `DATABASE_URL` on the backend after creating the Neon database below.
12. Redeploy the backend after all environment variables are set.

Do not commit `.env.local`. It is only for local development.

## Neon

Neon is optional for local development because the search index is committed at
`backend/data/far-index.json`. For the public Render deployment, use Neon as the
durable source cache. It can hold the committed FAR, DFARS, DAFFARS, FAR
Overhaul, Federal Register proposed-rule, eCFR current, and eCFR history nodes,
plus the larger live eCFR refresh cache.

Create the database:

1. Create a Neon project.
2. Open the connection details for the database.
3. Choose the pooled connection string unless you have a reason to use the direct connection.
4. Copy the connection string. It should look like `postgresql://...neon.tech/...?...sslmode=require`.
5. In Render, open the `clausefinder-api` backend service.
6. Go to **Environment**.
7. Add an environment variable named `DATABASE_URL`.
8. Paste the Neon connection string as the value.
9. Save changes and redeploy the backend.

The import and refresh jobs create their required tables if they do not exist.
The schema is also stored in `backend/scripts/neon-schema.sql` for inspection.

## Static Source Import

After `DATABASE_URL` is set on the Render backend and the backend has
redeployed, import the committed search index into Neon:

```bash
npm run import:static-index
```

If you run it from the repo root instead of the backend service directory:

```bash
npm --prefix backend run import:static-index
```

This populates `source_nodes`. After import, the backend prefers `source_nodes`
over the bundled JSON file, while still appending rows from `ecfr_nodes` as the
live eCFR overlay.

Useful Neon checks:

```sql
select count(*) as source_nodes from source_nodes;
select regime, count(*) from source_nodes group by regime order by regime;
select count(*) as ecfr_nodes from ecfr_nodes;
select snapshot_type, count(*) from ecfr_nodes group by snapshot_type order by snapshot_type;
select source, status, node_count, completed_at, details
from source_refresh_runs
order by started_at desc
limit 10;
```

## eCFR Cache Refresh

The normal app uses the committed static index. The larger eCFR cache job is
separate so Render startup stays fast.

The job downloads and parses public eCFR Title 48 XML:

- current full text for configured parts,
- historical full-text snapshots for changed parts inside the lookback window,
- refresh-run metadata.

When `DATABASE_URL` is set, the job writes to Neon tables. When `DATABASE_URL`
is not set, it writes `backend/data/ecfr-cache.json` locally; that file is
ignored by Git.

Default backend environment variables in `render.yaml`:

```text
ECFR_HISTORY_LOOKBACK_DAYS=365
ECFR_MAX_HISTORY_SNAPSHOTS=120
ECFR_WRITE_JSON=false
```

Manual refresh command in the Render backend shell:

```bash
ECFR_WRITE_JSON=false ECFR_HISTORY_LOOKBACK_DAYS=365 ECFR_MAX_HISTORY_SNAPSHOTS=120 npm run refresh:ecfr-cache
```

If you run it from the repo root instead of the backend service directory:

```bash
ECFR_WRITE_JSON=false ECFR_HISTORY_LOOKBACK_DAYS=365 ECFR_MAX_HISTORY_SNAPSHOTS=120 npm --prefix backend run refresh:ecfr-cache
```

For a smaller test refresh:

```bash
ECFR_PARTS=52 ECFR_HISTORY_LOOKBACK_DAYS=90 ECFR_MAX_HISTORY_SNAPSHOTS=5 npm run refresh:ecfr-cache
```

## Operational Notes

- Run the static source import after `DATABASE_URL` is set. Without it, the app
  still works from the bundled JSON index, but Neon will not contain FAR,
  DFARS, DAFFARS, FAR Overhaul, or Federal Register proposed-rule rows in
  `source_nodes`.
- Run the eCFR cache refresh after `DATABASE_URL` is set.
- Keep `ECFR_WRITE_JSON=false` on Render so the job writes to Neon rather than
  the service filesystem.
- The current public eCFR API does not expose every DAFFARS 5300-series part
  through the same part XML endpoint. DAFFARS is still indexed from
  Acquisition.gov in the committed static index.
- If the eCFR XML endpoint returns a 5xx error, rerun the command later. The
  refresh script retries transient failures and fails rather than writing an
  empty cache unless `ECFR_ALLOW_EMPTY=true` is set for diagnostics.
- When `source_nodes` has rows, the backend uses Neon as the primary source
  cache at startup. When `source_nodes` is empty or unavailable, it falls back
  to the committed JSON index.

## References

- Render Blueprints: https://render.com/docs/blueprint-spec
- Render environment variables: https://render.com/docs/environment-variables
- Render jobs: https://render.com/docs/jobs
- Neon connection strings: https://neon.com/docs/connect/connect-from-any-app
- eCFR API documentation: https://www.ecfr.gov/developers/documentation/api/v1
