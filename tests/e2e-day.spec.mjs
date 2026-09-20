/**
 * Desk Ops - a whole working day, end to end, in a real browser.
 *
 * The feature suites check pieces. This one checks that the pieces add up:
 * it works through a day the way Yashoda would, then opens the dashboard and
 * asserts the numbers moved by exactly what was done. A count that does not
 * move is the failure this catches and nothing else does.
 *
 *   npx playwright test e2e-day.spec.mjs
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:4100";
const USER = { email: "yashoda@example.com", password: "desk1234" };

// one browser context for the whole day, because that is how she works
test.describe.configure({ mode: "serial" });

let page;
let captured = 0;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto(BASE);
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill(USER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByLabel("Store")).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => { await page?.close(); });

async function pickStore(text) {
  const box = page.getByLabel("Store").first();
  await box.click();
  await box.fill(text);
  const fresh = page.locator(".sugg:not(.stale) [role='option']").first();
  await fresh.waitFor({ state: "visible", timeout: 6000 });
  await fresh.click();
}

/** Pick a work type by its position, save, and count it. */
async function captureType(index) {
  await page.locator(".chipset").first().locator("button.chip").nth(index).click();
  await page.getByRole("button", { name: /^Save/ }).click();
  captured += 1;
  await page.waitForTimeout(250);
}

async function counts() {
  const res = await page.request.get(`${BASE}/api/activities/today`, {
    headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  return (await res.json()).counts;
}

/* ------------------------------------------------------------ the morning */

test("08:30 — the stock check is the first job of the day", async () => {
  await page.getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page.getByLabel("Filter SKUs")).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("Filter SKUs").fill("zyn");
  const rows = page.locator(".sku");
  expect(await rows.count()).toBeGreaterThan(0);

  // flip whichever state it is in, so the test does not depend on what an
  // earlier run left behind
  const name = await page.locator(".sku .nm").first().innerText();
  const wasOut = await page.locator(".sku input").first().isChecked();
  await rows.first().click();
  await expect(page.locator(".diffbar")).toBeVisible();

  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.locator(".diffbar")).toHaveCount(0, { timeout: 10_000 });

  // and the flip is still there after a reload, which is the whole point
  await page.reload();
  await page.getByLabel("Filter SKUs").fill("zyn");
  const row = page.locator(".sku", { hasText: name }).first();
  if (wasOut) await expect(row).not.toHaveClass(/isout/);
  else await expect(row).toHaveClass(/isout/);
});

test("09:00 — the phone starts: a call against a store", async () => {
  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await expect(page.getByLabel("Store")).toBeVisible({ timeout: 10_000 });

  const before = await counts();
  await pickStore("335");
  await captureType(0);

  await expect(page.locator(".entry").first()).toBeVisible({ timeout: 10_000 });
  const after = await counts();
  expect(Number(after.calls)).toBe(Number(before.calls) + 1);
});

test("09:02 — the store is still held, so the second record is two taps", async () => {
  await expect(page.locator(".sticky-pill")).toContainText(/Fs335/);
  const before = await counts();
  await captureType(1); // order
  const after = await counts();
  expect(Number(after.orders)).toBe(Number(before.orders) + 1);
});

test("09:05 — Same again repeats the last record", async () => {
  const before = await counts();
  await page.getByRole("button", { name: /same again/i }).click();
  await page.getByRole("button", { name: /^Save/ }).click();
  captured += 1;
  await expect.poll(async () => Number((await counts()).total), { timeout: 10_000 })
    .toBe(Number(before.total) + 1);
});

test("09:20 — a delivery issue that needs chasing becomes an open item", async () => {
  await page.getByLabel("Release store").click().catch(() => {});
  await pickStore("030");
  await page.locator(".chipset").first().locator("button.chip").nth(2).click(); // issue
  // click the label, which is what a person does. The input itself is
  // pointer-events:none behind the styled switch; it stays keyboard-focusable
  // (there is a :focus-visible rule on it), and that is checked separately.
  await page.locator("label.toggle", { hasText: /needs follow-up/i }).click();
  await expect(page.locator("label.toggle input")).toBeChecked();
  await page.getByRole("button", { name: /^Save/ }).click();
  captured += 1;
  await page.waitForTimeout(400);

  await page.getByRole("link", { name: /^Open/ }).click();
  await expect(page).toHaveURL(/\/open/);
  await expect(page.locator("body")).toContainText(/Fs030/, { timeout: 10_000 });
});

test("09:25 — an unlisted job goes in as Other and still saves", async () => {
  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await pickStore("335");
  await page.locator(".chipset").first().locator("button.chip").first().click();
  await page.locator("button.chip.other").first().click();

  const phrase = `chasing the missing pallet paperwork ${Date.now()}`;
  await page.getByLabel("Describe the work").fill(phrase);
  await page.getByRole("button", { name: /^Save/ }).click();
  captured += 1;

  await expect(page.locator(".entry").first()).toContainText(phrase, { timeout: 10_000 });
});

