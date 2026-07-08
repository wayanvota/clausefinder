# ClauseFinder Architecture

ClauseFinder is split into a small Node backend and a static React frontend.

## Request Flow

```text
User question
  -> frontend context controls
  -> /api/clarify, optional
  -> /api/search
  -> scope and sensitive-text checks
  -> public-source index search
  -> ranked candidate authorities
  -> optional grounded OpenAI summary
  -> reviewer-facing UI
```

## Backend

The backend lives in `backend/`.

- `server.js` exposes `/health`, `/api/meta`, `/api/coverage`, `/api/clarify`, and `/api/search`.
- `search.js` loads indexed public-source nodes, applies sensitive-text checks, blocks out-of-scope questions, ranks candidates, and builds source-verification metadata.
- `openai.js` asks clarifying questions and writes grounded summaries only from retrieved candidates when `OPENAI_API_KEY` is configured.
- `scripts/` contains ingestion, eCFR refresh, benchmark, audit, and Neon import commands.

The backend can search the static generated index or Neon tables. Neon improves deploy-time retrieval because Render does not need to rebuild or load every source from disk for each refresh workflow.

## Frontend

The frontend lives in `wayan.com/clause-finder/`.

- The Tool page supports guided clarification and direct search.
- The results panel shows candidate authorities, score components, source links, and caveats.
- The verification panel shows clause passport, applicability checks, version comparison, source chain, and reviewer notes.
- The About, Method, Coverage, Benchmark, and Sources pages make limits visible.

## Source Posture

ClauseFinder is built around public regulatory and acquisition-policy sources. It should not ingest user contract files, proposal text, CUI, source-selection material, personal identifiers, or proprietary contractor information.

## Accuracy Posture

The benchmark in `backend/data/accuracy-cases.json` is a deterministic development guardrail. It is not yet a statistically meaningful evaluation. The intended next step is a practitioner-reviewed gold set with answerable, paraphrased, abstract, and trap questions.
