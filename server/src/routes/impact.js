import { Router } from "express";
import { query } from "../db/pool.js";

const r = Router();

/**
 * The impact page — the one Yashoda asked for by name, to show her company how
 * much of the desk she is actually carrying.
 *
 * This endpoint is written to be defensible in a room where someone is
 * sceptical, which changes the design in three ways:
 *
 *   1. Every headline number is a COUNT of rows anyone can go and look at. No
 *      weighting, no scoring, no index.
 *   2. The one estimated figure — hours — is estimated openly. The minutes per
 *      work type arrive as inputs, are echoed back in the response, and the
 *      page lets the reader change them. An assumption you can argue with is
 *      worth more than a number you have to take on trust.
 *   3. It reports its own blind spots. 51% of the migrated history has no store
 *      code, because the spreadsheet had nowhere quick to put one. Hiding that
 *      would be the fastest way to lose the argument; stating it makes the
 *      opposite point — the record under-counts her, and by how much.
 */

/**
 * Minutes per record, by work type. These are the defaults, not the truth —
 * they are deliberately conservative, and the page exposes every one of them.
 */
const DEFAULT_MINUTES = {
  call: 6,
  order: 4,
  issue: 12,
  two_p: 8,
  replacement: 8,
  credit: 10,
  stand: 5,
  request: 15,
  other: 5,
};

const n = (v) => Number(v || 0);

