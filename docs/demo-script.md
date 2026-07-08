# ClauseFinder Demo Script

Use this script to evaluate the public tool quickly.

Live site: [wayan.com/clause-finder](https://wayan.com/clause-finder/)

## 1. Verbatim Or Near-Verbatim Clause Search

Search:

```text
The Contractor shall maintain registration in SAM during contract performance and through final payment.
```

Expected behavior:

- `52.204-13`, System for Award Management Maintenance, appears at or near the top.
- Results link to public sources.
- The result is framed as a candidate authority, not a compliance verdict.

## 2. Plain-Language Paraphrase

Search:

```text
Which clause tells a contractor to keep its SAM account active and accurate until the Government makes final payment?
```

Expected behavior:

- `52.204-13` appears at or near the top.
- The summary explains the fit using retrieved candidates.
- Caveats remind the reviewer to verify current source pages and contract facts.

## 3. Air Force Export-Control Scenario

Search:

```text
what are export controls on f35?
```

Expected behavior:

- DFARS export-control authorities appear, including `225.7901-2`, `225.7901-3`, and `252.225-7048`.
- The result should not pretend to answer all F-35 export-control law. It should orient the reviewer to candidate acquisition authorities and source links.

## 4. Trap Question

Search:

```text
What is the best pizza topping for an office lunch?
```

Expected behavior:

- No ranked FAR candidates.
- A clear scope note that ClauseFinder searches acquisition-rule sources only.

## 5. Reviewer Questions

For each useful result, ask:

- Is this a clause, provision, policy section, deviation, guidance source, or proposed-rule source?
- Does the source date match the solicitation, award, modification, or performance period being reviewed?
- Does DFARS, DAFFARS, or an Air Force Mandatory Procedure change the base FAR answer?
- Which required facts are still unknown?
- Would a contracting officer, policy office, counsel, or contract manager need another source before using this result operationally?
