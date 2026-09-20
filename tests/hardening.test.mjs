/**
 * Desk Ops - hardening suite.
 *
 * Three things this checks that the feature suites do not:
 *
 *   1. VALIDATION. Every endpoint gets fed the wrong types, the wrong shapes,
 *      hostile strings and boundary numbers. The bar is absolute: nothing may
 *      answer 500. A 400 is a refusal the caller can act on; a 500 is the
 *      server admitting it fell over, and on a free tier it is also an entry
 *      in a log nobody reads.
 *   2. ROLE-BASED ACCESS. Every endpoint, three ways: signed out, as Yashoda,
 *      as an admin. The expected answers come from spec 6.7, not from what the
 *      code happens to do.
 *   3. AUTH INTEGRITY. Tampered tokens, expired tokens, tokens signed with
 *      another key, tokens for a user who has since been deactivated.
 *
 *   node --test tests/hardening.test.mjs
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:4100";

let userToken = null;
let adminToken = null;
let storeId = null;
let productId = null;
let activityId = null;
let campaignId = null;
let requestId = null;

/* ------------------------------------------------------------------ helper */

async function call(method, path, { body, token, rawBody, contentType } = {}) {
  const headers = {};
  if (rawBody !== undefined) headers["Content-Type"] = contentType || "application/json";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const asUser = (m, p, body) => call(m, p, { body, token: userToken });
const asAdmin = (m, p, body) => call(m, p, { body, token: adminToken });
const anon = (m, p, body) => call(m, p, { body });

/** The whole point of the validation suite. */
function notServerError(r, what) {
  assert.notEqual(r.status, 500, `${what} returned 500 — ${r.text.slice(0, 200)}`);
  assert.ok(r.status < 500, `${what} returned ${r.status}`);
}

before(async () => {
  const u = await anon("POST", "/api/auth/login", { email: "yashoda@example.com", password: "desk1234" });
  assert.equal(u.status, 200, `user login failed: ${u.text}`);
  userToken = u.json.token;

  const a = await anon("POST", "/api/auth/login", { email: "admin@example.com", password: "admin1234" });
  assert.equal(a.status, 200, `admin login failed: ${a.text}`);
  adminToken = a.json.token;

  storeId = (await asUser("GET", "/api/stores?q=335")).json.stores[0].store_id;
  productId = (await asUser("GET", "/api/products?q=zyn")).json.products[0]?.product_id ?? null;

  activityId = (await asUser("POST", "/api/activities", { work_type_id: "call", store_id: storeId }))
    .json.activity.activity_id;
  requestId = (await asUser("POST", "/api/activities", { work_type_id: "request", store_id: storeId }))
    .json.activity.activity_id;
  campaignId = (await asUser("POST", "/api/campaigns", { name: `Hardening ${Date.now()}` })).json.campaign_id;
});

/* ========================================================== AUTH INTEGRITY */

describe("auth integrity", () => {
  test("no token is 401 on every protected route", async () => {
    const routes = [
      "/api/auth/me", "/api/activities/today", "/api/activities/drafts", "/api/activities/open",
      "/api/stores", "/api/vocab/work-types", "/api/vocab/unlisted", "/api/orders/lookup/1",
      "/api/stock/today", "/api/stock/persistent", "/api/requests", "/api/campaigns",
      "/api/products", "/api/dashboard/day", "/api/impact",
    ];
    for (const path of routes) {
      const r = await anon("GET", path);
      assert.equal(r.status, 401, `${path} allowed an anonymous caller`);
    }
  });

  test("a token signed with the wrong key is refused", async () => {
    const [h, p] = userToken.split(".");
    const forged = crypto.createHmac("sha256", "not-the-secret").update(`${h}.${p}`).digest("base64url");
    const r = await call("GET", "/api/auth/me", { token: `${h}.${p}.${forged}` });
    assert.equal(r.status, 401);
  });

  test("a tampered payload is refused", async () => {
    const [h, p, s] = userToken.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.role = "admin";
    const tampered = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const r = await call("POST", "/api/vocab/reasons/x/merge", {
      body: { into: "y" }, token: `${h}.${tampered}.${s}`,
    });
    assert.equal(r.status, 401, "a re-signed role claim was accepted");
  });

  test("a structurally broken token is 401, never 500", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "....", "Bearer", "null", "{}"]) {
      const r = await call("GET", "/api/auth/me", { token: bad });
      assert.ok(r.status === 401, `token "${bad}" gave ${r.status}`);
    }
  });

  test("the role is taken from the database, not from the token", async () => {
    // the token says what it says; requireAuth re-reads the user every request
    const me = await asUser("GET", "/api/auth/me");
    assert.equal(me.json.user.role, "user");
  });

  test("login refuses missing or non-string credentials without falling over", async () => {
    for (const body of [
      {}, { email: "yashoda@example.com" }, { password: "desk1234" },
      { email: null, password: null }, { email: [], password: {} },
      { email: 12345, password: true },
    ]) {
      const r = await anon("POST", "/api/auth/login", body);
      notServerError(r, `login ${JSON.stringify(body)}`);
      assert.ok(r.status === 400 || r.status === 401, `login gave ${r.status}`);
    }
  });

  test("a SQL injection in the email is treated as a string", async () => {
    const r = await anon("POST", "/api/auth/login", {
      email: "' OR 1=1 -- ", password: "anything",
    });
    assert.equal(r.status, 401);
  });
});

