import { defineConfig } from "@playwright/test";

const webPort = 4194;
const apiPort = 8787;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.e2e.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  outputDir: "artifacts/playwright-results",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: `PORT=${apiPort} HOST=127.0.0.1 FRONTEND_ORIGIN=http://127.0.0.1:${webPort} ECFR_SEARCH_DATABASE=false npm --prefix backend start`,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `npm --prefix wayan.com/clause-finder run dev -- --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
