# ClauseFinder

ClauseFinder is a public acquisition-rule search project by Wayan Vota. It helps users paste a plain-language acquisition question, answer clarifying questions, and find candidate FAR, DFARS, DAFFARS, FAR Overhaul, Federal Register, and eCFR-history signals from public sources.

The core position is explicit: this is decision support, not a compliance verdict. Every result should be treated as a candidate authority that a warranted professional still verifies.

## What It Does

- Searches a generated index of public acquisition-rule sources.
- Returns ranked candidate authorities for any user-entered text.
- Asks clarifying questions when the query lacks facts that affect retrieval.
- Uses the OpenAI API, when configured, to produce a grounded summary from retrieved candidates only.
- Shows source-linked citations, score components, extracted prescription language where available, cross-references, and a verification panel.
- Blocks sensitive-looking pasted text such as CUI, source-selection material, proposal content, proprietary contractor information, and personal identifiers.
- Provides pages under the public-facing `wayan.com/clause-finder/` app: Tool, About, Method, and Sources.
- Runs without storing user search text. Render can host the API and the static frontend. Neon is optional for future query logging and reviewer feedback persistence.

## Project Layout

```text
backend/
  data/far-index.json              Generated acquisition-rule index
  scripts/build-far-index.mjs      Public source ingestion script
  scripts/neon-schema.sql          Optional Neon schema
  search.js                        Ranking, guardrails, context extraction
  server.js                        HTTP API

wayan.com/clause-finder/
  index.html
  src/main.jsx                     Public tool and related pages
  src/styles.css
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the backend:

```bash
npm run dev:backend
```

Run the frontend:

```bash
npm run dev:frontend
```

The frontend proxies `/api` to the local backend.

## Refresh The Index

```bash
npm run index:far
```

The indexer fetches public FAR, DFARS, DAFFARS, FAR Overhaul, Federal Register proposed-rule, and eCFR Title 48 version metadata sources, then writes `backend/data/far-index.json`.

## Checks

```bash
npm --prefix backend test
npm run build
```

## API

```http
POST /api/search
Content-Type: application/json

{
  "query": "Which FAR clauses apply to safeguarding covered contractor information systems?",
  "context": {
    "acquisitionType": "Service",
    "commerciality": "Not sure",
    "fundingLayer": "Air Force"
  },
  "limit": 8
}
```

## Deployment

`render.yaml` defines two Render services:

- `clausefinder-api`: Node backend.
- `wayan-clause-finder`: static frontend under the `wayan.com/clause-finder` app.

Set `VITE_API_BASE` on the static site to the deployed API URL. Set `FRONTEND_ORIGIN` on the API to the deployed frontend origin.

Set `OPENAI_API_KEY` on the backend for clarifying questions and grounded summaries. `OPENAI_MODEL` is optional and defaults to `gpt-4.1-mini`.

If using Neon later, apply `backend/scripts/neon-schema.sql` and add a `DATABASE_URL` integration when feedback persistence is implemented.

## Current Limits

- eCFR coverage is version metadata, not full historical text snapshots.
- Federal Register proposed-rule coverage indexes available abstracts and metadata.
- FAR Overhaul coverage indexes public source pages and links; deviation PDF/text extraction should be hardened before operational use.
- Ranking is lexical with domain-specific boosts, not legal reasoning.
- The tool should not be used as an operational authority without a reviewer-built gold set and accuracy reporting.