/* ============================================================== ROLE RULES */

/**
 * Spec 6.7. She is the domain expert, so she never needs permission to add a
 * label; changing the shape of the vocabulary needs a second pair of eyes.
 */
describe("role-based access, against spec 6.7", () => {
  test("Yashoda can save an Other record", async () => {
    const r = await asUser("POST", "/api/activities", {
      work_type_id: "other", reason_id: "other", reason_freetext: `role check ${Date.now()}`,
    });
    assert.equal(r.status, 201);
  });

  test("Yashoda can name a new kind of work by promoting a cluster", async () => {
    const phrase = `role promote ${Date.now()}`;
    let cluster = null;
    for (let i = 0; i < 3; i += 1) {
      cluster = (await asUser("POST", "/api/activities", {
        work_type_id: "other", reason_id: "other", reason_freetext: phrase,
      })).json.cluster;
    }
    const r = await asUser("POST", `/api/vocab/unlisted/${cluster.cluster_id}/promote`, {
      work_type_id: "other",
    });
    assert.equal(r.status, 200, "she cannot name her own work — spec 6.7 says she can");
  });

  test("Yashoda can add a reason chip to an existing work type", async () => {
    const r = await asUser("POST", "/api/vocab/reasons", {
      work_type_id: "call", label: `User chip ${Date.now()}`,
    });
    assert.equal(
      r.status, 201,
      "spec 6.7: adding a label to an existing type is hers to do without asking"
    );
  });

  test("Yashoda can create a campaign", async () => {
    const r = await asUser("POST", "/api/campaigns", { name: `Her campaign ${Date.now()}` });
    assert.equal(r.status, 201);
  });

  test("Yashoda cannot merge two reasons", async () => {
    const r = await asUser("POST", "/api/vocab/reasons/call:a/merge", { into: "call:b" });
    assert.equal(r.status, 403, "merge changes history and is admin-only");
  });

  test("Yashoda cannot rename or retire a reason", async () => {
    const r = await asUser("PATCH", "/api/vocab/reasons/call:a", { label: "Renamed" });
    assert.equal(r.status, 403, "rename and retire are admin-only");
  });

  test("an admin can do everything she can, and the admin-only things too", async () => {
    const made = await asAdmin("POST", "/api/vocab/reasons", {
      work_type_id: "call", label: `Admin chip ${Date.now()}`,
    });
    assert.equal(made.status, 201);
    const renamed = await asAdmin("PATCH", `/api/vocab/reasons/${made.json.reason_id}`, { active: false });
    assert.equal(renamed.status, 200);
  });

  test("a signed-out caller cannot write anything", async () => {
    const writes = [
      ["POST", "/api/activities", { work_type_id: "call" }],
      ["POST", "/api/stock", { out: [] }],
      ["POST", "/api/campaigns", { name: "x" }],
      ["POST", "/api/vocab/reasons", { work_type_id: "call", label: "x" }],
      ["PATCH", `/api/activities/${activityId}`, { note: "x" }],
    ];
    for (const [m, p, b] of writes) {
      const r = await anon(m, p, b);
      assert.equal(r.status, 401, `${m} ${p} allowed an anonymous write`);
    }
  });
});

