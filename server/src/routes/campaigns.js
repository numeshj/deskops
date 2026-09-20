import { Router } from "express";
import { query, one, tx } from "../db/pool.js";
import { newId, rid, orderGeneration } from "../lib/domain.js";

const r = Router();

/**
 * Section 4.8 — allocation campaigns.
 *
 * The Hayati pattern, generalised. A brand releases limited stock, she rings
 * round every store that might want it, records who asked for how much, chases
 * Booker uploads and invoices, and reconciles what actually shipped.
 *
 * In the workbook this was a one-off sheet invented for one brand. The point of
 * this table is that the next allocation does not get a new spreadsheet.
 */

const FULFILMENT = ["pending", "fulfilled", "partial", "unfulfilled"];

function shapeLine(l) {
  return {
    ...l,
    qty_requested: l.qty_requested == null ? null : Number(l.qty_requested),
    qty_fulfilled: l.qty_fulfilled == null ? null : Number(l.qty_fulfilled),
    uploaded_to_booker: !!l.uploaded_to_booker,
    invoice_uploaded: !!l.invoice_uploaded,
  };
}

/* ------------------------------------------------------------------- list */

// The count column is line_count, not "lines": LINES is a reserved word in
// MariaDB and aliasing to it is a parse error, not a warning.
r.get("/", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.campaign_id, c.name, c.brand, c.opened_on, c.closed_on, c.status,
              COUNT(l.line_id)                              AS line_count,
              COUNT(DISTINCT l.store_id)                    AS stores,
              SUM(l.fulfilment = 'fulfilled')               AS fulfilled,
              SUM(l.fulfilment = 'pending')                 AS pending,
              SUM(COALESCE(l.qty_requested, 0))             AS units_requested,
              SUM(COALESCE(l.qty_fulfilled, 0))             AS units_fulfilled,
              SUM(l.uploaded_to_booker = 0)                 AS booker_outstanding
         FROM campaign c
         LEFT JOIN campaign_line l ON l.campaign_id = c.campaign_id
        GROUP BY c.campaign_id, c.name, c.brand, c.opened_on, c.closed_on, c.status
        ORDER BY c.status = 'closed', COALESCE(c.opened_on, '1970-01-01') DESC`
    );
    res.json({
      campaigns: rows.map((c) => ({
        ...c,
        lines: Number(c.line_count || 0),
        stores: Number(c.stores || 0),
        fulfilled: Number(c.fulfilled || 0),
        pending: Number(c.pending || 0),
        units_requested: Number(c.units_requested || 0),
        units_fulfilled: Number(c.units_fulfilled || 0),
        booker_outstanding: Number(c.booker_outstanding || 0),
      })),
    });
  } catch (err) { next(err); }
});

r.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    const id = newId();
    await query(
      `INSERT INTO campaign (campaign_id, name, brand, opened_on, status)
       VALUES (?,?,?,COALESCE(?, CURDATE()),'open')`,
      [id, name.slice(0, 160), (b.brand || "").slice(0, 80) || null, b.opened_on || null]
    );
    res.status(201).json({ campaign_id: id });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------- view */

r.get("/:id", async (req, res, next) => {
  try {
    const campaign = await one(
      "SELECT campaign_id, name, brand, opened_on, closed_on, status FROM campaign WHERE campaign_id = ?",
      [req.params.id]
    );
    if (!campaign) return res.status(404).json({ error: "not_found" });

    const lines = await query(
      `SELECT l.line_id, l.store_id, l.product_id, l.qty_requested, l.qty_fulfilled,
              l.fulfilment, l.order_id, l.uploaded_to_booker, l.invoice_uploaded,
              l.occurred_on, l.contact_outcome,
              s.code_display AS store_code, s.name AS store_name,
              p.description  AS product, p.brand_group,
              o.number       AS order_number,
              (SELECT c.name FROM store_contact c
                WHERE c.store_id = l.store_id
                ORDER BY c.is_primary DESC, c.mention_count DESC LIMIT 1) AS contact_name
         FROM campaign_line l
         LEFT JOIN store s     ON s.store_id = l.store_id
         LEFT JOIN product p   ON p.product_id = l.product_id
         LEFT JOIN order_ref o ON o.order_id = l.order_id
        WHERE l.campaign_id = ?
        ORDER BY s.code, p.description`,
      [req.params.id]
    );

    const totals = {
      lines: lines.length,
      stores: new Set(lines.map((l) => l.store_id).filter(Boolean)).size,
      units_requested: lines.reduce((n, l) => n + Number(l.qty_requested || 0), 0),
      units_fulfilled: lines.reduce((n, l) => n + Number(l.qty_fulfilled || 0), 0),
      booker_outstanding: lines.filter((l) => !l.uploaded_to_booker).length,
      invoice_outstanding: lines.filter((l) => !l.invoice_uploaded).length,
      by_fulfilment: Object.fromEntries(
        FULFILMENT.map((f) => [f, lines.filter((l) => l.fulfilment === f).length])
      ),
    };

    res.json({ campaign, lines: lines.map(shapeLine), totals, fulfilment_options: FULFILMENT });
  } catch (err) { next(err); }
});

r.patch("/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];
    if (typeof b.name === "string" && b.name.trim()) { sets.push("name = ?"); args.push(b.name.trim().slice(0, 160)); }
    if ("brand" in b) { sets.push("brand = ?"); args.push((b.brand || "").slice(0, 80) || null); }
    if (b.status === "open" || b.status === "closed") {
      sets.push("status = ?"); args.push(b.status);
      sets.push("closed_on = ?"); args.push(b.status === "closed" ? (b.closed_on || new Date().toISOString().slice(0, 10)) : null);
    }
    if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });

    const c = await one("SELECT campaign_id FROM campaign WHERE campaign_id = ?", [req.params.id]);
    if (!c) return res.status(404).json({ error: "not_found" });

    args.push(req.params.id);
    await query(`UPDATE campaign SET ${sets.join(", ")} WHERE campaign_id = ?`, args);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ lines */

r.post("/:id/lines", async (req, res, next) => {
  try {
    const b = req.body || {};
    const campaign = await one("SELECT campaign_id FROM campaign WHERE campaign_id = ?", [req.params.id]);
    if (!campaign) return res.status(404).json({ error: "not_found" });
    if (!b.store_id) return res.status(400).json({ error: "store_required" });

    const store = await one("SELECT store_id FROM store WHERE store_id = ?", [b.store_id]);
    if (!store) return res.status(400).json({ error: "unknown_store" });

    let productId = null;
    if (b.product_id) {
      const p = await one("SELECT product_id FROM product WHERE product_id = ?", [b.product_id]);
      productId = p?.product_id || null;
    }

    const qty = b.qty_requested == null || b.qty_requested === "" ? null : Number.parseInt(b.qty_requested, 10);
    if (qty != null && (!Number.isFinite(qty) || qty < 0)) return res.status(400).json({ error: "qty_invalid" });

    // One line per store per SKU. Re-adding the same pair updates it rather
    // than quietly creating a second row that double-counts the units.
    const id = rid("campaignline", `${req.params.id}|${b.store_id}|${productId || ""}`);
    await query(
      `INSERT INTO campaign_line (line_id, campaign_id, store_id, product_id, qty_requested, fulfilment)
       VALUES (?,?,?,?,?, 'pending')
       ON DUPLICATE KEY UPDATE qty_requested = VALUES(qty_requested)`,
      [id, req.params.id, b.store_id, productId, qty]
    );
    res.status(201).json({ line_id: id });
  } catch (err) { next(err); }
});

/** Update one cell of the grid, or record the outcome of a call. */
r.patch("/:id/lines/:lineId", async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];

    for (const key of ["qty_requested", "qty_fulfilled"]) {
      if (key in b) {
        const v = b[key] == null || b[key] === "" ? null : Number.parseInt(b[key], 10);
        if (v != null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: "qty_invalid" });
        sets.push(`${key} = ?`); args.push(v);
      }
    }
    if ("fulfilment" in b) {
      if (!FULFILMENT.includes(b.fulfilment)) {
        return res.status(400).json({ error: "unknown_fulfilment", allowed: FULFILMENT });
      }
      sets.push("fulfilment = ?"); args.push(b.fulfilment);
    }
    for (const flag of ["uploaded_to_booker", "invoice_uploaded"]) {
      if (flag in b) { sets.push(`${flag} = ?`); args.push(b[flag] ? 1 : 0); }
    }
    if ("contact_outcome" in b) {
      sets.push("contact_outcome = ?"); args.push(String(b.contact_outcome || "").slice(0, 160) || null);
      sets.push("occurred_on = CURDATE()");
    }
    if ("order_number" in b) {
      const n = String(b.order_number || "").trim();
      if (!n) { sets.push("order_id = ?"); args.push(null); }
      else {
        const existing = await one("SELECT order_id FROM order_ref WHERE number = ?", [n]);
        let orderId = existing?.order_id;
        if (!orderId) {
          orderId = rid("order", n);
          await query(
            `INSERT INTO order_ref (order_id, number, number_generation, placed_on, order_type)
             VALUES (?,?,?,CURDATE(),'normal')
             ON DUPLICATE KEY UPDATE number = VALUES(number)`,
            // orderGeneration is the single source of truth for this enum
            // ('legacy7' | 'current8' | 'other'). Re-deriving it by hand here
            // wrote values the column does not accept.
            [orderId, n, orderGeneration(n)]
          );
        }
        sets.push("order_id = ?"); args.push(orderId);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });

    const line = await one(
      "SELECT line_id FROM campaign_line WHERE line_id = ? AND campaign_id = ?",
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: "not_found" });

    args.push(req.params.lineId);
    await query(`UPDATE campaign_line SET ${sets.join(", ")} WHERE line_id = ?`, args);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

r.delete("/:id/lines/:lineId", async (req, res, next) => {
  try {
    const line = await one(
      "SELECT line_id FROM campaign_line WHERE line_id = ? AND campaign_id = ?",
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: "not_found" });
    await query("DELETE FROM campaign_line WHERE line_id = ?", [req.params.lineId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- call round */

/**
 * The call list: every store on the campaign that has not been spoken to yet,
 * most-used first, with its contact and phone ready. This is the screen she
 * works down with the phone in her hand.
 */
r.get("/:id/call-round", async (req, res, next) => {
  try {
    const campaign = await one("SELECT campaign_id, name FROM campaign WHERE campaign_id = ?", [req.params.id]);
    if (!campaign) return res.status(404).json({ error: "not_found" });

    const rows = await query(
      `SELECT l.line_id, l.store_id, l.qty_requested, l.fulfilment,
              l.contact_outcome, l.occurred_on,
              s.code_display AS store_code, s.name AS store_name, s.mention_count,
              c.name AS contact_name, c.phone, c.whatsapp
         FROM campaign_line l
         JOIN store s ON s.store_id = l.store_id
         LEFT JOIN store_contact c ON c.contact_id = (
           SELECT contact_id FROM store_contact
            WHERE store_id = l.store_id
            ORDER BY is_primary DESC, mention_count DESC LIMIT 1)
        WHERE l.campaign_id = ?
        ORDER BY l.contact_outcome IS NOT NULL, s.mention_count DESC, s.code`,
      [req.params.id]
    );

    res.json({
      campaign,
      queue: rows.filter((x) => !x.contact_outcome),
      done: rows.filter((x) => x.contact_outcome),
      progress: { total: rows.length, called: rows.filter((x) => x.contact_outcome).length },
    });
  } catch (err) { next(err); }
});

export default r;
