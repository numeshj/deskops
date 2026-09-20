/**
 * Desk Ops - Phase 2 API tests.
 *
 * Daily stock check, customer requests with line items, photo attachments,
 * allocation campaigns and the call round.
 *
 *   node --test tests/phase2.test.mjs
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://127.0.0.1:4100";
let token = null;

async function call(method, path, { body, raw, type } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? { "Content-Type": type } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary or empty */ }
  return { status: res.status, json, buf, headers: res.headers };
}

const get = (p) => call("GET", p);
const post = (p, body) => call("POST", p, { body });
const patch = (p, body) => call("PATCH", p, { body });
const del = (p) => call("DELETE", p);

/** A 1x1 PNG - the smallest real image there is. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

before(async () => {
  const u = await post("/api/auth/login", { email: "yashoda@example.com", password: "desk1234" });
  assert.equal(u.status, 200, `login failed: ${u.buf.toString()}`);
  token = u.json.token;
});

/* ------------------------------------------------------------------ stock */

describe("daily stock check", () => {
  test("opens with every SKU grouped by brand", async () => {
    const r = await get("/api/stock/today");
    assert.equal(r.status, 200);
    assert.ok(r.json.groups.length > 1, "SKUs are not grouped");
    const skus = r.json.groups.flatMap((g) => g.items);
    assert.equal(skus.length, r.json.totals.skus);
    assert.ok(skus.length > 200, `expected the full catalogue, got ${skus.length}`);
    assert.match(r.json.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("every SKU carries the fields the screen needs", async () => {
    const r = await get("/api/stock/today");
    const one = r.json.groups[0].items[0];
    for (const k of ["product_id", "description", "out", "was_out", "days_out"]) {
      assert.ok(k in one, `missing ${k}`);
    }
    assert.equal(typeof one.out, "boolean");
    assert.equal(typeof one.days_out, "number");
  });

  test("saving records only the SKUs that are out", async () => {
    const r = await get("/api/stock/today");
    const skus = r.json.groups.flatMap((g) => g.items);
    const three = skus.slice(0, 3).map((s) => s.product_id);

    const saved = await post("/api/stock", { out: three });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.out, 3);

    const after = await get("/api/stock/today");
    const nowOut = after.json.groups.flatMap((g) => g.items).filter((i) => i.out).map((i) => i.product_id);
    assert.deepEqual(nowOut.sort(), [...three].sort());
  });

  test("saving the same list twice changes nothing the second time", async () => {
    const r = await get("/api/stock/today");
    const out = r.json.groups.flatMap((g) => g.items).filter((i) => i.out).map((i) => i.product_id);
    const again = await post("/api/stock", { out });
    assert.equal(again.json.added, 0);
    assert.equal(again.json.removed, 0);
  });

  test("un-ticking a SKU removes it rather than leaving a stale row", async () => {
    const before = await get("/api/stock/today");
    const out = before.json.groups.flatMap((g) => g.items).filter((i) => i.out).map((i) => i.product_id);
    assert.ok(out.length >= 2, "need at least two out to test removal");

    const keep = out.slice(1);
    const saved = await post("/api/stock", { out: keep });
    assert.equal(saved.json.removed, 1);

    const after = await get("/api/stock/today");
    const nowOut = after.json.groups.flatMap((g) => g.items).filter((i) => i.out).map((i) => i.product_id);
    assert.equal(nowOut.includes(out[0]), false);
  });

  test("an empty list is a valid answer - everything is back in stock", async () => {
    const saved = await post("/api/stock", { out: [] });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.out, 0);
  });

  test("a product id that does not exist is ignored, not an error", async () => {
    const saved = await post("/api/stock", { out: ["0000000000000000"] });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.out, 0);
    assert.equal(saved.json.ignored, 1);
  });

  test("a save with no list at all is refused", async () => {
    const r = await post("/api/stock", {});
    assert.equal(r.status, 400);
  });

  test("days out counts consecutive checks, not calendar days", async () => {
    const r = await get("/api/stock/today");
    const skus = r.json.groups.flatMap((g) => g.items);
    const target = skus[0].product_id;

    // three checks in a row on three different dates
    await post("/api/stock", { out: [target], date: "2026-03-01" });
    await post("/api/stock", { out: [target], date: "2026-03-02" });
    await post("/api/stock", { out: [target], date: "2026-03-03" });

    const on = await get("/api/stock/today?date=2026-03-03");
    const found = on.json.groups.flatMap((g) => g.items).find((i) => i.product_id === target);
    assert.equal(found.days_out, 3, "a SKU out for three checks should read 3");
  });

  test("the persistent list ranks the longest-running problems first", async () => {
    const r = await get("/api/stock/persistent");
    assert.equal(r.status, 200);
    const days = r.json.items.map((i) => Number(i.days));
    assert.deepEqual(days, [...days].sort((a, b) => b - a));
  });
});

