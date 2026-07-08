# Contributing

ClauseFinder is public for transparency and review. Contributions are welcome when they improve source discipline, retrieval quality, documentation, or safety.

## Useful Contributions

- Add practitioner-reviewed benchmark cases.
- Improve public-source ingestion.
- Improve citation extraction and source provenance.
- Improve refusal behavior for non-acquisition questions.
- Improve Air Force, DFARS, DAFFARS, and FAR Overhaul source coverage.
- Fix documentation that overclaims what the tool can do.

## Benchmark Case Format

Add deterministic benchmark cases in `backend/data/accuracy-cases.json`.

Good benchmark cases include:

- Verbatim clause text.
- Plain-language paraphrases.
- Abstract acquisition scenarios.
- Trap questions that should not return acquisition authorities.

Every benchmark case should identify expected citations or expected no-match behavior.

## Local Checks

Run:

```bash
npm --prefix backend test
npm run build
```

## Sensitive Material

Do not contribute CUI, source-selection information, proposal text, proprietary contractor information, personal identifiers, classified information, or sensitive program facts. Use public-source examples only.
