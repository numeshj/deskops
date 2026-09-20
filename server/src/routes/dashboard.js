import { Router } from "express";
import { query, one } from "../db/pool.js";

const r = Router();

/**
 * Section 8 — the dashboard.
 *
 * Built last on purpose. A dashboard designed before capture exists gets built
 * around the fields you hope she will fill in; this one is built around the
 * fields she actually fills in, which is why every number below comes from a
 * column the capture screen writes without being asked.
 *
 * Two rules here:
 *
 *   1. Every figure is computed in SQL. The browser gets numbers, not 4,000
 *      rows to add up — which matters on a free tier and matters more on a
 *      phone.
 *   2. Every "done" figure has a "pending" counterpart. A dashboard that only
 *      counts finished work tells her boss she did 40 things and says nothing
 *      about the 12 still sitting on her. Both halves, always.
 *
 * Baselines are the workbook's own numbers (spec section 8), so month one has
 * something to compare against instead of an empty chart.
 */

const BASELINES = {
  calls_per_day: 16.7,
  busiest_month_calls: 388,
  busiest_month_orders: 139,
  issue_resolution_rate: 97.8,
  oos_lines_per_day: 19,
  call_band: [15, 20],
};

/** Resolve the window for a period. Everything else keys off this. */
function windowFor(period, dateParam) {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || "") ? dateParam : null;
  const base = anchor ? `'${anchor}'` : "CURDATE()";
  if (period === "week") {
    // Monday-based, because the desk works Monday to Friday
    return { from: `DATE_SUB(${base}, INTERVAL WEEKDAY(${base}) DAY)`, to: `DATE_ADD(DATE_SUB(${base}, INTERVAL WEEKDAY(${base}) DAY), INTERVAL 6 DAY)` };
  }
  if (period === "month") {
    return { from: `DATE_FORMAT(${base}, '%Y-%m-01')`, to: `LAST_DAY(${base})` };
  }
  return { from: base, to: base };
}

const n = (v) => Number(v || 0);

/**
 * A SKU label short enough to read on a chart and still tell two SKUs apart.
 *
 * Ten rows all reading "IVG 2400 4 In 1 Rechargeabl…" is not a chart. What
 * distinguishes these products is the flavour and strength at the END of the
 * description, which is exactly what truncation eats — so lead with those and
 * keep the brand as context.
 */
function shortSku(p) {
  const bracket = /\[([^\]]+)\]\s*$/.exec(p.description || "");
  const tail = p.flavour || (bracket ? bracket[1] : null);
  const head = p.brand_group || (p.description || "").split(" ").slice(0, 3).join(" ");
  if (tail) return `${head} · ${tail}`.slice(0, 52);
  return (p.description || "").slice(0, 52);
}

/* ----------------------------------------------------------- shared blocks */

/**
 * The first and last day that actually hold records.
 *
 * Without this the dashboard has no way to tell an empty day from a broken
 * one. Loaded from the workbook, "today" is empty and every day back to
 * January 2025 is not, and a screen showing zeroes with no explanation reads
 * as a failed import rather than as a quiet Sunday. The browser uses this to
 * say where the records are and to offer to go there.
 */
async function dataSpan() {
  const [s] = await query(
    "SELECT MIN(DATE(occurred_at)) AS earliest, MAX(DATE(occurred_at)) AS latest, COUNT(*) AS total FROM activity WHERE is_draft = 0"
  );
  return {
    earliest: s.earliest ? String(s.earliest) : null,
    latest: s.latest ? String(s.latest) : null,
    total: n(s.total),
  };
}

/**
 * What is still outstanding, right now.
 *
 * Deliberately NOT scoped to the period. "Still open" means still open today,
 * not "was open during that week" — a backlog is a present-tense fact.
 */