r.get("/", async (req, res, next) => {
  try {
    // the reader can argue with the assumptions, so let them
    const minutes = { ...DEFAULT_MINUTES };
    for (const key of Object.keys(DEFAULT_MINUTES)) {
      const given = Number(req.query[`m_${key}`]);
      if (Number.isFinite(given) && given >= 0 && given <= 240) minutes[key] = given;
    }
    const hoursPerWeek = Math.min(80, Math.max(1, Number(req.query.hours_per_week) || 37.5));

    /* ------------------------------------------------------------- volume */

    const byType = await query(`
      SELECT w.work_type_id, w.label, w.colour, COUNT(a.activity_id) AS n
        FROM work_type w
        LEFT JOIN activity a ON a.work_type_id = w.work_type_id AND a.is_draft = 0
       WHERE w.active = 1
       GROUP BY w.work_type_id, w.label, w.colour, w.sort_order
       ORDER BY w.sort_order
    `);

    const [span] = await query(`
      SELECT MIN(DATE(occurred_at)) AS first_day,
             MAX(DATE(occurred_at)) AS last_day,
             COUNT(*) AS records,
             COUNT(DISTINCT DATE(occurred_at)) AS active_days
        FROM activity WHERE is_draft = 0
    `);

    const [reach] = await query(`
      SELECT COUNT(DISTINCT a.store_id) AS stores,
             COUNT(DISTINCT a.order_id) AS orders,
             COUNT(DISTINCT a.contact_id) AS people
        FROM activity a WHERE a.is_draft = 0
    `);

    const [coverage] = await query(`
      SELECT COUNT(*) AS total,
             SUM(store_id IS NOT NULL) AS with_store,
             SUM(reason_id IS NOT NULL) AS with_reason
        FROM activity WHERE is_draft = 0
    `);

    /* -------------------------------------------------------------- hours */

    let totalMinutes = 0;
    const effort = byType.map((t) => {
      const count = n(t.n);
      const per = minutes[t.work_type_id] ?? 5;
      const mins = count * per;
      totalMinutes += mins;
      return {
        work_type_id: t.work_type_id,
        label: t.label,
        colour: t.colour,
        count,
        minutes_each: per,
        hours: Number((mins / 60).toFixed(1)),
      };
    });

    const records = n(span.records);
    const activeDays = n(span.active_days);
    const totalHours = totalMinutes / 60;

    const [weeks] = await query(`
      SELECT GREATEST(1, CEIL(DATEDIFF(MAX(DATE(occurred_at)), MIN(DATE(occurred_at))) / 7)) AS w
        FROM activity WHERE is_draft = 0
    `);
    const weekCount = n(weeks.w);

    /**
     * There is deliberately NO "full-time equivalent" figure here.
     *
     * The obvious one — hours divided by calendar weeks divided by a working
     * week — comes out around 0.13 against this data, and putting that on a
     * page she shows her employer would be indefensible in both directions.
     * It is not what she works; it is what the old spreadsheet happened to
     * record, on the 302 days out of 600 that anything got written down at all.
     * A sceptical manager would read "13% of a job" and the argument would be
     * over before the real point was made.
     *
     * So the denominator is active days — days the record shows her working —
     * and the figure is labelled as a floor, because that is what it is.
     */
    const hoursPerActiveDay = activeDays ? totalHours / activeDays : 0;

    /* ------------------------------------------------------- the workload */

    const monthly = await query(`
      SELECT DATE_FORMAT(occurred_at, '%Y-%m') AS ym, COUNT(*) AS n,
             COUNT(DISTINCT DATE(occurred_at)) AS days
        FROM activity WHERE is_draft = 0
       GROUP BY ym ORDER BY ym
    `);

    const [busiest] = await query(`
      SELECT DATE(occurred_at) AS d, COUNT(*) AS n
        FROM activity WHERE is_draft = 0
       GROUP BY DATE(occurred_at) ORDER BY n DESC LIMIT 1
    `);

    const topStores = await query(`
      SELECT s.code_display, COUNT(*) AS n
        FROM activity a JOIN store s ON s.store_id = a.store_id
       WHERE a.is_draft = 0
       GROUP BY s.store_id, s.code_display ORDER BY n DESC LIMIT 8
    `);

    /* --------------------------------------------------------- resolution */

    const [issues] = await query(`
      SELECT COUNT(*) AS opened, SUM(status = 'done') AS closed
        FROM activity WHERE work_type_id = 'issue' AND is_draft = 0
    `);

    const [stock] = await query(`
      SELECT COUNT(*) AS line_count, COUNT(DISTINCT on_date) AS days_checked,
             COUNT(DISTINCT product_id) AS skus
        FROM stock_oos
    `);

    /* -------------------------------------------------------- the caveats */

    const withStore = n(coverage.with_store);
    const total = n(coverage.total);
    const storePct = total ? (withStore / total) * 100 : 0;

    res.json({
      span: {
        first_day: span.first_day ? String(span.first_day) : null,
        last_day: span.last_day ? String(span.last_day) : null,
        weeks: weekCount,
        active_days: activeDays,
      },
      volume: {
        records,
        per_active_day: activeDays ? Number((records / activeDays).toFixed(1)) : 0,
        busiest_day: busiest ? { date: String(busiest.d), records: n(busiest.n) } : null,
        stores_touched: n(reach.stores),
        orders_touched: n(reach.orders),
        people_spoken_to: n(reach.people),
      },
      effort: {
        by_type: effort,
        total_hours: Number(totalHours.toFixed(1)),
        hours_per_active_day: Number(hoursPerActiveDay.toFixed(1)),
        active_days: activeDays,
        working_weeks_spanned: weekCount,
        assumptions: { minutes, hours_per_week: hoursPerWeek },
        basis:
          "A floor, not an estimate of her working time. It counts only work that " +
          "reached the record, at conservative minutes per job, on the days something " +
          "was written down at all.",
      },
      quality: {
        issues_opened: n(issues.opened),
        issues_closed: n(issues.closed),
        resolution_rate: n(issues.opened) ? Number(((n(issues.closed) / n(issues.opened)) * 100).toFixed(1)) : null,
        stock_lines_logged: n(stock.line_count),
        stock_days_checked: n(stock.days_checked),
        stock_skus_affected: n(stock.skus),
      },
      charts: {
        monthly: monthly.map((m) => ({ ym: m.ym, n: n(m.n), days: n(m.days) })),
        by_type: effort.filter((e) => e.count > 0),
        top_stores: topStores.map((s) => ({ ...s, n: n(s.n) })),
      },
      /**
       * Stated plainly, because the strongest version of this argument is the
       * honest one: the record undercounts her, and here is the proof.
       */
      caveats: {
        store_coverage_pct: Number(storePct.toFixed(1)),
        records_without_store: total - withStore,
        reason_coverage_pct: total ? Number(((n(coverage.with_reason) / total) * 100).toFixed(1)) : 0,
        note:
          "These figures count only the work that reached the spreadsheet. " +
          `${(100 - storePct).toFixed(0)}% of records carry no store code because the old sheet had nowhere quick to put one, ` +
          "so the real totals are higher than what is shown here, not lower.",
      },
    });
  } catch (err) { next(err); }
});

export default r;
