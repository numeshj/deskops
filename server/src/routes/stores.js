import { Router } from "express";
import { query, one } from "../db/pool.js";
import { normStore, newId } from "../lib/domain.js";

const r = Router();

/** Fit a value to its column rather than letting MySQL refuse the insert. */
function fit(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** A limit that is always a whole number inside [1, max], whatever arrives. */
function clampLimit(value, fallback, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * T6 — the store picker.
 *
 * Matches on code OR contact name, because she thinks in both: "335" and
 * "Kugan" must find the same store. With no query it returns the stores she
 * uses most, which is what makes the empty state useful rather than blank.
 */
r.get("/", async (req, res, next) => {
  try {
    const raw = String(req.query.q || "").trim();
    // Math.min alone is not a clamp. limit=-1 passed straight through as
    // LIMIT -1, which returned the WHOLE table — 579 stores down a phone
    // connection, from an unauthenticated-looking query string.
    const limit = clampLimit(req.query.limit, 8, 25);

    if (!raw) {
      const rows = await query(
        `SELECT s.store_id, s.code, s.code_display, s.name, s.mention_count,
                (SELECT c.name FROM store_contact c
                  WHERE c.store_id = s.store_id
                  ORDER BY c.is_primary DESC, c.mention_count DESC LIMIT 1) AS contact_name
           FROM store s
          WHERE s.status = 'active'
          ORDER BY s.mention_count DESC, s.code
          LIMIT ?`,
        [String(limit)]
      );
      return res.json({ stores: rows, mode: "recent" });
    }

    // a bare number is almost always a store code fragment
    const digits = raw.replace(/[^0-9]/g, "");
    const like = `%${raw}%`;
    const codeLike = digits ? `%${digits}%` : "\u0000";
    const canonical = normStore(raw) || (digits ? "FS" + digits.padStart(4, "0") : "\u0000");

    const rows = await query(
      `SELECT DISTINCT s.store_id, s.code, s.code_display, s.name, s.mention_count,
              (SELECT c.name FROM store_contact c
                WHERE c.store_id = s.store_id
                ORDER BY c.is_primary DESC, c.mention_count DESC LIMIT 1) AS contact_name,
              CASE
                WHEN s.code = ?          THEN 0
                WHEN s.code LIKE ?       THEN 1
                WHEN s.code_display LIKE ? THEN 2
                ELSE 3
              END AS rank_score
         FROM store s
         LEFT JOIN store_contact c ON c.store_id = s.store_id
        WHERE s.status <> 'closed'
          AND (s.code = ? OR s.code LIKE ? OR s.code_display LIKE ?
               OR s.name LIKE ? OR c.name LIKE ?)
        ORDER BY rank_score, s.mention_count DESC, s.code
        LIMIT ?`,
      [canonical, codeLike, like, canonical, codeLike, like, like, like, String(limit)]
    );
    res.json({ stores: rows, mode: "search" });
  } catch (err) { next(err); }
});

/** T18 — the store view: one page, the whole history. */
r.get("/:id", async (req, res, next) => {
  try {
    const store = await one(
      `SELECT store_id, code, code_display, name, group_name, status,
              address_line, postcode, delivery_note, mention_count
         FROM store WHERE store_id = ?`,
      [req.params.id]
    );
    if (!store) return res.status(404).json({ error: "not_found" });

    const contacts = await query(
      `SELECT contact_id, name, role, phone, whatsapp, email, is_primary, mention_count
         FROM store_contact WHERE store_id = ?
        ORDER BY is_primary DESC, mention_count DESC`,
      [req.params.id]
    );

    const activities = await query(
      `SELECT a.activity_id, a.work_type_id, a.occurred_at, a.status, a.follow_up,
              a.note, a.reason_freetext, a.detail,
              w.label AS work_type_label, w.colour AS work_type_colour,
              rs.label AS reason_label, o.number AS order_number,
              c.name AS contact_name
         FROM activity a
         JOIN work_type w ON w.work_type_id = a.work_type_id
         LEFT JOIN reason rs ON rs.reason_id = a.reason_id
         LEFT JOIN order_ref o ON o.order_id = a.order_id
         LEFT JOIN store_contact c ON c.contact_id = a.contact_id
        WHERE a.store_id = ?
        ORDER BY a.occurred_at DESC
        LIMIT 500`,
      [req.params.id]
    );

    const [summary] = await query(
      `SELECT COUNT(*) AS total,
              SUM(follow_up = 1 AND resolved_at IS NULL) AS open_items,
              MIN(occurred_at) AS first_seen,
              MAX(occurred_at) AS last_seen
         FROM activity WHERE store_id = ?`,
      [req.params.id]
    );

    const byType = await query(
      `SELECT w.label, a.work_type_id, COUNT(*) AS n
         FROM activity a JOIN work_type w ON w.work_type_id = a.work_type_id
        WHERE a.store_id = ? GROUP BY a.work_type_id, w.label ORDER BY n DESC`,
      [req.params.id]
    );

    const orders = await query(
      `SELECT o.order_id, o.number, o.number_generation, o.placed_on, o.order_type
         FROM order_ref o WHERE o.store_id = ?
        ORDER BY o.placed_on DESC LIMIT 100`,
      [req.params.id]
    );

    res.json({
      store,
      contacts,
      activities: activities.map((a) => ({
        ...a,
        follow_up: !!a.follow_up,
        reason: a.reason_label || a.reason_freetext || null,
      })),
      orders,
      summary: {
        total: Number(summary.total || 0),
        open_items: Number(summary.open_items || 0),
        first_seen: summary.first_seen,
        last_seen: summary.last_seen,
        by_type: byType,
      },
    });
  } catch (err) { next(err); }
});

/** Add a contact — this is how the phone-number map fills itself. */
r.post("/:id/contacts", async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = fit(b.name, 80);
    if (!name) return res.status(400).json({ error: "name_required" });

    // Otherwise an unknown store id hits the foreign key and surfaces as a 500.
    const store = await one("SELECT store_id FROM store WHERE store_id = ?", [req.params.id]);
    if (!store) return res.status(404).json({ error: "not_found" });

    const id = newId();
    await query(
      `INSERT INTO store_contact (contact_id, store_id, name, role, phone, whatsapp, email, is_primary)
       VALUES (?,?,?,?,?,?,?,?)`,
      // fitted to the column widths in 001_schema.sql — an over-long value is
      // a clipped contact, never a 500 and a lost phone number
      [id, req.params.id, name, fit(b.role, 40), fit(b.phone, 32), fit(b.whatsapp, 32),
       fit(b.email, 160), b.is_primary ? 1 : 0]
    );
    res.status(201).json({ contact_id: id });
  } catch (err) { next(err); }
});

export default r;
