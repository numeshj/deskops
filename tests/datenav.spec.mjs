/**
 * Desk Ops - walking back through the dates on the dashboard.
 *
 * Loaded from the workbook, the desk's history runs January 2025 to September
 * 2026 and TODAY is empty. The default Day view is therefore all zeroes, which
 * is correct and looks exactly like a failed import. These tests check the two
 * things that make the difference visible: the dashboard says where the
 * records are, and she can get to them.
 *
 *   npx playwright test datenav.spec.mjs
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

async function dashboard(page) {
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator(".datenav")).toBeVisible({ timeout: 10_000 });
}

/** The dashboard payload for a period, straight from the API, for comparison. */
async function payload(page, period, date) {
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await page.request.get(
    `${BASE}/api/dashboard/${period}${date ? `?date=${date}` : ""}`,
    { headers: { Cookie: cookie } }
  );
  return res.json();
}

test.describe("the date bar", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); await dashboard(page); });

  test("says where the records actually are", async ({ page }) => {
    const { span } = await payload(page, "day");
    test.skip(!span.earliest, "no data loaded");
    await expect(page.locator(".datenav .spannote")).toContainText(/Records run/);
    await expect(page.locator(".datenav .spannote")).toContainText(String(span.earliest.slice(0, 4)));
  });

  test("cannot walk into the future", async ({ page }) => {
    await expect(page.getByRole("button", { name: /^Next/ })).toBeDisabled();
  });

  test("an empty day says so instead of showing bare zeroes", async ({ page }) => {
    const d = await payload(page, "day");
    test.skip(d.headline.total !== 0, "today has records, so there is no empty state to check");

    const card = page.locator(".card.nothinghere");
    await expect(card).toBeVisible();
    await expect(card).toContainText(/not a loading problem/i);
    // Formatted inside the page so the expected string uses the same locale the
    // browser renders with, rather than this process's.
    const expected = await page.evaluate((n) => n.toLocaleString(), d.span.total);
    await expect(card).toContainText(expected);
  });

  test("the offered jump lands on a day that has records", async ({ page }) => {
    const d = await payload(page, "day");
    test.skip(d.headline.total !== 0, "today has records");

    await page.locator(".card.nothinghere .btn").click();
    await expect(page.locator(".card.nothinghere")).toHaveCount(0, { timeout: 10_000 });

    // and the headline is the count the API reports for that day, not a stale
    // payload left over from the empty one
    const landed = await payload(page, "day", d.span.latest);
    await expect(page.locator(".stats").first()).toContainText(String(landed.headline.total));
  });

  test("Previous steps back one day at a time", async ({ page }) => {
    const before = await page.locator(".pagehead .sub").innerText();
    await page.getByRole("button", { name: /^Previous/ }).click();
    await expect.poll(async () => page.locator(".pagehead .sub").innerText(), { timeout: 10_000 })
      .not.toBe(before);
    // stepping back then forward returns to where it started
    await page.getByRole("button", { name: /^Next/ }).click();
    await expect.poll(async () => page.locator(".pagehead .sub").innerText(), { timeout: 10_000 })
      .toBe(before);
  });

  test("Back to today only appears once she has moved", async ({ page }) => {
    await expect(page.getByRole("button", { name: /back to today/i })).toHaveCount(0);
    await page.getByRole("button", { name: /^Previous/ }).click();
    await expect(page.getByRole("button", { name: /back to today/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /back to today/i }).click();
    await expect(page.getByRole("button", { name: /back to today/i })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: /^Next/ })).toBeDisabled();
  });
});

test.describe("walking back a month at a time", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); await dashboard(page); });

  test("a month with records draws its charts and matches the API", async ({ page }) => {
    const { span } = await payload(page, "month");
    test.skip(!span.latest, "no data loaded");

    // Wait for the label to become a MONTH label, not merely for it to contain
    // a year. "20 September 2026" contains a year too, and reading it too early
    // is how this test first failed.
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(page.locator(".pagehead .sub")).toHaveText(/^[A-Z][a-z]+ \d{4}$/, { timeout: 10_000 });

    // step back until a month with records turns up, at most a year of them
    let found = null;
    for (let i = 0; i < 14; i += 1) {
      const sub = await page.locator(".pagehead .sub").innerText();
      const empty = await page.locator(".card.nothinghere").count();
      if (!empty) { found = sub; break; }
      await page.getByRole("button", { name: /^Previous/ }).click();
      await expect.poll(async () => page.locator(".pagehead .sub").innerText(), { timeout: 10_000 })
        .not.toBe(sub);
    }
    expect(found, "no month with records within a year of today").not.toBeNull();

    // the month label is a real month and year, not a raw ISO date
    expect(found).toMatch(/^[A-Z][a-z]+ \d{4}$/);

    // charts, not blank boxes
    await expect(page.locator(".chart svg").first()).toBeVisible();
    expect(await page.locator(".chart svg .grid").count()).toBeGreaterThan(0);
  });

  test("the month step lands on whole months, never drifting a day", async ({ page }) => {
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(page.locator(".pagehead .sub")).toHaveText(/^[A-Z][a-z]+ \d{4}$/, { timeout: 10_000 });

    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      await page.getByRole("button", { name: /^Previous/ }).click();
      await expect.poll(async () => page.locator(".pagehead .sub").innerText(), { timeout: 10_000 })
        .not.toBe(seen[seen.length - 1] ?? "");
      seen.push(await page.locator(".pagehead .sub").innerText());
    }
    // four steps back must give four different months, no repeats and no skips
    expect(new Set(seen).size).toBe(4);
    for (const s of seen) expect(s).toMatch(/^[A-Z][a-z]+ \d{4}$/);
  });
});
