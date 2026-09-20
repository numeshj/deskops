/**
 * Desk Ops - Phase 2 browser tests.
 *
 * The daily stock check, customer requests and allocation campaigns, driven in
 * a real browser the way she would use them.
 *
 *   npx playwright test phase2-ui.spec.mjs
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

async function pickStore(page, text = "335") {
  const box = page.getByLabel("Store").first();
  await box.click();
  await box.fill(text);
  const fresh = page.locator(".sugg:not(.stale) [role='option']").first();
  await fresh.waitFor({ state: "visible", timeout: 5000 });
  await fresh.click();
}

test.describe("navigation", () => {
  test("every Phase 2 screen is reachable from the nav", async ({ page }) => {
    await signIn(page);
    for (const [name, url] of [["Stock", /\/stock/], ["Requests", /\/requests/], ["Allocations", /\/allocations/]]) {
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(url);
    }
  });
});

test.describe("daily stock check", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Stock", exact: true }).click();
    await expect(page.getByLabel("Filter SKUs")).toBeVisible({ timeout: 10_000 });
  });

  test("the whole catalogue is on screen, grouped by brand", async ({ page }) => {
    await expect(page.locator(".card.group").first()).toBeVisible();
    const skus = page.locator(".sku");
    expect(await skus.count()).toBeGreaterThan(200);
  });

  test("the filter takes focus so she can narrow it without the mouse", async ({ page }) => {
    await expect(page.getByLabel("Filter SKUs")).toBeFocused();
  });

  test("filtering narrows the list", async ({ page }) => {
    const before = await page.locator(".sku").count();
    await page.getByLabel("Filter SKUs").fill("zyn");
    await expect.poll(async () => page.locator(".sku").count()).toBeLessThan(before);
    expect(await page.locator(".sku").count()).toBeGreaterThan(0);
  });

  test("a filter matching nothing says so rather than showing a blank page", async ({ page }) => {
    await page.getByLabel("Filter SKUs").fill("zzzznothinghere");
    await expect(page.locator(".empty")).toBeVisible();
  });

  test("ticking a SKU shows it in the change summary before saving", async ({ page }) => {
    await page.getByLabel("Filter SKUs").fill("zyn");
    const first = page.locator(".sku").first();
    await first.click();
    await expect(page.locator(".diffbar")).toBeVisible();
    await expect(page.getByRole("button", { name: /Save \d+ change/ })).toBeVisible();
  });

  test("saving persists across a reload", async ({ page }) => {
    await page.getByLabel("Filter SKUs").fill("zyn");
    const label = await page.locator(".sku .nm").first().innerText();
    await page.locator(".sku").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(page.locator(".diffbar")).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await page.getByLabel("Filter SKUs").fill("zyn");
    const row = page.locator(".sku", { hasText: label }).first();
    await expect(row).toHaveClass(/isout/);
  });

  test("a group can be collapsed", async ({ page }) => {
    const group = page.locator(".card.group").first();
    const toggle = group.locator("button.ghostbtn");
    await toggle.click();
    await expect(group.locator(".sku")).toHaveCount(0);
    await toggle.click();
    expect(await group.locator(".sku").count()).toBeGreaterThan(0);
  });
});

test.describe("customer requests", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("a request saved from capture appears on the requests screen", async ({ page }) => {
    await pickStore(page, "335");
    // "Customer request" is the 8th work type
    await page.locator(".chipset").first().locator("button.chip").nth(7).click();
    await page.getByRole("button", { name: /^Save/ }).click();
    await page.waitForTimeout(600);

    await page.getByRole("link", { name: "Requests", exact: true }).click();
    await expect(page.locator(".card.request").first()).toBeVisible({ timeout: 10_000 });
  });

  test("items can be added to both lists and are counted separately", async ({ page }) => {
    await page.goto(`${BASE}/requests`);
    const card = page.locator(".card.request").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator("button.ghostbtn").click();

    const wanted = card.locator(".linelist", { hasText: "Wanted" });
    const box = wanted.getByLabel("Product");
    await box.fill("a box of something odd");
    await box.press("Enter");

    await expect(wanted.locator(".line")).toHaveCount(1, { timeout: 10_000 });
    await expect(wanted.locator(".line .tag")).toContainText(/free text/);
  });

  test("the stage can be moved and it sticks across a reload", async ({ page }) => {
    await page.goto(`${BASE}/requests`);
    const card = page.locator(".card.request").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole("button", { name: "Order placed" }).click();
    await expect(card.locator(".stage.on")).toContainText("Order placed", { timeout: 10_000 });

    await page.reload();
    await expect(page.locator(".card.request").first().locator(".stage.on"))
      .toContainText("Order placed", { timeout: 10_000 });
  });

  test("finishing a request takes it out of the open list", async ({ page }) => {
    await page.goto(`${BASE}/requests`);
    const card = page.locator(".card.request").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const before = await page.locator(".card.request").count();
    await card.getByRole("button", { name: "Restocked" }).click();
    await expect.poll(async () => page.locator(".card.request").count(), { timeout: 10_000 })
      .toBeLessThan(before);
  });
});

test.describe("allocation campaigns", () => {
  const name = `Playwright allocation ${Date.now()}`;

  test("a campaign can be opened, filled and worked through", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Allocations", exact: true }).click();

    // open it
    await page.getByLabel("Campaign name").fill(name);
    await page.getByLabel("Brand").fill("Hayati");
    await page.getByRole("button", { name: /open campaign/i }).click();
    const card = page.locator(".card.camp", { hasText: name });
    await expect(card).toBeVisible({ timeout: 10_000 });

    // open it and add a store x SKU line
    await card.click();
    await expect(page.getByText("Call round")).toBeVisible({ timeout: 10_000 });
    await pickStore(page, "335");
    const product = page.getByLabel("Product");
    await product.fill("zyn");
    const opt = page.locator(".sugg:not(.stale) [role='option']").first();
    await opt.waitFor({ state: "visible", timeout: 5000 });
    await opt.click();

    await expect(page.locator(".grid .gr")).toHaveCount(1, { timeout: 10_000 });

    // record quantities
    await page.getByLabel("Units asked for").fill("12");
    await page.getByLabel("Units asked for").blur();
    await expect.poll(async () => page.locator(".counter", { hasText: "units asked for" }).innerText(), {
      timeout: 10_000,
    }).toContain("12");

    // the Booker flag toggles
    const flags = page.locator(".grid .gr .flag");
    await flags.first().click();
    await expect(flags.first()).toHaveClass(/on/, { timeout: 10_000 });
  });

  test("the call round offers the next store with its number", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/allocations`);
    await page.locator(".card.camp", { hasText: name }).click();
    await page.getByRole("button", { name: "Call round" }).click();

    await expect(page.locator(".nextcall")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".nextcall .code.big")).toContainText(/Fs/);

    await page.getByLabel("Call outcome").fill("wants 12");
    await page.getByRole("button", { name: /wants stock/i }).click();

    await expect(page.locator(".callprogress")).toContainText("1 of 1", { timeout: 10_000 });
    await expect(page.locator(".empty")).toContainText(/everyone .* has been called/i);
  });

  test("a campaign can be closed and shows as closed in the list", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/allocations`);
    await page.locator(".card.camp", { hasText: name }).click();
    await page.getByRole("button", { name: /close campaign/i }).click();
    await expect(page.locator(".pagehead .sub")).toContainText(/closed/, { timeout: 10_000 });

    await page.goto(`${BASE}/allocations`);
    await expect(page.locator(".card.camp.closed", { hasText: name })).toBeVisible();
  });
});