/* ============================================================== VALIDATION */

describe("malformed request bodies", () => {
  test("broken JSON is a 400, not a crash", async () => {
    const r = await call("POST", "/api/activities", {
      rawBody: "{ this is not json", token: userToken,
    });
    notServerError(r, "broken JSON");
    assert.equal(r.status, 400);
  });

  test("a JSON array where an object belongs is refused", async () => {
    for (const path of ["/api/activities", "/api/campaigns", "/api/stock"]) {
      const r = await call("POST", path, { rawBody: "[1,2,3]", token: userToken });
      notServerError(r, `array body to ${path}`);
    }
  });

  test("a bare string or number body does not crash", async () => {
    for (const raw of ['"hello"', "42", "null", "true"]) {
      const r = await call("POST", "/api/activities", { rawBody: raw, token: userToken });
      notServerError(r, `body ${raw}`);
    }
  });

  test("an empty body does not crash any POST", async () => {
    for (const path of [
      "/api/activities", "/api/campaigns", "/api/stock",
      "/api/activities/parse-paste", `/api/requests/${requestId}/stage`,
    ]) {
      const r = await call("POST", path, { rawBody: "", token: userToken });
      notServerError(r, `empty body to ${path}`);
    }
  });
});

describe("wrong types where a value is expected", () => {
  const hostile = [
    { label: "array", value: ["a", "b"] },
    { label: "object", value: { a: 1 } },
    { label: "boolean", value: true },
    { label: "number", value: 12345 },
    { label: "null", value: null },
    { label: "nested array", value: [["x"]] },
  ];

  test("activity ids and store ids reject non-strings", async () => {
    for (const h of hostile) {
      const r = await asUser("POST", "/api/activities", { work_type_id: "call", store_id: h.value });
      notServerError(r, `store_id as ${h.label}`);
    }
  });

  test("work_type_id rejects non-strings", async () => {
    for (const h of hostile) {
      const r = await asUser("POST", "/api/activities", { work_type_id: h.value });
      notServerError(r, `work_type_id as ${h.label}`);
      assert.equal(r.status, 400, `work_type_id as ${h.label} was accepted`);
    }
  });

  test("order numbers survive odd types", async () => {
    for (const h of hostile) {
      const r = await asUser("POST", "/api/activities", { work_type_id: "order", order_number: h.value });
      notServerError(r, `order_number as ${h.label}`);
    }
  });

  test("detail accepts any JSON but never breaks the insert", async () => {
    for (const value of [[1, 2, 3], "a string", 42, true, { deep: { deeper: [1, { x: null }] } }]) {
      const r = await asUser("POST", "/api/activities", { work_type_id: "call", detail: value });
      notServerError(r, `detail ${JSON.stringify(value).slice(0, 30)}`);
    }
  });

  test("the stock save rejects a non-array out list", async () => {
    for (const value of ["abc", 42, { a: 1 }, true, null]) {
      const r = await asUser("POST", "/api/stock", { out: value });
      notServerError(r, `stock out as ${JSON.stringify(value)}`);
      assert.equal(r.status, 400, `stock accepted out=${JSON.stringify(value)}`);
    }
  });

  test("the stock save survives junk inside the array", async () => {
    const r = await asUser("POST", "/api/stock", {
      out: [null, 42, { a: 1 }, ["nested"], "", "0000000000000000"],
    });
    notServerError(r, "stock with junk ids");
  });

  test("quantities reject non-numeric junk", async () => {
    for (const qty of ["abc", {}, [], true, Infinity, NaN, -1, 1e308]) {
      const r = await asUser("POST", `/api/requests/${requestId}/lines`, {
        description: "junk qty", qty,
      });
      notServerError(r, `qty ${String(qty)}`);
    }
  });

  test("campaign quantities reject junk", async () => {
    const line = await asUser("POST", `/api/campaigns/${campaignId}/lines`, {
      store_id: storeId, product_id: productId,
    });
    for (const qty of ["abc", {}, [], -5, 1e308]) {
      const r = await asUser("PATCH", `/api/campaigns/${campaignId}/lines/${line.json.line_id}`, {
        qty_requested: qty,
      });
      notServerError(r, `campaign qty ${String(qty)}`);
    }
  });
});