async function pendingNow() {
  const [open] = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(DATEDIFF(CURDATE(), DATE(occurred_at)) = 0) AS today,
      SUM(DATEDIFF(CURDATE(), DATE(occurred_at)) BETWEEN 1 AND 7) AS week,
      SUM(DATEDIFF(CURDATE(), DATE(occurred_at)) > 7) AS older,
      MAX(DATEDIFF(CURDATE(), DATE(occurred_at))) AS oldest_days
    FROM activity
    WHERE follow_up = 1 AND resolved_at IS NULL
  `);
  const [drafts] = await query("SELECT COUNT(*) AS n FROM activity WHERE is_draft = 1");
  const [requests] = await query(`
    SELECT COUNT(*) AS n FROM activity
     WHERE work_type_id = 'request'
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.stage')), 'logged') <> 'restocked'
  `);
  const [campaigns] = await query(`
    SELECT COUNT(*) AS lines_pending,
           COUNT(DISTINCT c.campaign_id) AS campaigns_open,
           SUM(l.uploaded_to_booker = 0) AS booker_outstanding
      FROM campaign c
      LEFT JOIN campaign_line l ON l.campaign_id = c.campaign_id AND l.fulfilment = 'pending'
     WHERE c.status = 'open'
  `);
  const [oos] = await query(`
    SELECT COUNT(*) AS n FROM stock_oos
     WHERE on_date = (SELECT MAX(on_date) FROM stock_oos)
  `);
  const [stale] = await query(`
    SELECT COUNT(*) AS n FROM (
      SELECT product_id FROM stock_oos
       WHERE on_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY product_id HAVING COUNT(*) >= 7
    ) x
  `);

  return {
    open_items: {
      total: n(open.total),
      today: n(open.today),
      week: n(open.week),
      older: n(open.older),
      oldest_days: n(open.oldest_days),
    },
    drafts: n(drafts.n),
    requests_unfinished: n(requests.n),
    campaigns_open: n(campaigns.campaigns_open),
    campaign_lines_pending: n(campaigns.lines_pending),
    booker_outstanding: n(campaigns.booker_outstanding),
    out_of_stock_now: n(oos.n),
    persistent_oos: n(stale.n),
  };
}

/** The work-type mix for a window, in the vocabulary's own order. */
async function mix(from, to) {
  return (
    await query(
      `SELECT w.work_type_id, w.label, w.colour, COUNT(a.activity_id) AS n
         FROM work_type w
         LEFT JOIN activity a
           ON a.work_type_id = w.work_type_id
          AND DATE(a.occurred_at) BETWEEN ${from} AND ${to}
          AND a.is_draft = 0
        WHERE w.active = 1
        GROUP BY w.work_type_id, w.label, w.colour, w.sort_order
        ORDER BY w.sort_order`
    )
  ).map((x) => ({ ...x, n: n(x.n) }));
}

async function captureSpeed(from, to) {
  const [row] = await query(
    `SELECT ROUND(AVG(capture_seconds), 1) AS average, COUNT(*) AS sample
       FROM activity
      WHERE capture_seconds IS NOT NULL AND DATE(occurred_at) BETWEEN ${from} AND ${to}`
  );
  return { average: row.average === null ? null : Number(row.average), sample: n(row.sample), baseline_seconds: 45 };
}

/* --------------------------------------------------------------------- day */

async function day(from, to) {
  const [counts] = await query(`
    SELECT
      SUM(work_type_id = 'call')  AS calls,
      SUM(work_type_id = 'order') AS orders,
      SUM(work_type_id = 'issue') AS issues,
      SUM(work_type_id IN ('two_p','replacement')) AS replacements,
      SUM(work_type_id = 'stand') AS stands,
      SUM(work_type_id = 'credit') AS credits,
      COUNT(*) AS total
    FROM activity
    WHERE DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  const [issues] = await query(`
    SELECT SUM(status = 'done') AS closed, COUNT(*) AS opened
      FROM activity
     WHERE work_type_id = 'issue' AND DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  // the day's shape, hour by hour
  const hours = await query(`
    SELECT HOUR(occurred_at) AS hour, COUNT(*) AS n
      FROM activity
     WHERE DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
     GROUP BY HOUR(occurred_at) ORDER BY hour
  `);
  const byHour = new Map(hours.map((h) => [Number(h.hour), n(h.n)]));
  const timeline = [];
  for (let h = 7; h <= 19; h += 1) timeline.push({ hour: h, n: byHour.get(h) || 0 });

  const [oos] = await query(
    `SELECT COUNT(*) AS n FROM stock_oos WHERE on_date BETWEEN ${from} AND ${to}`
  );

  return {
    headline: {
      calls: n(counts.calls),
      orders: n(counts.orders),
      issues_opened: n(issues.opened),
      issues_closed: n(issues.closed),
      replacements: n(counts.replacements),
      stands: n(counts.stands),
      credits: n(counts.credits),
      total: n(counts.total),
      out_of_stock_lines: n(oos.n),
    },
    charts: { timeline, mix: await mix(from, to) },
  };
}

/* -------------------------------------------------------------------- week */

async function week(from, to) {
  const byDay = await query(`
    SELECT DATE(occurred_at) AS d, DAYNAME(occurred_at) AS day_name,
           SUM(work_type_id = 'call')  AS calls,
           SUM(work_type_id = 'order') AS orders,
           SUM(work_type_id = 'issue') AS issues,
           COUNT(*) AS total
      FROM activity
     WHERE DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
     GROUP BY DATE(occurred_at), DAYNAME(occurred_at)
     ORDER BY d
  `);

  const callReasons = await query(`
    SELECT COALESCE(rs.label, 'Not categorised') AS label, COUNT(*) AS n
      FROM activity a LEFT JOIN reason rs ON rs.reason_id = a.reason_id
     WHERE a.work_type_id = 'call' AND DATE(a.occurred_at) BETWEEN ${from} AND ${to} AND a.is_draft = 0
     GROUP BY label ORDER BY n DESC LIMIT 8
  `);

  const carriers = await query(`
    SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.carrier')), ''), 'Not recorded') AS carrier,
           COUNT(*) AS n,
           SUM(status = 'done') AS closed
      FROM activity
     WHERE work_type_id = 'issue' AND DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
     GROUP BY carrier ORDER BY n DESC
  `);

  const issueKinds = await query(`
    SELECT COALESCE(rs.label, a.reason_freetext, 'Not categorised') AS label, COUNT(*) AS n
      FROM activity a LEFT JOIN reason rs ON rs.reason_id = a.reason_id
     WHERE a.work_type_id = 'issue' AND DATE(a.occurred_at) BETWEEN ${from} AND ${to} AND a.is_draft = 0
     GROUP BY label ORDER BY n DESC LIMIT 8
  `);

  const topStores = await query(`
    SELECT s.store_id, s.code_display, COUNT(*) AS n
      FROM activity a JOIN store s ON s.store_id = a.store_id
     WHERE DATE(a.occurred_at) BETWEEN ${from} AND ${to} AND a.is_draft = 0
     GROUP BY s.store_id, s.code_display ORDER BY n DESC LIMIT 10
  `);

  const [totals] = await query(`
    SELECT SUM(work_type_id = 'stand')  AS stands,
           SUM(work_type_id = 'credit') AS credits,
           SUM(work_type_id = 'call')   AS calls,
           SUM(work_type_id = 'order')  AS orders,
           SUM(work_type_id = 'issue')  AS issues,
           COUNT(*) AS total
      FROM activity
     WHERE DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  // Median, not mean: one issue that sat open for four months would drag an
  // average somewhere useless.
  const resolved = await query(`
    SELECT DATEDIFF(resolved_at, occurred_at) AS days
      FROM activity
     WHERE resolved_at IS NOT NULL AND DATE(occurred_at) BETWEEN ${from} AND ${to}
     ORDER BY days
  `);
  const median = resolved.length
    ? Number(resolved[Math.floor(resolved.length / 2)].days)
    : null;

  /**
   * Every day of the week, including the quiet ones.
   *
   * GROUP BY only returns days that have rows, so a week with nothing on
   * Monday to Wednesday came back as a two-bar chart starting on Thursday —
   * which reads as a busy week rather than a quiet one. Zero is a fact about
   * the week and has to be drawn.
   */
  const [span] = await query(`SELECT ${from} AS f, ${to} AS t`);
  const found = new Map(byDay.map((d) => [String(d.d), d]));
  const days = [];
  const cursor = new Date(`${String(span.f)}T00:00:00Z`);
  const end = new Date(`${String(span.t)}T00:00:00Z`);
  const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  while (cursor <= end && days.length < 14) {
    const iso = cursor.toISOString().slice(0, 10);
    const row = found.get(iso);
    days.push({
      date: iso,
      day: NAMES[cursor.getUTCDay()],
      calls: n(row?.calls),
      orders: n(row?.orders),
      issues: n(row?.issues),
      total: n(row?.total),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    headline: {
      calls: n(totals.calls),
      orders: n(totals.orders),
      issues: n(totals.issues),
      stands: n(totals.stands),
      credits: n(totals.credits),
      total: n(totals.total),
      median_days_to_resolve: median,
      busiest_day: days.length ? days.reduce((a, b) => (b.total > a.total ? b : a)).day : null,
    },
    charts: {
      by_day: days,
      call_reasons: callReasons.map((x) => ({ ...x, n: n(x.n) })),
      carriers: carriers.map((x) => ({ ...x, n: n(x.n), closed: n(x.closed) })),
      issue_kinds: issueKinds.map((x) => ({ ...x, n: n(x.n) })),
      top_stores: topStores.map((x) => ({ ...x, n: n(x.n) })),
      mix: await mix(from, to),
    },
  };
}

/* ------------------------------------------------------------------- month */

async function month(from, to) {
  // Twelve months of trend, so the current month has something behind it
  const trend = await query(`
    SELECT DATE_FORMAT(occurred_at, '%Y-%m') AS ym,
           SUM(work_type_id = 'call')  AS calls,
           SUM(work_type_id = 'order') AS orders,
           SUM(work_type_id = 'issue') AS issues,
           COUNT(*) AS total
      FROM activity
     WHERE occurred_at >= DATE_SUB(${from}, INTERVAL 11 MONTH)
       AND DATE(occurred_at) <= ${to} AND is_draft = 0
     GROUP BY ym ORDER BY ym
  `);

  const [issues] = await query(`
    SELECT COUNT(*) AS opened, SUM(status = 'done') AS closed
      FROM activity
     WHERE work_type_id = 'issue' AND DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  const [credit] = await query(`
    SELECT COUNT(*) AS n,
           SUM(COALESCE(JSON_EXTRACT(detail, '$.amount_pence'), 0)) AS pence
      FROM activity
     WHERE work_type_id = 'credit' AND DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  const [twoP] = await query(`
    SELECT COUNT(*) AS n FROM activity
     WHERE work_type_id = 'two_p' AND DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  /**
   * GROUP BY the expression, not the alias.
   *
   * `product` already has a column called `brand`, so `GROUP BY brand` bound to
   * that column rather than to this alias — and the chart showed "Zyn" three
   * times, once per nicotine strength, each with part of the total. The alias
   * is now brand_group, which is not a column name in either table.
   */
  const oosByBrand = await query(`
    SELECT COALESCE(p.brand_group, 'Other') AS brand_group, COUNT(*) AS days_out,
           COUNT(DISTINCT p.product_id) AS skus
      FROM stock_oos s JOIN product p ON p.product_id = s.product_id
     WHERE s.on_date BETWEEN ${from} AND ${to}
     GROUP BY COALESCE(p.brand_group, 'Other')
     ORDER BY days_out DESC LIMIT 10
  `);

  const oosBySku = await query(`
    SELECT p.description, p.flavour, p.strength,
           COALESCE(p.brand_group, 'Other') AS brand_group, COUNT(*) AS days_out
      FROM stock_oos s JOIN product p ON p.product_id = s.product_id
     WHERE s.on_date BETWEEN ${from} AND ${to}
     GROUP BY p.product_id, p.description, p.flavour, p.strength, p.brand_group
     ORDER BY days_out DESC LIMIT 10
  `);

  const problemStores = await query(`
    SELECT s.store_id, s.code_display, COUNT(*) AS issues,
           MIN(DATE(a.occurred_at)) AS first_issue
      FROM activity a JOIN store s ON s.store_id = a.store_id
     WHERE a.work_type_id = 'issue' AND DATE(a.occurred_at) BETWEEN ${from} AND ${to}
     GROUP BY s.store_id, s.code_display ORDER BY issues DESC LIMIT 10
  `);

  // "New" means this store had never raised an issue before this window.
  const priorStores = new Set(
    (
      await query(
        `SELECT DISTINCT store_id FROM activity
          WHERE work_type_id = 'issue' AND DATE(occurred_at) < ${from} AND store_id IS NOT NULL`
      )
    ).map((x) => x.store_id)
  );

  const [totals] = await query(`
    SELECT SUM(work_type_id = 'call')  AS calls,
           SUM(work_type_id = 'order') AS orders,
           COUNT(*) AS total
      FROM activity
     WHERE DATE(occurred_at) BETWEEN ${from} AND ${to} AND is_draft = 0
  `);

  const opened = n(issues.opened);
  const closed = n(issues.closed);

  return {
    headline: {
      calls: n(totals.calls),
      orders: n(totals.orders),
      issues_opened: opened,
      issues_closed: closed,
      resolution_rate: opened ? Number(((closed / opened) * 100).toFixed(1)) : null,
      two_p: n(twoP.n),
      credits: n(credit.n),
      credit_value_pence: n(credit.pence),
      total: n(totals.total),
    },
    charts: {
      trend: trend.map((t) => ({
        ym: t.ym,
        calls: n(t.calls),
        orders: n(t.orders),
        issues: n(t.issues),
        total: n(t.total),
      })),
      oos_by_brand: oosByBrand.map((x) => ({ ...x, days_out: n(x.days_out), skus: n(x.skus) })),
      oos_by_sku: oosBySku.map((x) => ({ ...x, days_out: n(x.days_out), short: shortSku(x) })),
      problem_stores: problemStores.map((x) => ({
        ...x,
        issues: n(x.issues),
        is_new: !priorStores.has(x.store_id),
      })),
      mix: await mix(from, to),
    },
  };
}

/* ------------------------------------------------------------------ routes */

r.get("/:period", async (req, res, next) => {
  try {
    const period = ["day", "week", "month"].includes(req.params.period) ? req.params.period : null;
    if (!period) return res.status(400).json({ error: "unknown_period", allowed: ["day", "week", "month"] });

    const w = windowFor(period, req.query.date);
    const [range] = await query(`SELECT ${w.from} AS f, ${w.to} AS t`);

    const body =
      period === "day" ? await day(w.from, w.to)
      : period === "week" ? await week(w.from, w.to)
      : await month(w.from, w.to);

    res.json({
      period,
      range: { from: String(range.f), to: String(range.t) },
      ...body,
      pending: await pendingNow(),
      speed: await captureSpeed(w.from, w.to),
      baselines: BASELINES,
      span: await dataSpan(),
    });
  } catch (err) { next(err); }
});

export default r;
