import { Router } from "express";
import { query, one } from "../db/pool.js";
import { looksLikeOrder } from "../lib/domain.js";

const r = Router();

/** Lookup by number — used by the capture bar to confirm an order exists. */
r.get("/lookup/:number", async (req, res, next) => {
  try {
    const number = String(req.params.number).trim();
    const order = await one(
      `SELECT o.order_id, o.number, o.number_generation, o.placed_on, o.order_type,
              s.store_id, s.code_display AS store_code, s.name AS store_name
         FROM order_ref o LEFT JOIN store s ON s.store_id = o.store_id
        WHERE o.number = ?`,
      [number]
    );
    res.json({ order, known: !!order, well_formed: looksLikeOrder(number) });
  } catch (err) { next(err); }
});

/**
 * T19 — the order view.
 *
 * This is the payoff for making order_ref its own table: an order that lived
 * in four separate sheets with no link between them now resolves to one
 * timeline — placement, every delivery issue against it, the 2p raised to
 * replace it, and the resolution.
 */
r.get("/:id", async (req, res, next) => {
  try {
    const order = await one(
      `SELECT o.order_id, o.number, o.number_generation, o.placed_on, o.order_type,
              o.value_pence, s.store_id, s.code_display AS store_code, s.name AS store_name
         FROM order_ref o LEFT JOIN store s ON s.store_id = o.store_id
        WHERE o.order_id = ? OR o.number = ?`,
      [req.params.id, req.params.id]
    );
    if (!order) return res.status(404).json({ error: "not_found" });

    // everything that points at this order, either as the order or as the 2p
    const timeline = await query(
      `SELECT a.activity_id, a.work_type_id, a.occurred_at, a.status, a.follow_up,
              a.note, a.detail, a.reason_freetext,
              w.label AS work_type_label, w.colour AS work_type_colour,
              rs.label AS reason_label,
              s.code_display AS store_code,
              o.number  AS order_number,
              ro.number AS related_order_number,
              CASE WHEN a.order_id = ? THEN 'primary' ELSE 'replacement_for' END AS link_role
         FROM activity a
         JOIN work_type w ON w.work_type_id = a.work_type_id
         LEFT JOIN reason rs ON rs.reason_id = a.reason_id
         LEFT JOIN store s ON s.store_id = a.store_id
         LEFT JOIN order_ref o ON o.order_id = a.order_id
         LEFT JOIN order_ref ro ON ro.order_id = a.related_order_id
        WHERE a.order_id = ? OR a.related_order_id = ?
        ORDER BY a.occurred_at ASC`,
      [order.order_id, order.order_id, order.order_id]
    );

    // the chain: orders this one replaced, and orders raised to replace it
    // one row per replacement order, even when several activities reference it
    const replacements = await query(
      `SELECT o.number AS replacement_number, o.order_id,
              MIN(a.occurred_at) AS occurred_at,
              GROUP_CONCAT(DISTINCT w.label ORDER BY w.label SEPARATOR ', ') AS raised_as
         FROM activity a
         JOIN order_ref o ON o.order_id = a.related_order_id
         JOIN work_type w ON w.work_type_id = a.work_type_id
        WHERE a.order_id = ? AND a.related_order_id IS NOT NULL
        GROUP BY o.order_id, o.number
        ORDER BY occurred_at`,
      [order.order_id]
    );

    res.json({
      order,
      timeline: timeline.map((t) => ({
        ...t,
        follow_up: !!t.follow_up,
        reason: t.reason_label || t.reason_freetext || null,
      })),
      replacements,
      sheets_merged: [...new Set(timeline.map((t) => t.work_type_label))],
    });
  } catch (err) { next(err); }
});

export default r;
