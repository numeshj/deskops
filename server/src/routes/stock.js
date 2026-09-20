import { Router } from "express";
import { query, tx } from "../db/pool.js";

const r = Router();

/**
 * Section 4.4 — the daily stock check.
 *
 * The workbook held this as a 509-column grid: one column per day, one row per
 * SKU, ticked by hand. Here only the UNAVAILABLE rows are stored, so a year is
 * about 4,100 rows rather than 132,000 cells.
 *
 * The screen has thirty seconds of her attention, so it opens with yesterday's
 * out-of-stock list already ticked. Most days nothing has changed and she saves
 * without touching anything.
 */

/** Yesterday's list, today's list, and how long each SKU has been out. */
r.get("/today", async (req, res, next) => {
  try {
    const on = String(req.query.date || "").match(/^\d{4}-\d{2}-\d{2}$/)
      ? req.query.date
      : null;

    const [{ d: today }] = await query(on ? "SELECT ? AS d" : "SELECT CURDATE() AS d", on ? [on] : []);

    const products = await query(
      `SELECT product_id, brand_group, brand, description, flavour, strength, form
         FROM product WHERE active = 1
        ORDER BY COALESCE(brand_group, 'zzz'), description`
    );

    const todayOut = await query("SELECT product_id FROM stock_oos WHERE on_date = ?", [today]);
    const prevOut = await query(
      `SELECT product_id FROM stock_oos
        WHERE on_date = (SELECT MAX(on_date) FROM stock_oos WHERE on_date < ?)`,
      [today]
    );

    /**
     * How many consecutive days each SKU has been out, counting back from the
     * most recent check. Done in one pass over the recent history rather than a
     * query per SKU — 259 SKUs on screen at once would otherwise be 259 round
     * trips.
     */
    const history = await query(
      `SELECT product_id, on_date FROM stock_oos
        WHERE on_date >= DATE_SUB(?, INTERVAL 120 DAY) AND on_date <= ?
        ORDER BY product_id, on_date DESC`,
      [today, today]
    );
    const checkDates = await query(
      `SELECT DISTINCT on_date FROM stock_oos
        WHERE on_date >= DATE_SUB(?, INTERVAL 120 DAY) AND on_date <= ?
        ORDER BY on_date DESC`,
      [today, today]
    );
    const order = checkDates.map((c) => String(c.on_date));
    const rank = new Map(order.map((d, i) => [d, i]));

    const byProduct = new Map();
    for (const h of history) {
      if (!byProduct.has(h.product_id)) byProduct.set(h.product_id, []);
      byProduct.get(h.product_id).push(String(h.on_date));
    }
    const daysOut = new Map();
    for (const [pid, dates] of byProduct) {
      // count how many of the most recent checks in a row this SKU appears in
      let streak = 0;
      for (let i = 0; i < order.length; i += 1) {
        if (dates[streak] && rank.get(dates[streak]) === i) streak += 1;
        else break;
      }
      if (streak) daysOut.set(pid, streak);
    }

    const out = new Set(todayOut.map((x) => x.product_id));
    const prev = new Set(prevOut.map((x) => x.product_id));
    const checkedToday = todayOut.length > 0 || order[0] === String(today);

    // Pre-tick yesterday's list when today has not been done yet.
    const ticked = checkedToday ? out : prev;

    const groups = new Map();
    for (const p of products) {
      const key = p.brand_group || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        ...p,
        out: ticked.has(p.product_id),
        was_out: prev.has(p.product_id),
        days_out: daysOut.get(p.product_id) || 0,
      });
    }

    res.json({
      date: String(today),
      already_checked: checkedToday,
      previous_check: order[1] ? order[1] : order[0] && order[0] !== String(today) ? order[0] : null,
      groups: [...groups.entries()].map(([name, items]) => ({
        name,
        items,
        out: items.filter((i) => i.out).length,
      })),
      totals: {
        skus: products.length,
        out: [...ticked].length,
        was_out: prev.size,
      },
    });
  } catch (err) { next(err); }
});

/**
 * Save the day's list.
 *
 * The client sends the full set of product ids that are OUT. The diff against
 * what is already stored is worked out here, so a half-finished save cannot
 * leave the day in a half state and re-sending the same list twice is a no-op.
 */
r.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const on = String(body.date || "").match(/^\d{4}-\d{2}-\d{2}$/) ? body.date : null;
    if (!Array.isArray(body.out)) return res.status(400).json({ error: "out_required" });

    const result = await tx(async (conn) => {
      const [[{ d }]] = await conn.execute(on ? "SELECT ? AS d" : "SELECT CURDATE() AS d", on ? [on] : []);

      const [valid] = body.out.length
        ? await conn.query(
            `SELECT product_id FROM product WHERE active = 1 AND product_id IN (?)`,
            [body.out]
          )
        : [[]];
      const wanted = new Set(valid.map((v) => v.product_id));

      const [existing] = await conn.execute("SELECT product_id FROM stock_oos WHERE on_date = ?", [d]);
      const have = new Set(existing.map((e) => e.product_id));

      const added = [...wanted].filter((p) => !have.has(p));
      const removed = [...have].filter((p) => !wanted.has(p));

      for (const p of added) {
        await conn.execute(
          "INSERT IGNORE INTO stock_oos (product_id, on_date, noted_by) VALUES (?,?,?)",
          [p, d, req.user?.user_id || null]
        );
      }
      if (removed.length) {
        await conn.query("DELETE FROM stock_oos WHERE on_date = ? AND product_id IN (?)", [d, removed]);
      }

      const ignored = body.out.length - wanted.size;
      return { date: String(d), out: wanted.size, added: added.length, removed: removed.length, ignored };
    });

    res.json(result);
  } catch (err) { next(err); }
});

/** What has been out longest — the persistent problems worth chasing. */
r.get("/persistent", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT p.product_id, p.description, p.brand_group,
              COUNT(*) AS days, MAX(s.on_date) AS last_out, MIN(s.on_date) AS first_out
         FROM stock_oos s JOIN product p ON p.product_id = s.product_id
        WHERE s.on_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        GROUP BY p.product_id, p.description, p.brand_group
        ORDER BY days DESC, p.description
        LIMIT 40`
    );
    res.json({ items: rows, window_days: 90 });
  } catch (err) { next(err); }
});

export default r;
