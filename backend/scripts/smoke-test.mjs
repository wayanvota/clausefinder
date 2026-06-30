import { searchFar, getMeta } from "../search.js";

const meta = await getMeta();
if (!meta.totalNodes) {
  throw new Error("Acquisition-rule index is empty. Run npm --prefix backend run index:far.");
}

const sam = await searchFar({ query: "What changed about SAM registration?", limit: 5, includeAnswer: false });
if (!sam.results.length) {
  throw new Error("Expected SAM query to return at least one result.");
}
if (!sam.results[0].clausePassport?.airForceStack?.length) {
  throw new Error("Expected top result to include Clause Passport and Air Force stack metadata.");
}
if (!meta.evaluation?.cases) {
  throw new Error("Expected meta endpoint data to include the evaluation harness summary.");
}

const threshold = await searchFar({
  query: "I have a 9000 dollar supply buy, what are my options?",
  limit: 5,
  includeAnswer: false
});
if (!threshold.results.length) {
  throw new Error("Expected threshold query to return at least one result.");
}

const sensitive = await searchFar({ query: "CUI source selection proposal with proprietary price", includeAnswer: false });
if (!sensitive.sensitiveHits.length || sensitive.results.length) {
  throw new Error("Expected sensitive-text guardrail to block results.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      totalNodes: meta.totalNodes,
      evaluationCases: meta.evaluation.cases,
      samTop: sam.results[0].citation,
      samPassport: Boolean(sam.results[0].clausePassport),
      thresholdTop: threshold.results[0].citation,
      sensitiveHits: sensitive.sensitiveHits
    },
    null,
    2
  )
);