/* --------------------------------------------------------------- requests */

describe("customer requests", () => {
  let requestId;
  let storeId;

  before(async () => {
    const s = await get("/api/stores?q=335");
    storeId = s.json.stores[0].store_id;
    const made = await post("/api/activities", {
      work_type_id: "request",
      store_id: storeId,
      note: "phase 2 test request",
    });
    assert.equal(made.status, 201);
    requestId = made.json.activity.activity_id;
  });

  test("a new request appears in the list at the first stage", async () => {
    const r = await get("/api/requests");
    assert.equal(r.status, 200);
    const mine = r.json.requests.find((x) => x.activity_id === requestId);
    assert.ok(mine, "the request is not in the list");
    assert.equal(mine.stage, "logged");
    assert.deepEqual(r.json.stages, ["logged", "items_received", "order_placed", "restocked"]);
  });

  test("a line can name a real product", async () => {
    const p = await get("/api/products?q=zyn");
    assert.ok(p.json.products.length > 0, "no products matched");
    const line = await post(`/api/requests/${requestId}/lines`, {
      direction: "requested",
      product_id: p.json.products[0].product_id,
      qty: 4,
    });
    assert.equal(line.status, 201);

    const one = await get(`/api/requests/${requestId}`);
    const added = one.json.request.lines.find((l) => l.line_id === line.json.line_id);
    assert.equal(added.qty, 4);
    assert.equal(added.description, p.json.products[0].description);
  });

  test("a line can be pure free text, because stores ask for things not in the catalogue", async () => {
    const line = await post(`/api/requests/${requestId}/lines`, {
      direction: "returned",
      description: "two boxes of something with no barcode",
      qty: 2,
    });
    assert.equal(line.status, 201);
    const one = await get(`/api/requests/${requestId}`);
    const added = one.json.request.lines.find((l) => l.line_id === line.json.line_id);
    assert.equal(added.product_id, null);
    assert.equal(added.direction, "returned");
  });

  test("the two directions are counted separately", async () => {
    const one = await get(`/api/requests/${requestId}`);
    assert.equal(one.json.request.requested, 1);
    assert.equal(one.json.request.returned, 1);
  });

  test("a line with neither product nor description is refused", async () => {
    const r = await post(`/api/requests/${requestId}/lines`, { direction: "requested" });
    assert.equal(r.status, 400);
  });

  test("a negative quantity is refused", async () => {
    const r = await post(`/api/requests/${requestId}/lines`, { description: "x", qty: -3 });
    assert.equal(r.status, 400);
  });

  test("a quantity can be corrected", async () => {
    const one = await get(`/api/requests/${requestId}`);
    const line = one.json.request.lines[0];
    const u = await patch(`/api/requests/${requestId}/lines/${line.line_id}`, { qty: 9 });
    assert.equal(u.status, 200);
    const after = await get(`/api/requests/${requestId}`);
    assert.equal(after.json.request.lines.find((l) => l.line_id === line.line_id).qty, 9);
  });

  test("a line can be removed", async () => {
    const line = await post(`/api/requests/${requestId}/lines`, { description: "remove me" });
    const d = await del(`/api/requests/${requestId}/lines/${line.json.line_id}`);
    assert.equal(d.status, 200);
    const after = await get(`/api/requests/${requestId}`);
    assert.equal(after.json.request.lines.some((l) => l.line_id === line.json.line_id), false);
  });

  test("a line on a request that does not exist is 404", async () => {
    const r = await post("/api/requests/0000000000000000/lines", { description: "x" });
    assert.equal(r.status, 404);
  });

  test("the workflow moves forward and the stage sticks", async () => {
    const r = await post(`/api/requests/${requestId}/stage`, { stage: "order_placed" });
    assert.equal(r.status, 200);
    const one = await get(`/api/requests/${requestId}`);
    assert.equal(one.json.request.stage, "order_placed");
    assert.equal(one.json.request.stage_index, 2);
  });

  test("it can go backwards, because she is the one who knows what happened", async () => {
    await post(`/api/requests/${requestId}/stage`, { stage: "logged" });
    const one = await get(`/api/requests/${requestId}`);
    assert.equal(one.json.request.stage, "logged");
  });

  test("the stage history is kept", async () => {
    const one = await get(`/api/requests/${requestId}`);
    assert.ok(Array.isArray(one.json.request.detail.stage_history));
    assert.ok(one.json.request.detail.stage_history.length >= 2);
  });

  test("an invented stage is refused and the allowed list is returned", async () => {
    const r = await post(`/api/requests/${requestId}/stage`, { stage: "teleported" });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.allowed));
  });

  test("reaching restocked clears the follow-up so it leaves Open items", async () => {
    await post(`/api/requests/${requestId}/stage`, { stage: "restocked" });
    const one = await get(`/api/requests/${requestId}`);
    assert.equal(one.json.request.follow_up, false);
  });

  test("filtering by stage works", async () => {
    const r = await get("/api/requests?stage=restocked");
    assert.ok(r.json.requests.every((x) => x.stage === "restocked"));
    assert.ok(r.json.requests.some((x) => x.activity_id === requestId));
  });

  test("the open filter hides finished requests", async () => {
    const r = await get("/api/requests?open=1");
    assert.equal(r.json.requests.some((x) => x.activity_id === requestId), false);
  });
});

