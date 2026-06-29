import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchFar } from "../search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const casesPath = join(__dirname, "..", "data", "accuracy-cases.json");
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const failures = [];
const summary = [];

function citations(results, count) {
  return results.slice(0, count).map((result) => String(result.citation));
}

for (const testCase of cases) {
  const response = await searchFar({
    query: testCase.query,
    context: testCase.context || {},
    limit: 8,
    includeAnswer: false
  });
  const topOne = citations(response.results, 1);
  const topFive = citations(response.results, 5);
  const expectedTopOne = testCase.expectedTopOne || [];
  const expectedTopFive = testCase.expectedTopFive || [];
  const topOnePass = expectedTopOne.length ? expectedTopOne.some((citation) => topOne.includes(citation)) : true;
  const topFivePass = expectedTopFive.length
    ? expectedTopFive.some((citation) => topFive.includes(citation))
    : true;
  const passed = topOnePass && topFivePass;
  summary.push({
    id: testCase.id,
    passed,
    topOne: topOne[0] || "",
    topFive
  });
  if (!passed) {
    failures.push({
      id: testCase.id,
      query: testCase.query,
      expectedTopOne,
      expectedTopFive,
      actualTopFive: topFive
    });
  }
}

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      cases: cases.length,
      passed: cases.length - failures.length,
      summary,
      failures
    },
    null,
    2
  )
);

if (failures.length) process.exit(1);