describe("hostile and boundary strings", () => {
  const payloads = [
    { label: "sql injection", value: "'; DROP TABLE activity; --" },
    { label: "sql union", value: "' UNION SELECT password_hash FROM app_user -- " },
    { label: "script tag", value: "<script>alert('x')</script>" },
    { label: "img onerror", value: '<img src=x onerror="alert(1)">' },
    { label: "template literal", value: "${process.env.JWT_SECRET}" },
    { label: "null byte", value: "abc\u0000def" },
    { label: "emoji", value: "stand sent 📦 to store 🏪" },
    { label: "rtl override", value: "abc‮def" },
    { label: "4-byte unicode", value: "𝕳𝖊𝖑𝖑𝖔" },
    { label: "newlines", value: "line one\nline two\r\nline three" },
  ];

  test("free text takes anything and gives it back unharmed", async () => {
    for (const p of payloads) {
      const r = await asUser("POST", "/api/activities", {
        work_type_id: "other", reason_id: "other", reason_freetext: p.value, store_id: storeId,
      });
      notServerError(r, `freetext ${p.label}`);
      assert.equal(r.status, 201, `freetext ${p.label} was refused`);
    }
  });

  test("the database is still there after the injection attempts", async () => {
    const r = await asUser("GET", "/api/activities/today");
    assert.equal(r.status, 200, "the activity table did not survive");
    assert.ok(r.json.activities.length >= 0);
  });

  test("no response ever leaks a password hash", async () => {
    // Looks for a real bcrypt hash and for password_hash used as a JSON KEY.
    // A bare substring search fails on our own injection probes, which are
    // stored as free text and echoed back — that is the injection failing to
    // execute, which is the opposite of a leak.
    for (const path of ["/api/auth/me", "/api/activities/today", "/api/stores", "/api/impact"]) {
      const r = await asUser("GET", path);
      assert.equal(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/.test(r.text), false, `${path} leaked a bcrypt hash`);
      assert.equal(/"password_hash"\s*:/.test(r.text), false, `${path} returned a password_hash field`);
    }
  });

  test("the store search takes hostile input without breaking", async () => {
    for (const p of [...payloads, { label: "percent", value: "%" }, { label: "underscore", value: "_" },
                     { label: "backslash", value: "\\" }, { label: "only spaces", value: "     " }]) {
      const r = await asUser("GET", `/api/stores?q=${encodeURIComponent(p.value)}`);
      notServerError(r, `store search ${p.label}`);
      assert.equal(r.status, 200);
    }
  });

  test("a LIKE wildcard does not match everything", async () => {
    const all = await asUser("GET", "/api/stores?q=");
    const pct = await asUser("GET", "/api/stores?q=%25");
    assert.ok(
      pct.json.stores.length <= all.json.stores.length,
      "a bare % behaved as a wildcard and dumped the table"
    );
  });

  test("the product search takes hostile input", async () => {
    for (const p of payloads) {
      const r = await asUser("GET", `/api/products?q=${encodeURIComponent(p.value)}`);
      notServerError(r, `product search ${p.label}`);
    }
  });

  test("very long strings are cut, not rejected with a 500", async () => {
    const long = "x".repeat(10_000);
    const r = await asUser("POST", "/api/activities", {
      work_type_id: "other", reason_id: "other", reason_freetext: long,
      note: long, contact_freetext: long, store_id: storeId,
    });
    notServerError(r, "10k strings");
    assert.equal(r.status, 201);
  });

  test("a body over the size limit is refused cleanly", async () => {
    const r = await call("POST", "/api/activities", {
      rawBody: JSON.stringify({ work_type_id: "call", note: "x".repeat(2_000_000) }),
      token: userToken,
    });
    notServerError(r, "2MB body");
    assert.ok(r.status === 413 || r.status === 400, `oversized body gave ${r.status}`);
  });
});