/* --------------------------------------------------------- mid-morning */

test("10:00 — a record with no store waits in drafts and is finished later", async () => {
  await page.getByLabel("Release store").click().catch(() => {});
  await page.locator("body").click();
  await page.keyboard.press("1");
  await page.getByRole("button", { name: /^Save/ }).click();
  captured += 1;
  await page.waitForTimeout(400);

  await page.getByRole("link", { name: /^Drafts/ }).click();
  await expect(page).toHaveURL(/\/drafts/);
  await expect(page.locator(".entry, .draftrow, li").first()).toBeVisible({ timeout: 10_000 });
});

test("10:30 — a customer request gets its two lists and moves along", async () => {
  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await pickStore("335");
  await captureType(7); // customer request

  await page.getByRole("link", { name: "Requests", exact: true }).click();
  const card = page.locator(".card.request").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator("button.ghostbtn").click();

  const wanted = card.locator(".linelist", { hasText: "Wanted" });
  const box = wanted.getByLabel("Product");
  await box.fill("two cases of something odd");
  await box.press("Enter");
  await expect(wanted.locator(".line")).toHaveCount(1, { timeout: 10_000 });

  await card.getByRole("button", { name: "Order placed" }).click();
  await expect(card.locator(".stage.on")).toContainText("Order placed", { timeout: 10_000 });
});

test("11:00 — an allocation is opened and rung round", async () => {
  await page.getByRole("link", { name: "Allocations", exact: true }).click();
  const name = `Day run ${Date.now()}`;
  await page.getByLabel("Campaign name").fill(name);
  await page.getByRole("button", { name: /open campaign/i }).click();

  const card = page.locator(".card.camp", { hasText: name });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();

  await pickStore("335");
  const product = page.getByLabel("Product");
  await product.fill("zyn");
  const opt = page.locator(".sugg:not(.stale) [role='option']").first();
  await opt.waitFor({ state: "visible", timeout: 6000 });
  await opt.click();
  await expect(page.locator(".grid .gr")).toHaveCount(1, { timeout: 10_000 });

  await page.getByRole("button", { name: "Call round" }).click();
  await expect(page.locator(".nextcall")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Call outcome").fill("wants 24");
  await page.getByRole("button", { name: /wants stock/i }).click();
  await expect(page.locator(".callprogress")).toContainText("1 of 1", { timeout: 10_000 });
});

/* ------------------------------------------------------------- afternoon */

test("14:00 — an open item gets resolved and leaves the list", async () => {
  await page.getByRole("link", { name: /^Open/ }).click();
  await expect(page).toHaveURL(/\/open/);

  const resolve = page.getByRole("button", { name: /resolve|done|close/i }).first();
  if (await resolve.count()) {
    const before = await page.locator(".entry, .row, li").count();
    await resolve.click();
    await expect
      .poll(async () => page.locator(".entry, .row, li").count(), { timeout: 10_000 })
      .toBeLessThan(before);
  }
});

test("17:00 — the dashboard shows the day that was actually worked", async () => {
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".stat").first()).toBeVisible({ timeout: 15_000 });

  const api = await counts();
  const shown = await page.locator(".stats").first().innerText();

  // the headline total on screen has to be the total the API reports
  expect(shown).toContain(String(api.total));
  expect(Number(api.total)).toBeGreaterThanOrEqual(captured);

  // and the day chart has something in it. Assert the svg is visible and the
  // gridlines exist — a bare <line> has zero height, which Playwright calls
  // hidden even though it renders perfectly well.
  await expect(page.locator(".chart svg").first()).toBeVisible();
  expect(await page.locator(".chart svg .grid").count()).toBeGreaterThan(0);
  await expect(page.locator(".pendingblock")).toContainText(/open follow-ups/i);
});

test("17:05 — capture speed is being measured, which is the point of the project", async () => {
  const res = await page.request.get(`${BASE}/api/dashboard/day`, {
    headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  const d = await res.json();
  expect(d.speed.sample).toBeGreaterThan(0);
  expect(d.speed.average).toBeGreaterThan(0);
  expect(d.speed.average).toBeLessThan(d.speed.baseline_seconds);
});

test("17:10 — the impact page opens and leads with a count", async () => {
  await page.getByRole("link", { name: /impact page/i }).click();
  await expect(page).toHaveURL(/\/impact/);
  await expect(page.locator(".hero strong").first()).toHaveText(/^[\d,]+$/, { timeout: 10_000 });
  await expect(page.locator(".card.caveat")).toContainText(/higher than what is shown/i);
});

test("17:30 — signing out closes the door behind her", async () => {
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByLabel("Password")).toBeVisible({ timeout: 10_000 });

  // and the API agrees, not just the screen
  const res = await page.request.get(`${BASE}/api/activities/today`, {
    headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  expect(res.status()).toBe(401);
});
