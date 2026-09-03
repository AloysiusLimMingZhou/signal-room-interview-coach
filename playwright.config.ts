import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  outputDir: "output/playwright/results",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_USE_INSTALLED_CHROME ? "chrome" : undefined,
      },
    },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next start",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
