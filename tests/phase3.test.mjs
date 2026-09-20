/** Phase 3 — dashboard and impact. */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://127.0.0.1:4100";
let token = null;
async function call(m, p, body) {
  const r = await fetch(BASE + p, { method: m, headers: { ...(body ? {"Content-Type":"application/json"} : {}), Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const get = (p) => call("GET", p);
before(async () => {
  const u = await call("POST", "/api/auth/login", { email: "yashoda@example.com", password: "desk1234" });
  token = u.json.token;
});
describe("dashboard", () => {
  for (const p of ["day","week","month"]) {
    test(`${p} returns a range, headline, charts and pending`, async () => {
      const r = await get(`/api/dashboard/${p}`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.period, p);
      assert.match(r.json.range.from, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(r.json.range.to, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(r.json.headline && r.json.charts && r.json.pending && r.json.baselines);
    });
  }
  test("an unknown period is refused", async () => {
    const r = await get("/api/dashboard/fortnight");
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.allowed, ["day","week","month"]);
  });
  test("a given date pins the window", async () => {
    const r = await get("/api/dashboard/day?date=2026-03-03");
    assert.equal(r.json.range.from, "2026-03-03");
    assert.equal(r.json.range.to, "2026-03-03");
  });
  test("the week runs Monday to Sunday", async () => {
    const r = await get("/api/dashboard/week?date=2026-03-04");
    assert.equal(r.json.range.from, "2026-03-02");
    assert.equal(r.json.range.to, "2026-03-08");
  });
  test("the month is the whole calendar month", async () => {
    const r = await get("/api/dashboard/month?date=2026-02-14");
    assert.equal(r.json.range.from, "2026-02-01");
    assert.equal(r.json.range.to, "2026-02-28");
  });
  test("the day timeline covers desk hours in order", async () => {
    const r = await get("/api/dashboard/day");
    const t = r.json.charts.timeline;
    assert.equal(t.length, 13);
    assert.equal(t[0].hour, 7);
    assert.equal(t[12].hour, 19);
    assert.deepEqual(t.map(x=>x.hour), [...t.map(x=>x.hour)].sort((a,b)=>a-b));
  });
  test("day headline arithmetic agrees with the mix", async () => {
    const r = await get("/api/dashboard/day");
    const mixTotal = r.json.charts.mix.reduce((n,m)=>n+m.n, 0);
    assert.equal(mixTotal, r.json.headline.total, "mix does not add up to the headline total");
  });
  test("week by-day totals agree with the week headline", async () => {
    const r = await get("/api/dashboard/week");
    const calls = r.json.charts.by_day.reduce((n,d)=>n+d.calls,0);
    assert.equal(calls, r.json.headline.calls);
  });
  test("the resolution rate is closed over opened", async () => {
    const r = await get("/api/dashboard/month");
    const h = r.json.headline;
    if (h.issues_opened) {
      assert.equal(h.resolution_rate, Number(((h.issues_closed/h.issues_opened)*100).toFixed(1)));
      assert.ok(h.resolution_rate >= 0 && h.resolution_rate <= 100);
    }
  });
  test("the open-item buckets add up to the total", async () => {
    const r = await get("/api/dashboard/day");
    const o = r.json.pending.open_items;
    assert.equal(o.today + o.week + o.older, o.total);
  });
  test("pending is as-of-now and identical across periods", async () => {
    const a = await get("/api/dashboard/day");
    const b = await get("/api/dashboard/month");
    assert.deepEqual(a.json.pending, b.json.pending);
  });
  test("the twelve-month trend is in date order and no longer than 12", async () => {
    const r = await get("/api/dashboard/month");
    const ym = r.json.charts.trend.map(t=>t.ym);
    assert.deepEqual(ym, [...ym].sort());
    assert.ok(ym.length <= 12, `got ${ym.length} months`);
  });
  test("carrier counts never exceed the issues opened", async () => {
    const r = await get("/api/dashboard/week");
    const carriers = r.json.charts.carriers.reduce((n,c)=>n+c.n,0);
    assert.equal(carriers, r.json.headline.issues);
  });
  test("the week always has seven days, including the quiet ones", async () => {
    const r = await get("/api/dashboard/week?date=2026-09-20");
    const days = r.json.charts.by_day;
    assert.equal(days.length, 7, "a week with no Monday activity must still draw Monday");
    assert.deepEqual(days.map(d=>d.day), ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]);
  });
  test("out-of-stock brands are grouped once each", async () => {
    const r = await get("/api/dashboard/month");
    const names = r.json.charts.oos_by_brand.map(b=>b.brand_group);
    assert.equal(new Set(names).size, names.length,
      "a brand appearing twice means the GROUP BY bound to product.brand, not brand_group");
  });
  test("each out-of-stock SKU gets a label that tells it apart", async () => {
    const r = await get("/api/dashboard/month");
    const shorts = r.json.charts.oos_by_sku.map(s=>s.short);
    assert.ok(shorts.every(s => typeof s === "string" && s.length > 0));
    assert.equal(new Set(shorts).size, shorts.length, "two SKUs share a label");
  });
  test("an empty day returns zeroes, not nulls", async () => {
    const r = await get("/api/dashboard/day?date=2019-01-01");
    assert.equal(r.status, 200);
    assert.equal(r.json.headline.total, 0);
    assert.equal(r.json.charts.timeline.length, 13);
  });
  test("it needs a login", async () => {
    const r = await fetch(BASE + "/api/dashboard/day");
    assert.equal(r.status, 401);
  });
});
describe("impact", () => {
  test("returns span, volume, effort, quality, charts and caveats", async () => {
    const r = await get("/api/impact");
    assert.equal(r.status, 200, r.text);
    for (const k of ["span","volume","effort","quality","charts","caveats"]) assert.ok(r.json[k], `missing ${k}`);
  });
  test("there is deliberately no full-time-equivalent headline", async () => {
    const r = await get("/api/impact");
    assert.equal("full_time_equivalent" in r.json.effort, false,
      "an FTE figure computed off calendar weeks understates her and must not ship");
  });
  test("hours are the sum of count x minutes for every type", async () => {
    const r = await get("/api/impact");
    const e = r.json.effort;
    const mins = e.by_type.reduce((n,t)=>n + t.count * t.minutes_each, 0);
    assert.equal(Math.round(mins/60*10)/10, e.total_hours);
  });
  test("changing an assumption moves the total", async () => {
    const base = await get("/api/impact");
    const doubled = await get("/api/impact?m_call=12");
    assert.ok(doubled.json.effort.total_hours > base.json.effort.total_hours);
    assert.equal(doubled.json.effort.assumptions.minutes.call, 12);
  });
  test("a silly assumption is clamped rather than accepted", async () => {
    const r = await get("/api/impact?m_call=99999");
    assert.equal(r.json.effort.assumptions.minutes.call, 6, "out-of-range minutes should fall back to the default");
  });
  test("hours per active day divides by active days", async () => {
    const r = await get("/api/impact");
    const e = r.json.effort;
    assert.equal(e.hours_per_active_day, Number((e.total_hours/e.active_days).toFixed(1)));
  });
  test("the caveat states the coverage gap in its own words", async () => {
    const r = await get("/api/impact");
    assert.ok(r.json.caveats.store_coverage_pct > 0 && r.json.caveats.store_coverage_pct < 100);
    assert.match(r.json.caveats.note, /higher than what is shown/);
  });
  test("volume figures are whole counts", async () => {
    const r = await get("/api/impact");
    const v = r.json.volume;
    for (const k of ["records","stores_touched","orders_touched","people_spoken_to"]) {
      assert.ok(Number.isInteger(v[k]), `${k} is not a whole count`);
    }
  });
  test("it needs a login", async () => {
    const r = await fetch(BASE + "/api/impact");
    assert.equal(r.status, 401);
  });
});
