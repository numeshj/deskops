/**
 * Desk Ops - Phase 3 browser tests: the dashboard and the impact page.
 *
 *   npx playwright test phase3-ui.spec.mjs
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:4100";
const USER = { email: "yashoda@example.com", password: "desk1234" };

async function signIn(page) {
  await page.goto(BASE);
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill(USER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByLabel("Store")).toBeVisible({ timeout: 10_000 });
}

test.describe("the dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("opens on the day and shows the headline figures", async ({ page }) => {
    await expect(page.locator(".stat").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".stats").first()).toContainText(/calls/i);
    expect(await page.locator(".stat").count()).toBeGreaterThan(4);
  });

  test("all three periods load and the date range changes with them", async ({ page }) => {
    const ranges = [];
    for (const p of ["Day", "Week", "Month"]) {
      const before = await page.locator(".pagehead .sub").innerText();
      await page.getByRole("button", { name: p, exact: true }).click();
      // wait for the new payload, not just for a .stat that was already there
      await expect
        .poll(async () => page.locator(".pagehead .sub").innerText(), { timeout: 10_000 })
        .not.toBe(before);
      ranges.push(await page.locator(".pagehead .sub").innerText());
    }
    expect(new Set(ranges).size).toBe(3);
  });

  test("charts render as real SVG with gridlines, not blank boxes", async ({ page }) => {
    await expect(page.locator(".chart svg").first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator(".chart svg .grid").count()).toBeGreaterThan(0);
  });

  test("every figure offers a table view, which is the relief the palette needs", async ({ page }) => {
    const fig = page.locator(".fig", { has: page.locator(".toggle-view") }).first();
    await fig.getByRole("button", { name: "Table" }).click();
    await expect(fig.locator("table")).toBeVisible();
    await expect(fig.locator("th").first()).toBeVisible();
  });

  test("hovering a bar shows its value", async ({ page }) => {
    const svg = page.locator(".chart svg").first();
    await svg.hover({ position: { x: 40, y: 40 } });
    await expect(page.locator(".chart .tip").first()).toBeVisible({ timeout: 5000 });
  });

  test("the week view labels a legend for its three series", async ({ page }) => {
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.locator(".chart .legend").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".chart .legend").first()).toContainText("Calls");
    await expect(page.locator(".chart .legend").first()).toContainText("Issues");
  });

  test("the week view says plainly that carrier counts are not rates", async ({ page }) => {
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.locator(".fignote")).toContainText(/not (a )?rate/i, { timeout: 10_000 });
  });

  test("the month view draws a trend line with end markers", async ({ page }) => {
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(page.locator(".chart.lines svg path").first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator(".chart.lines svg circle").count()).toBeGreaterThan(0);
  });

  test("what is still waiting is shown on every period", async ({ page }) => {
    for (const p of ["Day", "Week", "Month"]) {
      await page.getByRole("button", { name: p, exact: true }).click();
      await expect(page.locator(".pendingblock")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".pendingblock")).toContainText(/open follow-ups/i);
    }
  });

  test("the impact page is one click away", async ({ page }) => {
    await page.getByRole("link", { name: /impact page/i }).click();
    await expect(page).toHaveURL(/\/impact/);
  });
});

test.describe("the impact page", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/impact`);
    await expect(page.locator(".hero strong").first()).toBeVisible({ timeout: 10_000 });
  });

  test("leads with a countable volume, not a percentage", async ({ page }) => {
    const hero = await page.locator(".hero strong").first().innerText();
    expect(hero).toMatch(/^[\d,]+$/);
    await expect(page.locator(".hero span").first()).toContainText(/pieces of work/i);
  });

  test("never shows a full-time-equivalent figure", async ({ page }) => {
    await expect(page.locator("body")).not.toContainText(/full.time equivalent/i);
    await expect(page.locator("body")).not.toContainText(/FTE/);
  });

  test("labels the hours as a floor rather than a measurement", async ({ page }) => {
    await expect(page.locator(".basis")).toContainText(/floor, not an estimate/i);
  });

  test("the assumptions can be opened and changed, and the total moves", async ({ page }) => {
    const before = await page.locator(".card.hours .hero strong").innerText();
    await page.getByRole("button", { name: /show and change the assumptions/i }).click();

    const callMins = page.getByLabel(/minutes per call/i);
    await expect(callMins).toBeVisible();
    await callMins.fill("20");
    await callMins.blur();

    await expect
      .poll(async () => page.locator(".card.hours .hero strong").innerText(), { timeout: 10_000 })
      .not.toBe(before);
  });

  test("states the coverage gap instead of hiding it", async ({ page }) => {
    await expect(page.locator(".card.caveat")).toBeVisible();
    await expect(page.locator(".card.caveat")).toContainText(/higher than what is shown/i);
    await expect(page.locator(".card.caveat")).toContainText(/records with a store code/i);
  });

  test("shows the quality of the work, not only the quantity", async ({ page }) => {
    await expect(page.locator("body")).toContainText(/delivery issues resolved/i);
  });

  test("its charts have table views too", async ({ page }) => {
    const fig = page.locator(".fig", { has: page.locator(".toggle-view") }).first();
    await fig.getByRole("button", { name: "Table" }).click();
    await expect(fig.locator("table")).toBeVisible();
  });
});
