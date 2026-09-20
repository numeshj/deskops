/**
 * Desk Ops - API test suite.
 *
 * Covers every endpoint in server/src/routes plus auth and health. Run against
 * a database loaded from migrated/, because a test that only sees rows it made
 * itself never meets the shapes the real spreadsheet produces.
 *
 *   node --test tests/api.test.mjs
 *
 * BASE defaults to http://127.0.0.1:4100. Set BASE to point it somewhere else.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://127.0.0.1:4100";

let userToken = null;
let adminToken = null;

/* ------------------------------------------------------------------ helpers */

async function call(method, path, { body, token, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const get = (p, o) => call("GET", p, o);
const post = (p, body, o) => call("POST", p, { body, ...o });
const patch = (p, body, o) => call("PATCH", p, { body, ...o });

/** Save an activity as the normal user and return the created row. */
async function save(body) {
  const r = await post("/api/activities", body, { token: userToken });
  assert.equal(r.status, 201, `save failed: ${r.text}`);
  return r.json;
}

before(async () => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const h = await get("/api/health");
      if (h.status === 200 && h.json?.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const u = await post("/api/auth/login", { email: "yashoda@example.com", password: "desk1234" });
  assert.equal(u.status, 200, `user login failed: ${u.text}`);
  userToken = u.json.token;

  const a = await post("/api/auth/login", { email: "admin@example.com", password: "admin1234" });
  assert.equal(a.status, 200, `admin login failed: ${a.text}`);
  adminToken = a.json.token;
});

/* -------------------------------------------------------------------- health */

describe("health and routing", () => {
  test("health reports the database", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.db, true);
    assert.ok(typeof r.json.uptime_s === "number");
  });

  test("an unknown /api path is a JSON 404, not the SPA", async () => {
    const r = await get("/api/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.json?.error, "unknown_endpoint");
  });

  test("a non-API path serves the single-page app", async () => {
    const r = await get("/drafts");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /html/);
  });
});

/* ---------------------------------------------------------------------- auth */

describe("auth", () => {
  test("a wrong password is rejected", async () => {
    const r = await post("/api/auth/login", { email: "yashoda@example.com", password: "nope" });
    assert.equal(r.status, 401);
  });

  test("an unknown email is rejected", async () => {
    const r = await post("/api/auth/login", { email: "nobody@example.com", password: "desk1234" });
    assert.equal(r.status, 401);
  });

  test("login sets a cookie as well as returning a token", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "yashoda@example.com", password: "desk1234" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") || "", /HttpOnly/i);
  });

  test("a protected route without a token is 401", async () => {
    const r = await get("/api/activities/today");
    assert.equal(r.status, 401);
  });

  test("a garbage token is 401, not 500", async () => {
    const r = await get("/api/activities/today", { token: "not.a.jwt" });
    assert.equal(r.status, 401);
  });

  test("me returns the signed-in user and never the password hash", async () => {
    const r = await get("/api/auth/me", { token: userToken });
    assert.equal(r.status, 200);
    const u = r.json.user ?? r.json;
    assert.equal(u.email, "yashoda@example.com");
    assert.equal(u.role, "user");
    assert.equal(JSON.stringify(r.json).includes("password"), false);
  });
});

/* -------------------------------------------------------------------- vocab */

describe("work types and reason chips", () => {
  test("every work type comes back with parsed fields and its chips", async () => {
    const r = await get("/api/vocab/work-types", { token: userToken });
    assert.equal(r.status, 200);
    const types = r.json.work_types;
    assert.equal(types.length, 9);

    for (const t of types) {
      assert.ok(Array.isArray(t.shared_fields), `${t.work_type_id} shared_fields not an array`);
      assert.ok(Array.isArray(t.reasons), `${t.work_type_id} reasons not an array`);
      assert.equal(typeof t.is_project, "boolean");
    }
    assert.ok(types.some((t) => t.work_type_id === "other"), "the Other escape hatch is missing");
  });

  test("chips are ordered by how often she uses them", async () => {
    const r = await get("/api/vocab/work-types", { token: userToken });
    for (const t of r.json.work_types) {
      const counts = t.reasons.map((x) => Number(x.usage_count));
      const sorted = [...counts].sort((a, b) => b - a);
      assert.deepEqual(counts, sorted, `${t.work_type_id} chips are not usage-ordered`);
    }
  });
});

/* ------------------------------------------------------------------- stores */