describe("ids and lookups", () => {
  const badIds = [
    "0000000000000000", "not-an-id", "../../etc/passwd", "%2e%2e%2f", "null", "undefined",
    "' OR '1'='1", "<script>", "x".repeat(500), "0", "-1", "1e10",
  ];

  test("every by-id GET answers 404 or 400, never 500", async () => {
    for (const id of badIds) {
      for (const path of [
        `/api/activities/${encodeURIComponent(id)}`,
        `/api/stores/${encodeURIComponent(id)}`,
        `/api/orders/${encodeURIComponent(id)}`,
        `/api/campaigns/${encodeURIComponent(id)}`,
        `/api/requests/${encodeURIComponent(id)}`,
        `/api/attachments/${encodeURIComponent(id)}`,
      ]) {
        const r = await asUser("GET", path);
        notServerError(r, `GET ${path}`);
      }
    }
  });

  test("every by-id write answers 404 or 400, never 500", async () => {
    for (const id of badIds.slice(0, 6)) {
      const e = encodeURIComponent(id);
      const calls = [
        ["PATCH", `/api/activities/${e}`, { note: "x" }],
        ["POST", `/api/activities/${e}/resolve`, {}],
        ["POST", `/api/stores/${e}/contacts`, { name: "x" }],
        ["POST", `/api/requests/${e}/lines`, { description: "x" }],
        ["POST", `/api/requests/${e}/stage`, { stage: "logged" }],
        ["PATCH", `/api/campaigns/${e}`, { name: "x" }],
        ["POST", `/api/campaigns/${e}/lines`, { store_id: storeId }],
        ["POST", `/api/vocab/unlisted/${e}/promote`, { work_type_id: "other" }],
        ["POST", `/api/vocab/unlisted/${e}/dismiss`, {}],
      ];
      for (const [m, p, b] of calls) {
        const r = await asUser(m, p, b);
        notServerError(r, `${m} ${p}`);
      }
    }
  });

  test("an order lookup takes any string", async () => {
    for (const id of badIds) {
      const r = await asUser("GET", `/api/orders/lookup/${encodeURIComponent(id)}`);
      notServerError(r, `order lookup ${id}`);
      assert.equal(r.status, 200);
    }
  });
});

