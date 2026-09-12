import { expect, test } from "@playwright/test";

const api = "http://127.0.0.1:8787";

async function waitForResults(page) {
  await expect(page.locator(".result-card").first()).toBeVisible({ timeout: 15_000 });
}

async function search(page, query) {
  await page.locator(".question-box textarea").fill(query);
  await page.getByRole("button", { name: "Search now" }).click();
  await expect(page.locator(".results-panel")).toHaveAttribute("aria-busy", "false");
}

test("U01 public interface loads its source and human-decision guardrails", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ClauseFinder" })).toBeVisible();
  await expect(page.getByText("Decision support only")).toBeVisible();
  await expect(page.getByText("No compliance verdicts")).toBeVisible();
  expect(await page.content()).not.toContain("OPENAI_API_KEY");
});

test("U02 the default acquisition query produces ranked public-source candidates", async ({ page }) => {
  await page.goto("/");
  await waitForResults(page);
  await expect(page.locator(".results-title")).toContainText(/Showing \d+ candidates/);
  await expect(page.locator(".result-card").first().getByRole("link", { name: "Source" })).toHaveAttribute("href", /^https:\/\//);
});

test("U03 a direct citation search ranks that authority first", async ({ page }) => {
  await page.goto("/");
  await search(page, "What does FAR 52.204-13 require during contract performance?");
  await expect(page.locator(".result-card").first().getByRole("heading")).toContainText("52.204-13");
});

test("U04 clarifying questions can be answered before search", async ({ page }) => {
  await page.goto("/");
  await page.locator(".question-box textarea").fill("Which contract clause should I inspect?");
  await page.getByLabel("acquisition Type").selectOption("Not sure");
  await page.getByLabel("commerciality").selectOption("Not sure");
  await page.getByLabel("value Band").selectOption("Not sure");
  await page.getByRole("button", { name: "Ask clarifying questions" }).click();
  await expect(page.getByText("Clarifying questions", { exact: true })).toBeVisible();
  await page.locator(".clarify-question select").first().selectOption({ index: 1 });
  await page.getByRole("button", { name: "Search with answers" }).click();
  await expect(page.locator(".results-panel")).toHaveAttribute("aria-busy", "false");
});

test("U05 explicit acquisition context remains visible in the verification checklist", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("acquisition Type").selectOption("Supply");
  await search(page, "Which FAR clause applies to this supply contract?");
  await page.getByRole("button", { name: "Prescription", exact: true }).click();
  await expect(page.locator(".check-list")).toContainText("Supply");
});

test("U06 selecting another result updates the Clause Passport", async ({ page }) => {
  await page.goto("/");
  await waitForResults(page);
  const cards = page.locator(".result-card");
  if (await cards.count() > 1) await cards.nth(1).locator(".result-main").click();
  await expect(page.getByRole("heading", { name: "Clause Passport" })).toBeVisible();
  await expect(page.locator(".passport-grid")).toContainText("Origin");
});

test("U07 verification tabs expose source text and the human challenge checklist", async ({ page }) => {
  await page.goto("/");
  await waitForResults(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Indexed source text" })).toBeVisible();
  await page.getByRole("button", { name: "Challenge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Challenge this result" })).toBeVisible();
  await expect(page.getByText("Human verification required.").first()).toBeVisible();
});

test("U08 reviewer feedback and notes stay attached to the selected candidate", async ({ page }) => {
  await page.goto("/");
  await waitForResults(page);
  await page.locator(".result-card").first().getByRole("button", { name: "Helpful", exact: true }).click();
  await page.getByLabel("Reviewer note").fill("Verify the prescription and effective date.");
  await expect(page.getByLabel("Reviewer note")).toHaveValue("Verify the prescription and effective date.");
});

test("U09 About, Method, Coverage, Benchmark, and Sources pages are reachable", async ({ page }) => {
  await page.goto("/");
  const checks = [["About", /not a legal answer machine/], ["Method", /How the search works/], ["Coverage", /Corpus coverage/], ["Benchmark", /benchmark/i], ["Sources", /source/i]];
  for (const [label, pattern] of checks) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(".page-panel")).toContainText(pattern);
  }
});

test("U10 a reviewer can export the current session as JSON", async ({ page }) => {
  await page.goto("/");
  await waitForResults(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export session" }).click();
  expect((await download).suggestedFilename()).toMatch(/^clausefinder-session-\d{4}-\d{2}-\d{2}\.json$/);
});

test("A01 empty search fails closed with a manual-search route", async ({ page }) => {
  await page.goto("/");
  await search(page, "");
  await expect(page.getByRole("heading", { name: "No confident candidate yet." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manual Acquisition.gov search" })).toBeVisible();
});

test("A02 non-acquisition prompts are refused without plausible FAR results", async ({ page }) => {
  await page.goto("/");
  await search(page, "What is the best pizza topping for lunch?");
  await expect(page.locator(".results-list")).toHaveCount(0);
  await expect(page.locator(".no-match")).toContainText("No acquisition-rule signal was detected");
});

test("A03 sensitive acquisition text triggers a warning and withholds results", async ({ page }) => {
  await page.goto("/");
  await search(page, "CUI source-selection technical proposal with proprietary offeror price");
  await expect(page.getByRole("alert")).toContainText("Do not paste sensitive acquisition material");
  await expect(page.locator(".results-list")).toHaveCount(0);
});

test("A04 active HTML is treated as query data and never executed", async ({ page }) => {
  await page.goto("/");
  await search(page, "<img src=x onerror=window.__pwned=true> FAR 52.204-13");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
});

test("A05 malformed JSON returns a bounded client error", async ({ request }) => {
  const response = await request.post(`${api}/api/search`, { headers: { "content-type": "application/json" }, data: Buffer.from("{") });
  expect(response.status()).toBe(400);
  expect(await response.text()).not.toMatch(/SyntaxError|server\.js:\d+|node:internal/);
});

test("A06 oversized JSON is rejected before search", async ({ request }) => {
  const response = await request.post(`${api}/api/search`, { data: { query: `FAR ${"x".repeat(70_000)}` } });
  expect(response.status()).toBe(413);
  expect((await response.json()).error).toMatch(/too large/i);
});

test("A07 an untrusted origin receives no matching CORS permission", async ({ request }) => {
  const response = await request.fetch(`${api}/api/search`, { method: "OPTIONS", headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } });
  expect(response.status()).toBe(204);
  expect(response.headers()["access-control-allow-origin"]).toBe("http://127.0.0.1:4194");
});

test("A08 extreme result limits are bounded to twenty", async ({ request }) => {
  const response = await request.post(`${api}/api/search`, { data: { query: "FAR contract clauses", limit: 100000, includeAnswer: false } });
  expect(response.status()).toBe(200);
  expect((await response.json()).results.length).toBeLessThanOrEqual(20);
});

test("A09 unknown routes and unsupported methods fail closed", async ({ request }) => {
  const [unknown, method] = await Promise.all([request.get(`${api}/api/not-a-route`), request.put(`${api}/api/search`, { data: {} })]);
  expect(unknown.status()).toBe(404);
  expect(method.status()).toBe(404);
  expect(unknown.headers()["x-content-type-options"]).toBe("nosniff");
});

test("A10 API error responses do not disclose credentials or stack traces", async ({ request }) => {
  const response = await request.post(`${api}/api/search`, { headers: { "content-type": "application/json" }, data: Buffer.from("{") });
  const body = await response.text();
  expect(body).not.toMatch(/OPENAI_API_KEY|DATABASE_URL|authorization|Bearer |node_modules/);
  expect(response.headers()["cache-control"]).toBe("no-store");
});
