import { Router } from "express";
import { query, one, tx } from "../db/pool.js";
import { newId } from "../lib/domain.js";

const r = Router();

/**
 * Section 4.7 — customer requests.
 *
 * A request is an activity of type `request` with line items hanging off it.
 * Two lists, because the store is usually doing both at once: items going back
 * (returned) and items wanted (requested).
 *
 * The workflow stage lives in activity.detail.stage, NOT in activity.status.
 * That is deliberate — status is a fixed enum shared by every work type, and
 * adding a stage to it would be a schema migration every time the process
 * changes. detail is JSON. See the note at the top of 001_schema.sql.
 */

export const STAGES = ["logged", "items_received", "order_placed", "restocked"];

function shapeRequest(row, lines = []) {
  const detail = typeof row.detail === "string" ? safeJson(row.detail) : row.detail;
  const stage = detail?.stage && STAGES.includes(detail.stage) ? detail.stage : "logged";
  return {
    activity_id: row.activity_id,
    occurred_at: row.occurred_at,
    store_id: row.store_id,
    store_code: row.store_code,
    store_name: row.store_name,
    contact_name: row.contact_name,
    order_number: row.order_number,
    note: row.note,
    status: row.status,
    follow_up: !!row.follow_up,
    is_draft: !!row.is_draft,
    stage,
    stage_index: STAGES.indexOf(stage),
    detail: detail || null,
    lines: lines.map((l) => ({ ...l, qty: l.qty == null ? null : Number(l.qty) })),
    returned: lines.filter((l) => l.direction === "returned").length,
    requested: lines.filter((l) => l.direction === "requested").length,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const SELECT_REQUEST = `
  SELECT a.activity_id, a.occurred_at, a.store_id, a.note, a.detail, a.status,
         a.follow_up, a.is_draft,
         s.code_display AS store_code, s.name AS store_name,
         c.name AS contact_name, o.number AS order_number
    FROM activity a
    LEFT JOIN store s         ON s.store_id = a.store_id
    LEFT JOIN store_contact c ON c.contact_id = a.contact_id
    LEFT JOIN order_ref o     ON o.order_id = a.order_id
   WHERE a.work_type_id = 'request'
`;

/** The request list, newest first, optionally filtered by stage. */
r.get("/", async (req, res, next) => {
  try {
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : null;
    const open = req.query.open === "1";

    const rows = await query(`${SELECT_REQUEST} ORDER BY a.occurred_at DESC LIMIT 200`);
    const ids = rows.map((x) => x.activity_id);
    const lines = ids.length
      ? await query(
          `SELECT line_id, activity_id, direction, product_id, description, qty, form
             FROM activity_line WHERE activity_id IN (${ids.map(() => "?").join(",")})`,
          ids
        )
      : [];
    const byActivity = new Map();
    for (const l of lines) {
      if (!byActivity.has(l.activity_id)) byActivity.set(l.activity_id, []);
      byActivity.get(l.activity_id).push(l);
    }

    let items = rows.map((row) => shapeRequest(row, byActivity.get(row.activity_id) || []));
    if (stage) items = items.filter((i) => i.stage === stage);
    if (open) items = items.filter((i) => i.stage !== "restocked");

    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const i of rows.map((row) => shapeRequest(row, byActivity.get(row.activity_id) || []))) {
      counts[i.stage] += 1;
    }

    res.json({ requests: items, counts, stages: STAGES });
  } catch (err) { next(err); }
});

/** One request with its lines. */
r.get("/:id", async (req, res, next) => {
  try {
    const row = await one(`${SELECT_REQUEST} AND a.activity_id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    const lines = await query(
      `SELECT line_id, activity_id, direction, product_id, description, qty, form
         FROM activity_line WHERE activity_id = ? ORDER BY direction, description`,
      [req.params.id]
    );
    res.json({ request: shapeRequest(row, lines) });
  } catch (err) { next(err); }
});

/**
 * Add a line.
 *
 * product_id is optional on purpose: the catalogue has 289 SKUs and the store
 * asks for things that are not in it. A line with a description and no product
 * is a perfectly good line — the same rule as "Other" on the capture screen.
 */
r.post("/:id/lines", async (req, res, next) => {
  try {
    const b = req.body || {};
    const direction = b.direction === "returned" ? "returned" : "requested";
    const description = String(b.description || "").trim();

    const act = await one(
      "SELECT activity_id FROM activity WHERE activity_id = ? AND work_type_id = 'request'",
      [req.params.id]
    );
    if (!act) return res.status(404).json({ error: "not_found" });

    let productId = null;
    let text = description;
    if (b.product_id) {
      const p = await one("SELECT product_id, description, form FROM product WHERE product_id = ?", [b.product_id]);
      if (p) {
        productId = p.product_id;
        if (!text) text = p.description;
      }
    }
    if (!text) return res.status(400).json({ error: "description_or_product_required" });

    const qty = b.qty == null || b.qty === "" ? null : Number.parseInt(b.qty, 10);
    if (qty != null && (!Number.isFinite(qty) || qty < 0)) {
      return res.status(400).json({ error: "qty_invalid" });
    }

    const id = newId();
    await query(
      `INSERT INTO activity_line (line_id, activity_id, direction, product_id, description, qty, form)
       VALUES (?,?,?,?,?,?,?)`,
      [id, req.params.id, direction, productId, text.slice(0, 255), qty,
       b.form === "kit" || b.form === "pod" ? b.form : null]
    );
    res.status(201).json({ line_id: id });
  } catch (err) { next(err); }
});

r.patch("/:id/lines/:lineId", async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];
    if (typeof b.description === "string" && b.description.trim()) {
      sets.push("description = ?"); args.push(b.description.trim().slice(0, 255));
    }
    if ("qty" in b) {
      const qty = b.qty == null || b.qty === "" ? null : Number.parseInt(b.qty, 10);
      if (qty != null && (!Number.isFinite(qty) || qty < 0)) return res.status(400).json({ error: "qty_invalid" });
      sets.push("qty = ?"); args.push(qty);
    }
    if (b.direction === "returned" || b.direction === "requested") {
      sets.push("direction = ?"); args.push(b.direction);
    }
    if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });

    const line = await one(
      "SELECT line_id FROM activity_line WHERE line_id = ? AND activity_id = ?",
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: "not_found" });

    args.push(req.params.lineId);
    await query(`UPDATE activity_line SET ${sets.join(", ")} WHERE line_id = ?`, args);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

r.delete("/:id/lines/:lineId", async (req, res, next) => {
  try {
    const line = await one(
      "SELECT line_id FROM activity_line WHERE line_id = ? AND activity_id = ?",
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: "not_found" });
    await query("DELETE FROM activity_line WHERE line_id = ?", [req.params.lineId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Move a request along the workflow.
 *
 * Any stage can be set, including going backwards — she is the one who knows
 * what actually happened, and a system that refuses to correct itself gets
 * worked around with a note field.
 */
r.post("/:id/stage", async (req, res, next) => {
  try {
    const stage = req.body?.stage;
    if (!STAGES.includes(stage)) {
      return res.status(400).json({ error: "unknown_stage", allowed: STAGES });
    }

    const out = await tx(async (conn) => {
      const [[row]] = await conn.execute(
        "SELECT detail FROM activity WHERE activity_id = ? AND work_type_id = 'request'",
        [req.params.id]
      );
      if (!row) throw Object.assign(new Error("not_found"), { status: 404 });

      const detail = (typeof row.detail === "string" ? safeJson(row.detail) : row.detail) || {};
      const history = Array.isArray(detail.stage_history) ? detail.stage_history : [];
      detail.stage = stage;
      detail.stage_history = [...history, { stage, at: new Date().toISOString() }].slice(-20);

      // Reaching the end closes the follow-up too, so it leaves Open items.
      const done = stage === "restocked";
      await conn.execute(
        `UPDATE activity
            SET detail = ?, follow_up = ?, resolved_at = ${done ? "NOW()" : "resolved_at"}
          WHERE activity_id = ?`,
        [JSON.stringify(detail), done ? 0 : 1, req.params.id]
      );
      return { stage, detail };
    });

    res.json(out);
  } catch (err) { next(err); }
});

export default r;
