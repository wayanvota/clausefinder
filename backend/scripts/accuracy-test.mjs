import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchFar } from "../search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesPath = join(__dirname, "..", "data", "accuracy-cases.json");
const resultsPath = join(__dirname, "..", "data", "benchmark-results.json");
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const failures = [];
const summary = [];
const answerable = cases.filter((testCase) => testCase.expectedBehavior !== "no_match");
const traps = cases.filter((testCase) => testCase.expectedBehavior === "no_match" || testCase.expectedBehavior === "caveat_required");

function citations(results, count) {
  return results.slice(0, count).map((result) => String(result.citation));
}

function firstHitRank(results, acceptable) {
  if (!acceptable?.length) return null;
  const index = results.findIndex((result) => acceptable.includes(String(result.citation)));
  return index >= 0 ? index + 1 : null;
}

function hasRequiredCaveat(response, testCase) {
  if (testCase.expectedBehavior !== "caveat_required") return true;
  const haystack = JSON.stringify(response).toLowerCase();
  return (testCase.requiredCaveats || ["verify agency adoption", "not a compliance verdict"]).some((phrase) =>
    haystack.includes(String(phrase).toLowerCase())
  );
}

let topOneHits = 0;
let topThreeHits = 0;
let topFiveHits = 0;
let reciprocalRankTotal = 0;
let answerableWithExpectations = 0;
let trapRefusals = 0;
let falseRefusals = 0;
let citationResolved = 0;
let citationDisplayed = 0;
let caveatPasses = 0;
let caveatChecks = 0;

for (const testCase of cases) {
  const response = await searchFar({
    query: testCase.query,
    context: testCase.context || {},
    limit: 8,
    includeAnswer: false
  });
  const topOne = citations(response.results, 1);
  const topThree = citations(response.results, 3);
  const topFive = citations(response.results, 5);
  const expectedTopOne = testCase.expectedTopOne || [];
  const expectedTopFive = testCase.expectedTopFive || [];
  const acceptable = [...new Set([...expectedTopOne, ...expectedTopFive, ...(testCase.acceptableCitations || [])])];
  const expectedNoMatch = testCase.expectedBehavior === "no_match";
  const topOnePass = expectedTopOne.length ? expectedTopOne.some((citation) => topOne.includes(citation)) : true;
  const topFivePass = expectedTopFive.length
    ? expectedTopFive.some((citation) => topFive.includes(citation))
    : true;
  const noMatchPass = expectedNoMatch ? response.results.length === 0 || Boolean(response.noMatchReason) : true;
  if (!expectedNoMatch && response.results.length === 0) falseRefusals += 1;
  if (expectedNoMatch && noMatchPass) trapRefusals += 1;
  const rank = firstHitRank(response.results, acceptable);
  if (acceptable.length && !expectedNoMatch) {
    answerableWithExpectations += 1;
    if (rank === 1) topOneHits += 1;
    if (rank && rank <= 3) topThreeHits += 1;
    if (rank && rank <= 5) topFiveHits += 1;
    if (rank) reciprocalRankTotal += 1 / rank;
  }
  for (const result of response.results) {
    citationDisplayed += 1;
    if (result.citation && result.sourceUrl) citationResolved += 1;
  }
  if (testCase.expectedBehavior === "caveat_required") {
    caveatChecks += 1;
    if (hasRequiredCaveat(response, testCase)) caveatPasses += 1;
  }
  const passed = topOnePass && topFivePass && noMatchPass && hasRequiredCaveat(response, testCase);
  summary.push({
    id: testCase.id,
    passed,
    topOne: topOne[0] || "",
    topThree,
    topFive
  });
  if (!passed) {
    failures.push({
      id: testCase.id,
      query: testCase.query,
      expectedTopOne,
      expectedTopFive,
      expectedBehavior: testCase.expectedBehavior || "answer",
      actualTopFive: topFive
    });
  }
}

const benchmark = {
  ok: failures.length === 0,
  label: "ClauseFinder deterministic benchmark",
  generatedAt: new Date().toISOString(),
  cases: cases.length,
  answerableCases: answerable.length,
  trapCases: traps.length,
  reviewedCases: cases.filter((item) => Array.isArray(item.reviewedBy) && item.reviewedBy.length).length,
  topOneRate: answerableWithExpectations ? topOneHits / answerableWithExpectations : null,
  topThreeRate: answerableWithExpectations ? topThreeHits / answerableWithExpectations : null,
  topFiveRate: answerableWithExpectations ? topFiveHits / answerableWithExpectations : null,
  meanReciprocalRank: answerableWithExpectations ? reciprocalRankTotal / answerableWithExpectations : null,
  refusalPrecision: traps.length ? trapRefusals / Math.max(trapRefusals + falseRefusals, 1) : null,
  refusalRecall: traps.length ? trapRefusals / traps.length : null,
  caveatCompliance: caveatChecks ? caveatPasses / caveatChecks : null,
  citationResolutionRate: citationDisplayed ? citationResolved / citationDisplayed : null,
  note:
    cases.length >= 70
      ? "Practitioner-review status depends on reviewedBy fields in the gold set."
      : "Interim, partial corpus. The design target is at least 60 reviewed answerable questions and 10 reviewed trap questions.",
  failures,
  summary
};

await writeFile(resultsPath, `${JSON.stringify(benchmark, null, 2)}\n`);

console.log(
  JSON.stringify(
    benchmark,
    null,
    2
  )
);

if (failures.length) process.exit(1);