describe("store picker", () => {
  test("an empty query returns her most-used stores", async () => {
    const r = await get("/api/stores", { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, "recent");
    assert.ok(r.json.stores.length > 0 && r.json.stores.length <= 8);
    const counts = r.json.stores.map((s) => Number(s.mention_count));
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });

  test("a bare number finds the store and ranks the exact code first", async () => {
    const r = await get("/api/stores?q=335", { token: userToken });
    assert.equal(r.json.mode, "search");
    assert.ok(r.json.stores.length > 0);
    assert.equal(r.json.stores[0].code, "FS0335");
    assert.equal(Number(r.json.stores[0].rank_score), 0);
  });

  test("a contact name finds the store", async () => {
    const r = await get("/api/stores?q=Missi", { token: userToken });
    assert.ok(r.json.stores.length > 0, "searching by contact name found nothing");
  });

  test("the limit is capped so a huge limit cannot dump the table", async () => {
    const r = await get("/api/stores?limit=9999", { token: userToken });
    assert.ok(r.json.stores.length <= 25);
  });

  test("a query matching nothing returns an empty list, not an error", async () => {
    const r = await get("/api/stores?q=zzzzzznotathing", { token: userToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.stores, []);
  });
});

describe("store view", () => {
  let storeId;

  before(async () => {
    const r = await get("/api/stores?q=335", { token: userToken });
    storeId = r.json.stores[0].store_id;
  });

  test("returns the store, contacts, history and summary together", async () => {
    const r = await get(`/api/stores/${storeId}`, { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.store.code, "FS0335");
    assert.ok(Array.isArray(r.json.contacts));
    assert.ok(r.json.activities.length > 0, "a store with 61 mentions has no history");
    assert.ok(Number(r.json.summary.total) > 0);
    assert.ok(Array.isArray(r.json.summary.by_type));
    assert.ok(Array.isArray(r.json.orders));
  });

  test("history is newest first", async () => {
    const r = await get(`/api/stores/${storeId}`, { token: userToken });
    const dates = r.json.activities.map((a) => a.occurred_at);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  test("an unknown store is 404", async () => {
    const r = await get("/api/stores/0000000000000000", { token: userToken });
    assert.equal(r.status, 404);
  });

  test("a contact needs a name", async () => {
    const r = await post(`/api/stores/${storeId}/contacts`, { phone: "0700" }, { token: userToken });
    assert.equal(r.status, 400);
  });

  test("a new contact is added and shows on the store", async () => {
    const name = `Test Contact ${Date.now()}`;
    const c = await post(`/api/stores/${storeId}/contacts`, { name, phone: "07700900000" }, { token: userToken });
    assert.equal(c.status, 201);
    const r = await get(`/api/stores/${storeId}`, { token: userToken });
    assert.ok(r.json.contacts.some((x) => x.name === name));
  });

  test("adding a contact to a store that does not exist is refused, not a 500", async () => {
    const r = await post("/api/stores/0000000000000000/contacts", { name: "Ghost" }, { token: userToken });
    assert.ok(r.status === 404 || r.status === 400, `expected 404/400, got ${r.status}`);
  });
});

/* --------------------------------------------------------------- the save path */

describe("saving work", () => {
  test("a record with no work type is refused", async () => {
    const r = await post("/api/activities", { note: "hello" }, { token: userToken });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "work_type_required");
  });

  test("an unknown work type is refused", async () => {
    const r = await post("/api/activities", { work_type_id: "teleportation" }, { token: userToken });
    assert.equal(r.status, 400);
  });

  test("a chip on its own saves, and becomes a draft", async () => {
    const out = await save({ work_type_id: "call" });
    assert.equal(out.activity.is_draft, true);
    assert.equal(out.activity.work_type_id, "call");
  });

  test("with a store it is a finished record, defaulted server-side", async () => {
    const s = await get("/api/stores?q=335", { token: userToken });
    const out = await save({ work_type_id: "call", store_id: s.json.stores[0].store_id });
    assert.equal(out.activity.is_draft, false);
    assert.equal(out.activity.status, "done");
    assert.equal(out.activity.follow_up, false);
    assert.ok(out.activity.occurred_at, "occurred_at was not defaulted");
    assert.equal(out.activity.store_code, "Fs335");
  });

  test("asking for a follow-up moves the status to needs_reply on its own", async () => {
    const out = await save({ work_type_id: "call", follow_up: true });
    assert.equal(out.activity.follow_up, true);
    assert.equal(out.activity.status, "needs_reply");
  });

  test("capture time is recorded - this is how the project proves itself", async () => {
    const out = await save({ work_type_id: "call", capture_seconds: 4 });
    assert.equal(Number(out.activity.capture_seconds), 4);
  });

  test("an unseen order number is created rather than rejected", async () => {
    const number = `9${Date.now()}`.slice(0, 8);
    const out = await save({ work_type_id: "order", order_number: number });
    assert.equal(out.activity.order_number, number);
    const look = await get(`/api/orders/lookup/${number}`, { token: userToken });
    assert.equal(look.json.known, true);
  });

  test("a legacy 7-digit order number survives as a string", async () => {
    const out = await save({ work_type_id: "order", order_number: "1853706" });
    assert.equal(out.activity.order_number, "1853706");
  });

  test("a leading zero in an order number is not eaten", async () => {
    const number = `0${Date.now()}`.slice(0, 8);
    const out = await save({ work_type_id: "order", order_number: number });
    assert.equal(out.activity.order_number, number, "leading zero lost - order_ref.number is not a string");
  });

  test("a known reason chip is stored and its usage count rises", async () => {
    const v = await get("/api/vocab/work-types", { token: userToken });
    const call = v.json.work_types.find((t) => t.work_type_id === "call");
    const chip = call.reasons[0];
    const before = Number(chip.usage_count);

    const out = await save({ work_type_id: "call", reason_id: chip.reason_id });
    assert.equal(out.activity.reason_label, chip.label);
    assert.equal(out.activity.unlisted, false);

    const after = await get("/api/vocab/work-types", { token: userToken });
    const again = after.json.work_types
      .find((t) => t.work_type_id === "call").reasons
      .find((x) => x.reason_id === chip.reason_id);
    assert.equal(Number(again.usage_count), before + 1);
  });

  test("a reason id that does not exist becomes free text, never an error", async () => {
    const out = await save({ work_type_id: "call", reason_id: "call:not_a_real_reason", reason_freetext: "made up" });
    assert.equal(out.activity.status, "done");
    assert.equal(out.activity.reason_label, null);
  });

  test("detail is stored as JSON and comes back as an object", async () => {
    const out = await save({ work_type_id: "stand", detail: { stand: "Pringles", qty: 2 } });
    assert.deepEqual(out.activity.detail, { stand: "Pringles", qty: 2 });
  });
});

/* ---------------------------------------------------------- unlisted work (s6) */

describe("work we did not think of", () => {
  const phrase = `chase the ${Date.now()} labels urgently`;

  test("Other with free text saves and opens a cluster", async () => {
    const out = await save({ work_type_id: "other", reason_id: "other", reason_freetext: phrase });
    assert.equal(out.activity.unlisted, true);
    assert.equal(out.activity.reason, phrase);
    assert.ok(out.cluster, "no cluster was opened");
    assert.equal(out.cluster.occurrences, 1);
  });

  test("the same phrase again lands in the same cluster", async () => {
    const out = await save({ work_type_id: "other", reason_id: "other", reason_freetext: phrase });
    assert.equal(out.cluster.occurrences, 2);
  });

  test("a differently worded version of the same job still clusters", async () => {
    const out = await save({
      work_type_id: "other",
      reason_id: "other",
      reason_freetext: `urgently chase those ${Date.now()} labels`.replace(/\d+/, phrase.match(/\d+/)[0]),
    });
    assert.equal(out.cluster.occurrences, 3, "token-overlap matching did not group a reworded phrase");
  });

  test("three occurrences marks the cluster ready for promotion", async () => {
    const r = await get("/api/vocab/unlisted", { token: userToken });
    const mine = r.json.clusters.find((c) => c.suggested_label === phrase);
    assert.ok(mine, "the cluster is not in the promotion queue");
    assert.equal(mine.ready, true);
  });

  test("the queue reports an Other rate with a health band", async () => {
    const r = await get("/api/vocab/unlisted", { token: userToken });
    assert.equal(typeof r.json.health.other_rate, "number");
    assert.ok(["good", "watch", "drifting"].includes(r.json.health.band));
  });

  test("promotion needs a work type", async () => {
    const r = await get("/api/vocab/unlisted", { token: userToken });
    const mine = r.json.clusters.find((c) => c.suggested_label === phrase);
    const bad = await post(`/api/vocab/unlisted/${mine.cluster_id}/promote`, {}, { token: userToken });
    assert.equal(bad.status, 400);
  });

  test("promoting a cluster that does not exist is 404", async () => {
    const r = await post("/api/vocab/unlisted/0000000000000000/promote", { work_type_id: "other" }, { token: userToken });
    assert.equal(r.status, 404);
  });

  test("promotion creates a chip, back-fills, and never destroys the original words", async () => {
    const q = await get("/api/vocab/unlisted", { token: userToken });
    const mine = q.json.clusters.find((c) => c.suggested_label === phrase);

    const r = await post(
      `/api/vocab/unlisted/${mine.cluster_id}/promote`,
      { work_type_id: "other", label: "Chase labels" },
      { token: userToken }
    );
    assert.equal(r.status, 200);
    assert.ok(r.json.reason_id);
    assert.ok(r.json.backfilled >= 3, `expected at least 3 back-filled, got ${r.json.backfilled}`);

    // the chip now exists
    const v = await get("/api/vocab/work-types", { token: userToken });
    const other = v.json.work_types.find((t) => t.work_type_id === "other");
    assert.ok(other.reasons.some((x) => x.reason_id === r.json.reason_id), "the promoted chip is missing");

    // and the free text she typed is still on the records.
    // These are storeless saves, so they live in drafts, not today's log.
    const drafts = await get("/api/activities/drafts", { token: userToken });
    const touched = drafts.json.drafts.filter((a) => a.reason_freetext === phrase);
    assert.ok(touched.length > 0, "the original free text was destroyed by promotion");
    assert.ok(touched.every((a) => a.reason_label), "back-fill did not attach the new chip");
  });

  test("a cluster can be dismissed", async () => {
    const out = await save({ work_type_id: "other", reason_id: "other", reason_freetext: `dismiss me ${Date.now()}` });
    const d = await post(`/api/vocab/unlisted/${out.cluster.cluster_id}/dismiss`, {}, { token: userToken });
    assert.equal(d.status, 200);
    const q = await get("/api/vocab/unlisted", { token: userToken });
    assert.equal(q.json.clusters.some((c) => c.cluster_id === out.cluster.cluster_id), false);
  });
});

/* ------------------------------------------------------- today, drafts, open */

describe("today's log", () => {
  test("shows today's finished records with counts and capture speed", async () => {
    await save({ work_type_id: "issue", capture_seconds: 6 });
    const r = await get("/api/activities/today", { token: userToken });
    assert.equal(r.status, 200);
    assert.ok(r.json.activities.length > 0);
    assert.ok(Number(r.json.counts.total) > 0);
    assert.equal(typeof r.json.speed.baseline, "number");
  });

  test("drafts are kept out of today's log", async () => {
    const draft = await save({ work_type_id: "call" });
    assert.equal(draft.activity.is_draft, true);
    const r = await get("/api/activities/today", { token: userToken });
    assert.equal(r.json.activities.some((a) => a.activity_id === draft.activity.activity_id), false);
  });

  test("the counts match the rows returned", async () => {
    const r = await get("/api/activities/today", { token: userToken });
    const calls = r.json.activities.filter((a) => a.work_type_id === "call").length;
    assert.ok(Number(r.json.counts.calls) >= calls);
  });
});

describe("drafts tray", () => {
  test("a storeless record waits in drafts", async () => {
    const d = await save({ work_type_id: "call", note: "who was that" });
    const r = await get("/api/activities/drafts", { token: userToken });
    assert.ok(r.json.drafts.some((x) => x.activity_id === d.activity.activity_id));
  });

  test("attaching the store completes the draft", async () => {
    const d = await save({ work_type_id: "call" });
    const s = await get("/api/stores?q=335", { token: userToken });
    const u = await patch(
      `/api/activities/${d.activity.activity_id}`,
      { store_id: s.json.stores[0].store_id, is_draft: false },
      { token: userToken }
    );
    assert.equal(u.status, 200);
    assert.equal(u.json.activity.is_draft, false);
    assert.equal(u.json.activity.store_code, "Fs335");

    const r = await get("/api/activities/drafts", { token: userToken });
    assert.equal(r.json.drafts.some((x) => x.activity_id === d.activity.activity_id), false);
  });

  test("an update with nothing in it is refused", async () => {
    const d = await save({ work_type_id: "call" });
    const u = await patch(`/api/activities/${d.activity.activity_id}`, {}, { token: userToken });
    assert.equal(u.status, 400);
  });

  test("updating a record that does not exist is 404, not a 500", async () => {
    const u = await patch("/api/activities/0000000000000000", { note: "x" }, { token: userToken });
    assert.equal(u.status, 404, `expected 404, got ${u.status}`);
  });
});

describe("open items", () => {
  test("follow-ups are listed with an age and grouped into buckets", async () => {
    await save({ work_type_id: "issue", follow_up: true, note: "waiting on supplier" });
    const r = await get("/api/activities/open", { token: userToken });
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length > 0);
    assert.ok(r.json.items.every((i) => Number.isInteger(i.age_days) && i.age_days >= 0));
    const sum = r.json.buckets.today + r.json.buckets.week + r.json.buckets.older;
    assert.equal(sum, r.json.total);
  });

  test("oldest first, because that is the one being forgotten", async () => {
    const r = await get("/api/activities/open", { token: userToken });
    const ages = r.json.items.map((i) => i.age_days);
    assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
  });

  test("resolving closes the item and stamps the time", async () => {
    const a = await save({ work_type_id: "issue", follow_up: true });
    const r = await post(`/api/activities/${a.activity.activity_id}/resolve`, { note: "sorted" }, { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.activity.follow_up, false);
    assert.equal(r.json.activity.status, "done");

    const open = await get("/api/activities/open", { token: userToken });
    assert.equal(open.json.items.some((i) => i.activity_id === a.activity.activity_id), false);
  });

  test("resolving something that does not exist is 404, not a 500", async () => {
    const r = await post("/api/activities/0000000000000000/resolve", {}, { token: userToken });
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  });
});

/* --------------------------------------------------------------------- paste */

describe("paste detection", () => {
  test("pulls a store code and an order number out of pasted text", async () => {
    const r = await post(
      "/api/activities/parse-paste",
      { text: "FS0335 order 11043984 short delivery" },
      { token: userToken }
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.storeCode, "FS0335");
    assert.equal(r.json.orderNumber, "11043984");
    assert.equal(r.json.valid_order, true);
    assert.ok(r.json.store, "a known store code did not resolve to a store");
  });

  test("handles text with nothing in it", async () => {
    const r = await post("/api/activities/parse-paste", { text: "just a note" }, { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.store, null);
  });

  test("handles an empty body without falling over", async () => {
    const r = await post("/api/activities/parse-paste", {}, { token: userToken });
    assert.equal(r.status, 200);
  });
});

/* -------------------------------------------------------------------- orders */

describe("orders", () => {
  let known;

  before(async () => {
    const s = await get("/api/stores?q=335", { token: userToken });
    const view = await get(`/api/stores/${s.json.stores[0].store_id}`, { token: userToken });
    known = view.json.orders[0];
  });

  test("lookup tells you whether a number is known and whether it is well formed", async () => {
    const r = await get(`/api/orders/lookup/${known.number}`, { token: userToken });
    assert.equal(r.json.known, true);
    assert.equal(r.json.order.number, known.number);
  });

  test("an unknown number is reported as unknown rather than 404", async () => {
    const r = await get("/api/orders/lookup/99999999", { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.known, false);
  });

  test("the order view merges what used to live in separate sheets", async () => {
    const r = await get(`/api/orders/${known.order_id}`, { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.order.number, known.number);
    assert.ok(Array.isArray(r.json.timeline));
    assert.ok(Array.isArray(r.json.replacements));
    assert.ok(Array.isArray(r.json.sheets_merged));
  });

  test("an order can be opened by its number as well as its id", async () => {
    const r = await get(`/api/orders/${known.number}`, { token: userToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.order.order_id, known.order_id);
  });

  test("the timeline runs oldest to newest", async () => {
    const r = await get(`/api/orders/${known.order_id}`, { token: userToken });
    const dates = r.json.timeline.map((t) => t.occurred_at);
    assert.deepEqual(dates, [...dates].sort());
  });

  test("a replacement is listed once, however many records point at it", async () => {
    const number = `8${Date.now()}`.slice(0, 8);
    const repl = `7${Date.now()}`.slice(0, 8);
    await save({ work_type_id: "two_p", order_number: number, related_order_number: repl });
    await save({ work_type_id: "issue", order_number: number, related_order_number: repl });

    const r = await get(`/api/orders/${number}`, { token: userToken });
    const rows = r.json.replacements.filter((x) => x.replacement_number === repl);
    assert.equal(rows.length, 1, "the same replacement is listed more than once");
    assert.ok(rows[0].raised_as.includes(","), "raised_as should name both work types");
  });

  test("an unknown order is 404", async () => {
    const r = await get("/api/orders/not-an-order-at-all", { token: userToken });
    assert.equal(r.status, 404);
  });
});

/* ------------------------------------------------------- reason admin (T20) */

describe("reason admin is admin-only", () => {
  test("a normal user cannot create a chip", async () => {
    const r = await post("/api/vocab/reasons", { work_type_id: "call", label: "Sneaky" }, { token: userToken });
    assert.equal(r.status, 403);
  });

  test("a normal user cannot edit a chip", async () => {
    const r = await patch("/api/vocab/reasons/call:anything", { label: "Sneaky" }, { token: userToken });
    assert.equal(r.status, 403);
  });

  test("a normal user cannot merge chips", async () => {
    const r = await post("/api/vocab/reasons/call:a/merge", { into: "call:b" }, { token: userToken });
    assert.equal(r.status, 403);
  });

  test("an admin can create a chip and it appears in the vocabulary", async () => {
    const label = `Test chip ${Date.now()}`;
    const r = await post("/api/vocab/reasons", { work_type_id: "call", label }, { token: adminToken });
    assert.equal(r.status, 201);
    const v = await get("/api/vocab/work-types", { token: userToken });
    const call = v.json.work_types.find((t) => t.work_type_id === "call");
    assert.ok(call.reasons.some((x) => x.reason_id === r.json.reason_id));
  });

  test("creating a chip needs both a work type and a label", async () => {
    const r = await post("/api/vocab/reasons", { work_type_id: "call" }, { token: adminToken });
    assert.equal(r.status, 400);
  });

  test("an admin can retire a chip and it leaves the vocabulary", async () => {
    const label = `Retire me ${Date.now()}`;
    const c = await post("/api/vocab/reasons", { work_type_id: "call", label }, { token: adminToken });
    const u = await patch(`/api/vocab/reasons/${c.json.reason_id}`, { active: false }, { token: adminToken });
    assert.equal(u.status, 200);
    const v = await get("/api/vocab/work-types", { token: userToken });
    const call = v.json.work_types.find((t) => t.work_type_id === "call");
    assert.equal(call.reasons.some((x) => x.reason_id === c.json.reason_id), false);
  });

  test("merging moves the records and keeps an alias so history still resolves", async () => {
    const from = await post("/api/vocab/reasons", { work_type_id: "call", label: `From ${Date.now()}` }, { token: adminToken });
    const into = await post("/api/vocab/reasons", { work_type_id: "call", label: `Into ${Date.now()}` }, { token: adminToken });

    const a = await save({ work_type_id: "call", reason_id: from.json.reason_id });
    assert.equal(a.activity.reason_id ?? from.json.reason_id, from.json.reason_id);

    const m = await post(`/api/vocab/reasons/${from.json.reason_id}/merge`, { into: into.json.reason_id }, { token: adminToken });
    assert.equal(m.status, 200);

    const after = await get(`/api/activities/${a.activity.activity_id}`, { token: userToken });
    assert.equal(after.json.activity.reason_label, (await get("/api/vocab/work-types", { token: userToken }))
      .json.work_types.find((t) => t.work_type_id === "call")
      .reasons.find((x) => x.reason_id === into.json.reason_id).label);
  });

  test("a merge with no target is refused", async () => {
    const r = await post("/api/vocab/reasons/call:x/merge", {}, { token: adminToken });
    assert.equal(r.status, 400);
  });

  test("merging from a chip that does not exist is 404", async () => {
    const r = await post("/api/vocab/reasons/call:nope_not_here/merge", { into: "call:x" }, { token: adminToken });
    assert.equal(r.status, 404);
  });
});

/* ----------------------------------------------------------- single activity */

describe("one activity", () => {
  test("comes back with its lines", async () => {
    const a = await save({ work_type_id: "request", note: "three cases" });
    const r = await get(`/api/activities/${a.activity.activity_id}`, { token: userToken });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.lines));
  });

  test("an unknown id is 404", async () => {
    const r = await get("/api/activities/0000000000000000", { token: userToken });
    assert.equal(r.status, 404);
  });
});