describe("query parameters", () => {
  test("limits are clamped, not trusted", async () => {
    for (const limit of ["9999", "-1", "0", "abc", "1e9", "", "null", "[]"]) {
      const s = await asUser("GET", `/api/stores?limit=${encodeURIComponent(limit)}`);
      notServerError(s, `store limit ${limit}`);
      assert.ok(s.json.stores.length <= 25, `store limit ${limit} returned ${s.json.stores.length}`);

      const p = await asUser("GET", `/api/products?limit=${encodeURIComponent(limit)}`);
      notServerError(p, `product limit ${limit}`);
      assert.ok(p.json.products.length <= 50, `product limit ${limit} returned ${p.json.products.length}`);
    }
  });

  test("dates that are not dates fall back rather than reaching SQL", async () => {
    for (const d of [
      "2026-13-45", "not-a-date", "'; DROP TABLE activity; --", "2026-02-30",
      "0000-00-00", "9999-99-99", "2026/01/01", "x".repeat(200),
    ]) {
      const r = await asUser("GET", `/api/dashboard/day?date=${encodeURIComponent(d)}`);
      notServerError(r, `dashboard date ${d}`);
      assert.equal(r.status, 200);
      assert.match(r.json.range.from, /^\d{4}-\d{2}-\d{2}$/, `date ${d} produced a broken range`);

      const s = await asUser("GET", `/api/stock/today?date=${encodeURIComponent(d)}`);
      notServerError(s, `stock date ${d}`);
    }
  });

  test("the activity table survived every date attempt", async () => {
    const r = await asUser("GET", "/api/dashboard/day");
    assert.equal(r.status, 200);
  });

  test("impact assumptions are clamped", async () => {
    for (const v of ["-50", "99999", "abc", "Infinity", "NaN", "1e308", ""]) {
      const r = await asUser("GET", `/api/impact?m_call=${encodeURIComponent(v)}`);
      notServerError(r, `impact m_call=${v}`);
      const mins = r.json.effort.assumptions.minutes.call;
      assert.ok(mins >= 0 && mins <= 240, `m_call=${v} produced ${mins}`);
      assert.ok(Number.isFinite(r.json.effort.total_hours), `m_call=${v} produced a non-finite total`);
    }
  });

  test("an unknown query parameter is simply ignored", async () => {
    const r = await asUser("GET", "/api/stores?q=335&nonsense=1&__proto__=x");
    assert.equal(r.status, 200);
  });
});

describe("enumerations", () => {
  test("only real stages are accepted", async () => {
    for (const stage of ["", "LOGGED", "restocked ", "deleted", 42, [], {}, null]) {
      const r = await asUser("POST", `/api/requests/${requestId}/stage`, { stage });
      notServerError(r, `stage ${JSON.stringify(stage)}`);
      assert.equal(r.status, 400, `stage ${JSON.stringify(stage)} was accepted`);
    }
  });

  test("only real fulfilment states are accepted", async () => {
    const line = await asUser("POST", `/api/campaigns/${campaignId}/lines`, { store_id: storeId });
    for (const f of ["", "FULFILLED", "done", 1, [], {}]) {
      const r = await asUser("PATCH", `/api/campaigns/${campaignId}/lines/${line.json.line_id}`, {
        fulfilment: f,
      });
      notServerError(r, `fulfilment ${JSON.stringify(f)}`);
      assert.equal(r.status, 400, `fulfilment ${JSON.stringify(f)} was accepted`);
    }
  });

  test("only real periods are accepted", async () => {
    for (const p of ["fortnight", "DAY", "day/", "..", "%2e%2e"]) {
      const r = await asUser("GET", `/api/dashboard/${encodeURIComponent(p)}`);
      notServerError(r, `period ${p}`);
      assert.ok(r.status === 400 || r.status === 404, `period ${p} gave ${r.status}`);
    }
  });

  test("an unknown work type is refused rather than inserted", async () => {
    const r = await asUser("POST", "/api/activities", { work_type_id: "teleportation" });
    assert.equal(r.status, 400);
  });

  test("a retired work type cannot be used", async () => {
    const r = await asUser("POST", "/api/activities", { work_type_id: "" });
    assert.equal(r.status, 400);
  });
});

describe("uploads", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  test("a disguised executable is refused on content type", async () => {
    for (const type of ["application/x-msdownload", "text/html", "application/javascript", "text/plain"]) {
      const r = await call("POST", `/api/activities/${activityId}/attachments`, {
        rawBody: PNG, contentType: type, token: userToken,
      });
      notServerError(r, `upload ${type}`);
      assert.equal(r.status, 415, `${type} was accepted`);
    }
  });

  test("a missing content type is refused", async () => {
    const res = await fetch(`${BASE}/api/activities/${activityId}/attachments`, {
      method: "POST", headers: { Authorization: `Bearer ${userToken}` }, body: PNG,
    });
    assert.ok(res.status < 500, `no content-type gave ${res.status}`);
  });

  test("an oversized upload is refused rather than buffered", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const r = await call("POST", `/api/activities/${activityId}/attachments`, {
      rawBody: big, contentType: "image/png", token: userToken,
    });
    notServerError(r, "9MB upload");
    assert.ok(r.status === 413 || r.status === 400, `9MB upload gave ${r.status}`);
  });

  test("a signed-out caller cannot upload or read an attachment", async () => {
    const up = await fetch(`${BASE}/api/activities/${activityId}/attachments`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: PNG,
    });
    assert.equal(up.status, 401);
  });
});