/* ------------------------------------------------------------- attachments */

describe("photos - the dead Pictures column", () => {
  let activityId;

  before(async () => {
    const s = await get("/api/stores?q=335");
    const made = await post("/api/activities", {
      work_type_id: "stand",
      store_id: s.json.stores[0].store_id,
      note: "phase 2 photo test",
    });
    activityId = made.json.activity.activity_id;
  });

  test("a record starts with no photos", async () => {
    const r = await get(`/api/activities/${activityId}/attachments`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.attachments, []);
  });

  test("an image uploads and is listed against the record", async () => {
    const up = await call("POST", `/api/activities/${activityId}/attachments?name=stand.png`, {
      body: PNG, raw: true, type: "image/png",
    });
    assert.equal(up.status, 201, up.buf.toString());
    assert.equal(up.json.bytes, PNG.length);

    const list = await get(`/api/activities/${activityId}/attachments`);
    assert.equal(list.json.attachments.length, 1);
    assert.equal(list.json.attachments[0].mime, "image/png");
    assert.ok(list.json.attachments[0].url.endsWith(list.json.attachments[0].attachment_id));
  });

  test("the bytes come back exactly as uploaded", async () => {
    const list = await get(`/api/activities/${activityId}/attachments`);
    const r = await get(list.json.attachments[0].url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(Buffer.compare(r.buf, PNG), 0, "the file came back different from what went in");
  });

  test("the listing never carries the bytes", async () => {
    const list = await get(`/api/activities/${activityId}/attachments`);
    assert.equal("data" in list.json.attachments[0], false);
  });

  test("a type we cannot display is refused", async () => {
    const r = await call("POST", `/api/activities/${activityId}/attachments`, {
      body: Buffer.from("rm -rf /"), raw: true, type: "application/x-sh",
    });
    assert.equal(r.status, 415);
  });

  test("an empty upload is refused", async () => {
    const r = await call("POST", `/api/activities/${activityId}/attachments`, {
      body: Buffer.alloc(0), raw: true, type: "image/png",
    });
    assert.equal(r.status, 400);
  });

  test("uploading against a record that does not exist is 404", async () => {
    const r = await call("POST", "/api/activities/0000000000000000/attachments", {
      body: PNG, raw: true, type: "image/png",
    });
    assert.equal(r.status, 404);
  });

  test("a photo can be removed", async () => {
    const list = await get(`/api/activities/${activityId}/attachments`);
    const d = await del(list.json.attachments[0].url);
    assert.equal(d.status, 200);
    const after = await get(`/api/activities/${activityId}/attachments`);
    assert.equal(after.json.attachments.length, 0);
  });

  test("fetching a photo that does not exist is 404", async () => {
    const r = await get("/api/attachments/0000000000000000");
    assert.equal(r.status, 404);
  });
});

/* --------------------------------------------------------------- campaigns */

describe("allocation campaigns", () => {
  let campaignId;
  let storeId;
  let productId;

  before(async () => {
    const s = await get("/api/stores?q=335");
    storeId = s.json.stores[0].store_id;
    const p = await get("/api/products?q=zyn");
    productId = p.json.products[0]?.product_id || null;

    const made = await post("/api/campaigns", { name: `Test allocation ${Date.now()}`, brand: "Hayati" });
    assert.equal(made.status, 201);
    campaignId = made.json.campaign_id;
  });

  test("a campaign needs a name", async () => {
    const r = await post("/api/campaigns", { brand: "Nameless" });
    assert.equal(r.status, 400);
  });

  test("a new campaign is open and empty", async () => {
    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.campaign.status, "open");
    assert.deepEqual(r.json.lines, []);
    assert.equal(r.json.totals.units_requested, 0);
  });

  test("a line ties a store to a SKU", async () => {
    const line = await post(`/api/campaigns/${campaignId}/lines`, {
      store_id: storeId, product_id: productId, qty_requested: 12,
    });
    assert.equal(line.status, 201);

    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines.length, 1);
    assert.equal(r.json.lines[0].qty_requested, 12);
    assert.equal(r.json.lines[0].store_code, "Fs335");
    assert.equal(r.json.lines[0].fulfilment, "pending");
  });

  test("adding the same store and SKU again updates rather than double-counting", async () => {
    await post(`/api/campaigns/${campaignId}/lines`, {
      store_id: storeId, product_id: productId, qty_requested: 20,
    });
    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines.length, 1, "a duplicate line was created");
    assert.equal(r.json.totals.units_requested, 20);
  });

  test("a line needs a store", async () => {
    const r = await post(`/api/campaigns/${campaignId}/lines`, { qty_requested: 5 });
    assert.equal(r.status, 400);
  });

  test("an unknown store is refused", async () => {
    const r = await post(`/api/campaigns/${campaignId}/lines`, { store_id: "0000000000000000" });
    assert.equal(r.status, 400);
  });

  test("fulfilment and quantities can be recorded", async () => {
    const r0 = await get(`/api/campaigns/${campaignId}`);
    const line = r0.json.lines[0];
    const u = await patch(`/api/campaigns/${campaignId}/lines/${line.line_id}`, {
      qty_fulfilled: 8, fulfilment: "partial",
    });
    assert.equal(u.status, 200);

    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines[0].qty_fulfilled, 8);
    assert.equal(r.json.totals.by_fulfilment.partial, 1);
  });

  test("an invented fulfilment state is refused", async () => {
    const r0 = await get(`/api/campaigns/${campaignId}`);
    const r = await patch(`/api/campaigns/${campaignId}/lines/${r0.json.lines[0].line_id}`, {
      fulfilment: "maybe",
    });
    assert.equal(r.status, 400);
  });

  test("an order number attaches, creating the order if it is new", async () => {
    const number = `6${Date.now()}`.slice(0, 8);
    const r0 = await get(`/api/campaigns/${campaignId}`);
    const u = await patch(`/api/campaigns/${campaignId}/lines/${r0.json.lines[0].line_id}`, { order_number: number });
    assert.equal(u.status, 200, `attaching the order failed: ${u.buf.toString()}`);

    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines[0].order_number, number);
    const look = await get(`/api/orders/lookup/${number}`);
    assert.equal(look.json.known, true);
  });

  test("the Booker and invoice flags toggle and are counted", async () => {
    const r0 = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r0.json.totals.booker_outstanding, 1);

    await patch(`/api/campaigns/${campaignId}/lines/${r0.json.lines[0].line_id}`, { uploaded_to_booker: true });
    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines[0].uploaded_to_booker, true);
    assert.equal(r.json.totals.booker_outstanding, 0);
  });

  test("the call round lists who has not been rung yet", async () => {
    const r = await get(`/api/campaigns/${campaignId}/call-round`);
    assert.equal(r.status, 200);
    assert.equal(r.json.progress.total, 1);
    assert.equal(r.json.progress.called, 0);
    assert.equal(r.json.queue.length, 1);
    assert.ok("phone" in r.json.queue[0], "the call list has no phone number on it");
  });

  test("recording an outcome moves the store out of the queue", async () => {
    const q = await get(`/api/campaigns/${campaignId}/call-round`);
    await patch(`/api/campaigns/${campaignId}/lines/${q.json.queue[0].line_id}`, {
      contact_outcome: "wants 20",
    });
    const r = await get(`/api/campaigns/${campaignId}/call-round`);
    assert.equal(r.json.queue.length, 0);
    assert.equal(r.json.done.length, 1);
    assert.equal(r.json.progress.called, 1);
    assert.ok(r.json.done[0].occurred_on, "the call was not dated");
  });

  test("a campaign can be closed and reopened", async () => {
    await patch(`/api/campaigns/${campaignId}`, { status: "closed" });
    let r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.campaign.status, "closed");
    assert.ok(r.json.campaign.closed_on);

    await patch(`/api/campaigns/${campaignId}`, { status: "open" });
    r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.campaign.status, "open");
    assert.equal(r.json.campaign.closed_on, null);
  });

  test("the list view totals match the campaign view", async () => {
    const list = await get("/api/campaigns");
    const mine = list.json.campaigns.find((c) => c.campaign_id === campaignId);
    const one = await get(`/api/campaigns/${campaignId}`);
    assert.equal(mine.units_requested, one.json.totals.units_requested);
    assert.equal(mine.stores, one.json.totals.stores);
  });

  test("a line can be removed", async () => {
    const r0 = await get(`/api/campaigns/${campaignId}`);
    const d = await del(`/api/campaigns/${campaignId}/lines/${r0.json.lines[0].line_id}`);
    assert.equal(d.status, 200);
    const r = await get(`/api/campaigns/${campaignId}`);
    assert.equal(r.json.lines.length, 0);
  });

  test("an unknown campaign is 404 everywhere", async () => {
    assert.equal((await get("/api/campaigns/0000000000000000")).status, 404);
    assert.equal((await get("/api/campaigns/0000000000000000/call-round")).status, 404);
    assert.equal((await post("/api/campaigns/0000000000000000/lines", { store_id: storeId })).status, 404);
  });
});

/* ---------------------------------------------------------------- products */

describe("product lookup", () => {
  test("every word has to match, in any order", async () => {
    const r = await get("/api/products?q=zyn");
    assert.equal(r.status, 200);
    assert.ok(r.json.products.length > 0);
    assert.ok(
      r.json.products.every((p) =>
        `${p.description} ${p.brand_group} ${p.brand} ${p.flavour}`.toLowerCase().includes("zyn")
      )
    );
  });

  test("no query returns the catalogue, capped", async () => {
    const r = await get("/api/products?limit=9999");
    assert.ok(r.json.products.length <= 50);
  });

  test("nothing matching is an empty list, not an error", async () => {
    const r = await get("/api/products?q=zzzznothing");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.products, []);
  });

  test("the brand groups come back for the stock check headings", async () => {
    const r = await get("/api/products/groups");
    assert.ok(r.json.groups.length > 10);
    assert.ok(r.json.groups.every((g) => typeof g.skus === "number"));
  });
});
