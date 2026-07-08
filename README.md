# ClauseFinder

ClauseFinder is a public acquisition-rule search tool by Wayan Vota. It helps Air Force acquisition staff, federal procurement teams, and contractor contract managers turn a plain-language acquisition question into source-linked candidate FAR, DFARS, DAFFARS, eCFR, FAR Overhaul, deviation, and proposed-rule authorities.

Live demo: [wayan.com/clause-finder](https://wayan.com/clause-finder/)

GitHub repo: [github.com/wayanvota/clausefinder](https://github.com/wayanvota/clausefinder)

The core position is explicit: ClauseFinder is decision support, not a compliance verdict. It ranks candidate authorities, shows why they may matter, links back to public sources, and leaves the final judgment to a warranted professional or qualified reviewer.

## Why This Exists

The FAR is changing in 2026, and acquisition staff are being asked to reason across multiple moving layers: current FAR, DFARS, Air Force supplements, eCFR snapshots, FAR Overhaul material, deviations, and proposed rules. Ordinary search often hides the version and source problem. ClauseFinder makes that problem visible.

This project is also a “built by user” demonstration. A subject-matter user defined the problem, shaped the workflow, tested real acquisition questions, and used AI-assisted development to produce a working public tool with source discipline, disclaimers, benchmark checks, and deployment wiring.

## What It Shows

- Public-source ingestion from Acquisition.gov, eCFR, Federal Register, FAR Overhaul, and related acquisition-rule sources.
- Dynamic search over user-entered acquisition questions, not a fixed demo script.
- Clarifying questions before search when missing facts affect retrieval.
- Ranked candidate authorities with citation, source family, score components, version status, and source links.
- Grounded summaries generated only from retrieved candidates when `OPENAI_API_KEY` is configured.
- Sensitive-text guardrails for CUI, source-selection material, proposal content, proprietary contractor information, and personal identifiers.
- Scope refusal for non-acquisition questions, so the tool does not invent plausible-looking FAR results for irrelevant prompts.
- Benchmark checks for expected clauses, paraphrases, abstract questions, and trap questions.
- Render and Neon-ready deployment structure.

## Current Demo Queries

These are useful smoke tests when evaluating the tool:

```text
What clause requires a contractor to keep its SAM registration active during contract performance?
```

Expected lead: `52.204-13`, System for Award Management Maintenance.

```text
what are export controls on f35?
```

Expected leads: `225.7901-2`, `225.7901-3`, and `252.225-7048`, Export-Controlled Items.

```text
What is the best pizza topping for an office lunch?
```

Expected behavior: no acquisition-rule result, with a clear scope note.

## Repository Layout

```text
backend/
  data/accuracy-cases.json              Small deterministic benchmark set
  data/benchmark-results.json           Last local benchmark result
  data/far-index.json                   Generated acquisition-rule index
  scripts/build-far-index.mjs           Public source ingestion script
  scripts/refresh-ecfr-cache.mjs        eCFR XML refresh job
  scripts/import-static-index.mjs       Neon import helper
  scripts/neon-schema.sql               Optional Neon schema
  search.js                             Ranking, guardrails, context extraction
  openai.js                             Clarifying questions and grounded summaries
  server.js                             HTTP API

wayan.com/clause-finder/
  src/main.jsx                          Public tool and related pages
  src/styles.css                        Wayan-branded UI styling
  dist/                                 Built static files for hosting

docs/
  architecture.md                       How the app is structured
  demo-script.md                        Short evaluation script for reviewers
  deployment.md                         Render, Neon, and refresh notes
  github-project.md                     Original project framing
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

The local frontend calls the local backend by default. For a local frontend pointed at the deployed API, set `VITE_API_BASE`.

## Refresh The Index

```bash
npm run index:far
```

The indexer fetches public FAR, DFARS, DAFFARS, FAR Overhaul, Federal Register proposed-rule, current eCFR Title 48 XML, and eCFR Title 48 version metadata sources, then writes `backend/data/far-index.json`.

For Neon-backed search, import the generated static index:

```bash
npm run import:static-index
```

## Checks

```bash
npm --prefix backend test
npm run build
```

The backend test suite includes smoke checks and an interim deterministic accuracy set. The stored benchmark is intentionally labeled partial until a practitioner-reviewed gold set is built.

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
  "limit": 8,
  "includeAnswer": true
}
```

## Deployment

`render.yaml` defines two Render services:

- `clausefinder-api`: Node backend.
- `wayan-clause-finder`: static frontend under the `wayan.com/clause-finder` app.

Environment variables:

```text
OPENAI_API_KEY        Backend only. Enables clarifying questions and summaries.
OPENAI_MODEL          Optional. Defaults to gpt-4.1-mini.
DATABASE_URL          Optional. Enables Neon-backed source search.
FRONTEND_ORIGIN       Backend CORS origin.
VITE_API_BASE         Frontend API base URL.
```

Do not commit `.env`, `.env.*`, database connection strings, API keys, query logs, source-selection material, or user-uploaded contract text.

## Current Limits

- ClauseFinder ranks candidate authorities. It does not decide compliance, prescribe clause use, or replace a contracting officer, counsel, policy office, or contract manager.
- eCFR current full text is indexed where the public Title 48 XML endpoint exposes the part. Historical eCFR coverage is still partial.
- Federal Register proposed-rule coverage indexes available text and metadata, but proposed rules are not current law.
- FAR Overhaul and deviation coverage is labeled by source and method. Agency adoption must be verified.
- The benchmark is still interim. The target is a practitioner-reviewed set with at least 60 answerable questions and 10 trap questions.
- Ranking combines lexical search and domain-specific boosts. It is retrieval support, not legal reasoning.

## License And Reuse

ClauseFinder is released under the [0BSD license](LICENSE). You may use, copy, modify, and distribute the software for any purpose, with or without attribution.

## Related Notes

- [Architecture](docs/architecture.md)
- [Demo Script](docs/demo-script.md)
- [Deployment Notes](docs/deployment.md)