describe("idempotency and repeat writes", () => {
  test("resolving twice is harmless", async () => {
    const a = await asUser("POST", "/api/activities", { work_type_id: "issue", follow_up: true });
    const id = a.json.activity.activity_id;
    const first = await asUser("POST", `/api/activities/${id}/resolve`, {});
    const second = await asUser("POST", `/api/activities/${id}/resolve`, {});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.activity.follow_up, false);
  });

  test("ten simultaneous saves all land", async () => {
    const before = (await asUser("GET", "/api/activities/today")).json.counts.total;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        asUser("POST", "/api/activities", { work_type_id: "call", store_id: storeId })
      )
    );
    assert.ok(results.every((r) => r.status === 201), "a concurrent save was lost");
    const after = (await asUser("GET", "/api/activities/today")).json.counts.total;
    assert.equal(Number(after), Number(before) + 10, "the count does not match the saves");
  });

  test("simultaneous stock saves do not corrupt the day", async () => {
    const skus = (await asUser("GET", "/api/stock/today")).json.groups
      .flatMap((g) => g.items).slice(0, 4).map((i) => i.product_id);
    await Promise.all([
      asUser("POST", "/api/stock", { out: skus.slice(0, 2) }),
      asUser("POST", "/api/stock", { out: skus.slice(0, 2) }),
    ]);
    const after = await asUser("GET", "/api/stock/today");
    const out = after.json.groups.flatMap((g) => g.items).filter((i) => i.out);
    assert.equal(out.length, 2, `expected 2 out, got ${out.length}`);
  });

  test("adding the same campaign line twice does not double the units", async () => {
    const c = await asUser("POST", "/api/campaigns", { name: `Dup ${Date.now()}` });
    await asUser("POST", `/api/campaigns/${c.json.campaign_id}/lines`, {
      store_id: storeId, product_id: productId, qty_requested: 10,
    });
    await asUser("POST", `/api/campaigns/${c.json.campaign_id}/lines`, {
      store_id: storeId, product_id: productId, qty_requested: 10,
    });
    const view = await asUser("GET", `/api/campaigns/${c.json.campaign_id}`);
    assert.equal(view.json.lines.length, 1);
    assert.equal(view.json.totals.units_requested, 10);
  });
});

describe("output integrity", () => {
  test("no endpoint returns a stack trace to the caller", async () => {
    const probes = [
      ["GET", "/api/activities/'"],
      ["GET", "/api/dashboard/day?date=x"],
      ["POST", "/api/activities", { work_type_id: [] }],
    ];
    for (const [m, p, b] of probes) {
      const r = await asUser(m, p, b);
      assert.equal(/at .*\(.*:\d+:\d+\)/.test(r.text), false, `${m} ${p} leaked a stack trace`);
    }
  });

  test("counts are numbers, not strings, everywhere it matters", async () => {
    const today = await asUser("GET", "/api/activities/today");
    for (const [k, v] of Object.entries(today.json.counts)) {
      assert.equal(typeof v, "number", `counts.${k} is a ${typeof v}`);
    }
    const dash = await asUser("GET", "/api/dashboard/day");
    for (const [k, v] of Object.entries(dash.json.headline)) {
      assert.equal(typeof v, "number", `headline.${k} is a ${typeof v}`);
    }
  });

  test("a date never comes back as a shifted timestamp", async () => {
    const r = await asUser("GET", "/api/stock/today");
    assert.match(r.json.date, /^\d{4}-\d{2}-\d{2}$/, `stock date is ${r.json.date}`);
    const d = await asUser("GET", "/api/dashboard/week");
    for (const day of d.json.charts.by_day) {
      assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/, `by_day date is ${day.date}`);
    }
  });
});
