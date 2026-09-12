# ClauseFinder end-to-end test report

## Scope

The Playwright harness runs the production React/Vite interface against the real
Node search service and committed acquisition-rule index. OpenAI and Neon are
disabled for the deterministic gate. The actual retrieval, ranking, source
links, context handling, sensitive-text controls, bounded JSON parsing, CORS,
security headers, and export workflow remain active.

## Required categories

| ID | Category | Expected behavior |
| --- | --- | --- |
| U01 | Public trust boundary | Source and human-decision guardrails render |
| U02 | Default query | Ranked public-source candidates appear |
| U03 | Citation search | Named authority ranks first |
| U04 | Clarification | User can answer clarifying questions before search |
| U05 | Acquisition context | Selected facts appear in applicability checks |
| U06 | Result selection | Selected result updates Clause Passport |
| U07 | Verification views | Source text and challenge checklist remain accessible |
| U08 | Reviewer feedback | Vote and note remain attached to a candidate |
| U09 | Supporting pages | About, Method, Coverage, Benchmark, and Sources load |
| U10 | Export | Reviewer session downloads as JSON |
| A01 | Empty query | No result is invented; manual search remains available |
| A02 | Off-topic query | Non-acquisition prompt is refused |
| A03 | Sensitive content | Warning appears and results are withheld |
| A04 | Active HTML | Script-like input stays inert |
| A05 | Malformed JSON | API returns bounded 400 without stack details |
| A06 | Oversized request | API returns 413 before search |
| A07 | CORS boundary | Untrusted origin receives no matching permission |
| A08 | Extreme limit | Results remain capped at twenty |
| A09 | Route abuse | Unknown route and unsupported method fail closed |
| A10 | Error disclosure | Errors omit keys, authorization, and stack traces |

## Verification record

Status: local gate and GitHub Actions run 34663997789 passed on 2026-09-11.

- Backend checks: 2 HTML unit tests, smoke test, and 11-case deterministic
  retrieval benchmark passed.
- Production build: passed with Vite 8.1.0.
- End-to-end suite: 20 of 20 passed, covering U01-U10 and A01-A10.
- Dependency audit: 0 vulnerabilities.
- Authorized live-provider smoke: passed with two citations, both grounded in
  the retrieved result set. No credential was persisted or printed.

The first E2E run passed 15 of 20 cases. Four failures were corrected test
selectors; the malformed-request case was corrected to send raw invalid bytes.
The harness also exposed and fixed duplicate React keys in the grounded-summary
citation list. The complete gate then passed.

```bash
npm ci
npx playwright install chromium
npm run test:ci
npm audit --audit-level=high
```

The deterministic suite reads no API or database credentials. Any authorized
OpenAI smoke remains separate and is excluded from CI.
