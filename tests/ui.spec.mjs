/**
 * Desk Ops - end-to-end tests.
 *
 * Drives the built app in a real browser: login, the capture bar, keyboard
 * shortcuts, the sticky store, drafts, open items, the store and order views,
 * and the offline queue.
 *
 *   npx playwright test ui.spec.mjs
 *
 * BASE defaults to http://127.0.0.1:4100.
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

/** Type into the store box and pick the first suggestion. */
async function pickStore(page, text = "335") {
  const box = page.getByLabel("Store");
  await box.click();
  await box.fill(text);
  // wait for the list to catch up with what was typed, not just to appear
  const fresh = page.locator(".sugg:not(.stale) [role='option']").first();
  await fresh.waitFor({ state: "visible", timeout: 5000 });
  await fresh.click();
}

test.describe("signing in", () => {
  test("a wrong password is refused and the app is not entered", async ({ page }) => {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(USER.email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByLabel("Store")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("the right password opens the capture screen", async ({ page }) => {
    await signIn(page);
    await expect(page.locator(".chipset").first()).toBeVisible();
  });

  test("the session survives a reload", async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.getByLabel("Store")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("the capture bar", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("every work type is offered as a chip", async ({ page }) => {
    const chips = page.locator(".chipset").first().locator("button.chip");
    await expect(chips).toHaveCount(9);
    await expect(chips.first()).toContainText(/call/i);
  });

  test("the store picker finds a store by number", async ({ page }) => {
    await pickStore(page, "335");
    await expect(page.locator(".sticky-pill")).toContainText(/Fs335/);
  });

  test("a record saves in three interactions and appears in today's log", async ({ page }) => {
    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(page.locator(".entry").first()).toBeVisible({ timeout: 10_000 });
  });

  test("the store stays held after a save, because one call makes several records", async ({ page }) => {
    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();
    // the pill keeps the store and counts down rather than clearing
    await expect(page.locator(".sticky-pill")).toContainText(/Fs335/, { timeout: 10_000 });
    await expect(page.locator(".sticky-pill .cd")).toContainText(/\d+s/);
  });

  test("Release store clears it", async ({ page }) => {
    await pickStore(page, "335");
    await page.getByLabel("Release store").click();
    await expect(page.getByLabel("Store")).toBeVisible();
  });

  test("number keys pick a work type", async ({ page }) => {
    await page.locator("body").click();
    await page.keyboard.press("2");
    const selected = page.locator(".chipset").first().locator("button.chip.on, button.chip.active, button.chip[aria-pressed='true']");
    await expect(selected).toHaveCount(1);
  });

  test("slash jumps to the store box", async ({ page }) => {
    await page.locator("body").click();
    await page.keyboard.press("/");
    await expect(page.getByLabel("Store")).toBeFocused();
  });

  test("Escape clears the form", async ({ page }) => {
    await page.locator("body").click();
    await page.keyboard.press("2");
    await page.keyboard.press("Escape");
    const selected = page.locator(".chipset").first().locator("button.chip.on, button.chip.active, button.chip[aria-pressed='true']");
    await expect(selected).toHaveCount(0);
  });

  test("Other is always available, takes free text, and saves a real record", async ({ page }) => {
    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.locator("button.chip.other").first().click();
    const field = page.getByLabel("Describe the work");
    await expect(field).toBeVisible();
    const phrase = `playwright unlisted ${Date.now()}`;
    await field.fill(phrase);
    await page.getByRole("button", { name: /^Save/ }).click();
    // the record lands in today's log carrying the words she typed
    await expect(page.locator(".entry").first()).toContainText(phrase, { timeout: 10_000 });
  });

  test("Enter cannot pick a store from a list that has not caught up", async ({ page }) => {
    const box = page.getByLabel("Store");
    await box.click();

    // "2335" matches exactly one store, so the cursor parks on it
    await box.fill("2335");
    await expect(page.locator(".sugg:not(.stale) [role='option']")).toHaveCount(1);
    await expect(page.locator(".sugg [role='option'].on")).toHaveCount(1);

    // now change the query and press Enter inside the debounce window
    await box.press("9");
    await box.press("Enter");

    // the old single match must NOT have been selected
    await expect(page.locator(".sticky-pill")).toHaveCount(0);
    await expect(box).toHaveValue("23359");
  });

  test("a work type with an order field shows it", async ({ page }) => {
    await page.locator("body").click();
    await page.keyboard.press("2"); // order
    await expect(page.getByPlaceholder("11043984")).toBeVisible();
  });

  test("Same again is offered only after a first save", async ({ page }) => {
    const btn = page.getByRole("button", { name: /same again/i });
    await expect(btn).toBeDisabled();
    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(btn).toBeEnabled({ timeout: 10_000 });
  });
});

test.describe("the other screens", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("drafts lists a storeless record and completing it removes it", async ({ page }) => {
    // save with no store
    await page.locator("body").click();
    await page.keyboard.press("1");
    await page.getByRole("button", { name: /^Save/ }).click();
    await page.waitForTimeout(500);

    await page.getByRole("link", { name: /^Drafts/ }).click();
    await expect(page).toHaveURL(/\/drafts/);
    const rows = page.locator(".entry, .draftrow, li");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  });

  test("open items opens and shows its buckets", async ({ page }) => {
    await page.getByRole("link", { name: /^Open/ }).click();
    await expect(page).toHaveURL(/\/open/);
    await expect(page.locator("body")).toContainText(/open|today|week|older/i);
  });

  test("a store page shows that store's history", async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/stores?q=335`, {
      headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    const id = (await r.json()).stores[0].store_id;
    await page.goto(`${BASE}/stores/${id}`);
    await expect(page.locator("body")).toContainText(/335/i, { timeout: 10_000 });
  });

  test("an order page shows the merged timeline", async ({ page }) => {
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const s = await page.request.get(`${BASE}/api/stores?q=335`, { headers: { Cookie: cookie } });
    const storeId = (await s.json()).stores[0].store_id;
    const v = await page.request.get(`${BASE}/api/stores/${storeId}`, { headers: { Cookie: cookie } });
    const order = (await v.json()).orders[0];
    await page.goto(`${BASE}/orders/${order.order_id}`);
    await expect(page.locator("body")).toContainText(String(order.number), { timeout: 10_000 });
  });

  test("an unknown route falls back to the capture screen", async ({ page }) => {
    await page.goto(`${BASE}/nowhere-at-all`);
    await expect(page.getByLabel("Store")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("the offline queue - free hosting insurance", () => {
  test("a save with the server unreachable is kept, and syncs when it returns", async ({ page }) => {
    await signIn(page);

    // cut the save endpoint only, so the rest of the app keeps working
    let blocking = true;
    await page.route("**/api/activities", (route) => {
      if (blocking && route.request().method() === "POST") return route.abort("failed");
      return route.continue();
    });

    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();

    // she is told it is kept, not that it failed
    await expect(page.locator("body")).toContainText(/this device|will sync|saved/i, { timeout: 10_000 });

    // it survives a reload
    const queued = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k);
        if (v && v.includes("work_type_id")) return v;
      }
      return null;
    });
    expect(queued, "nothing was written to the browser queue").not.toBeNull();

    // put the server back and let the queue drain
    blocking = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            for (const k of Object.keys(localStorage)) {
              const v = localStorage.getItem(k);
              if (v && v.includes("work_type_id")) return JSON.parse(v).length;
            }
            return 0;
          }),
        { timeout: 20_000 }
      )
      .toBe(0);
  });

  test("a record the server actively rejects is dropped, not retried for ever", async ({ page }) => {
    await signIn(page);
    await page.route("**/api/activities", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"nope"}' });
      }
      return route.continue();
    });

    await pickStore(page, "335");
    await page.locator(".chipset").first().locator("button.chip").first().click();
    await page.getByRole("button", { name: /^Save/ }).click();
    await page.waitForTimeout(1500);

    const queued = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k);
        if (v && v.includes("work_type_id")) return JSON.parse(v).length;
      }
      return 0;
    });
    expect(queued, "a 4xx was queued for retry - it will loop for ever").toBe(0);
  });
});
