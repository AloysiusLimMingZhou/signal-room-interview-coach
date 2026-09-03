import { expect, test } from "@playwright/test";

test("candidate completes an evidence-backed mock interview", async ({ page }) => {
  await page.route("**/api/realtime/session", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "00000000-0000-4000-8000-000000000001",
        mode: "mock",
        model: "deterministic-local-interviewer",
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
        maxDurationMinutes: 10,
        persistence: "local",
      }),
    });
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Think out loud/i })).toBeVisible();
  await expect(page.getByTestId("mode-badge")).toContainText("Mock-ready");
  await page.getByRole("button", { name: "System design", exact: true }).click();
  await page.getByRole("button", { name: /Enter interview room/i }).click();

  await expect(page.getByText("Mock session")).toBeVisible();
  await expect(page.getByTestId("transcript")).toContainText("collaborative document editor");

  const answer = "I would define latency and availability targets, then use regional gateways with a durable event log.";
  await page.getByLabel("Your interview answer").fill(answer);
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByTestId("transcript")).toContainText(answer);
  await expect(page.getByTestId("transcript")).toContainText("consistency guarantees");

  await page.getByRole("tab", { name: "Architecture" }).click();
  await expect(page.getByTestId("architecture-canvas")).toBeVisible();
  await page.getByRole("button", { name: /Service/ }).click();
  await page.getByRole("button", { name: /Data store/ }).click();
  await expect(page.getByTestId("architecture-canvas").locator(".diagram-node")).toHaveCount(2);

  await page.getByRole("button", { name: /Inject scenario/i }).click();
  await expect(page.getByTestId("transcript")).toContainText("traffic jumps 10×");

  await page.getByRole("button", { name: /End & review/i }).click();
  await expect(page.getByRole("heading", { name: "Your interview snapshot" })).toBeVisible();
  await expect(page.getByTestId("scorecard")).toContainText("Technical depth");
  await expect(page.getByTestId("scorecard")).toContainText("canvas-final");
});
