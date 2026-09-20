import { Router } from "express";
import { query, one, tx } from "../db/pool.js";
import { requireAdmin } from "../lib/auth.js";
import { rid, norm, similar } from "../lib/domain.js";

const r = Router();

/**
 * T7 + T8 — work types with their reason chips.
 *
 * Reasons come back ordered by usage_count, so her most common reasons sit
 * first and the order improves on its own as she works. Every type gets an
 * "Other" chip appended by the client; it is not stored as a reason row
 * because it is an escape hatch, not a category.
 */
r.get("/work-types", async (_req, res, next) => {
  try {
    const types = await query(
      `SELECT work_type_id, label, colour, icon, shared_fields, counter_key, sort_order, is_project
         FROM work_type WHERE active = 1 ORDER BY sort_order`
    );
    const reasons = await query(
      `SELECT reason_id, work_type_id, label, usage_count
         FROM reason WHERE active = 1
        ORDER BY work_type_id, usage_count DESC, sort_order, label`
    );
    const grouped = new Map();
    for (const rr of reasons) {
      if (!grouped.has(rr.work_type_id)) grouped.set(rr.work_type_id, []);
      grouped.get(rr.work_type_id).push(rr);
    }
    res.json({
      work_types: types.map((t) => ({
        ...t,
        is_project: !!t.is_project,
        shared_fields: typeof t.shared_fields === "string" ? JSON.parse(t.shared_fields || "[]") : (t.shared_fields || []),
        reasons: grouped.get(t.work_type_id) || [],
      })),
    });
  } catch (err) { next(err); }
});

/* -------------------------------------------------- unlisted work (section 6) */

/** The promotion queue. Anything at 3+ occurrences is ready to become a chip. */
r.get("/unlisted", async (_req, res, next) => {
  try {
    const clusters = await query(
      `SELECT cluster_id, suggested_label, work_type_id, occurrences,
              first_seen, last_seen, status
         FROM unlisted_cluster
        WHERE status IN ('new','watching')
        ORDER BY occurrences DESC, last_seen DESC
        LIMIT 60`
    );
    const [rate] = await query(`
      SELECT
        SUM(reason_id IS NULL AND reason_freetext IS NOT NULL) AS unlisted,
        COUNT(*) AS total
      FROM activity
      WHERE occurred_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `);
    const pct = rate.total ? (Number(rate.unlisted) / Number(rate.total)) * 100 : 0;
    res.json({
      clusters: clusters.map((c) => ({ ...c, ready: c.occurrences >= 3 })),
      health: {
        other_rate: Number(pct.toFixed(1)),
        band: pct < 5 ? "good" : pct <= 10 ? "watch" : "drifting",
        window_days: 30,
        sample: Number(rate.total || 0),
      },
    });
  } catch (err) { next(err); }
});

/**
 * Promote a cluster to a real reason chip.
 *
 * Back-fill is offered but never destructive: the original free text stays on
 * every activity. Promotion ADDS a reason_id, it does not overwrite what she
 * wrote. If the promotion turns out to be wrong, nothing has been lost.
 */
r.post("/unlisted/:id/promote", async (req, res, next) => {
  try {
    const workTypeId = req.body?.work_type_id;
    const backfill = req.body?.backfill !== false;
    if (!workTypeId) return res.status(400).json({ error: "work_type_required" });

    const out = await tx(async (conn) => {
      const [[cluster]] = await conn.execute(
        "SELECT * FROM unlisted_cluster WHERE cluster_id = ?",
        [req.params.id]
      );
      if (!cluster) throw Object.assign(new Error("not_found"), { status: 404 });

      const label = (req.body?.label || cluster.suggested_label).trim().slice(0, 80);
      const reasonId = `${workTypeId}:${norm(label).replace(/ /g, "_").slice(0, 40)}`;

      await conn.execute(
        `INSERT INTO reason (reason_id, work_type_id, label, sort_order, usage_count, created_by)
         VALUES (?,?,?,999,0,?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), active = 1`,
        [reasonId, workTypeId, label, req.user?.user_id || null]
      );
      await conn.execute(
        "INSERT INTO reason_alias (reason_id, alias_text) VALUES (?,?)",
        [reasonId, cluster.norm_text]
      );

      let updated = 0;
      if (backfill) {
        const [rows] = await conn.execute(
          `SELECT a.activity_id, a.reason_freetext
             FROM activity a
            WHERE a.reason_id IS NULL AND a.reason_freetext IS NOT NULL
              AND a.work_type_id = ?
            LIMIT 2000`,
          [workTypeId]
        );
        const matches = rows.filter((row) => similar(row.reason_freetext, cluster.norm_text));
        for (const m of matches) {
          // reason_freetext is deliberately left in place
          await conn.execute("UPDATE activity SET reason_id = ? WHERE activity_id = ?", [reasonId, m.activity_id]);
        }
        updated = matches.length;
        if (updated) {
          await conn.execute("UPDATE reason SET usage_count = usage_count + ? WHERE reason_id = ?", [updated, reasonId]);
        }
      }

      await conn.execute(
        "UPDATE unlisted_cluster SET status = 'promoted', promoted_to = ? WHERE cluster_id = ?",
        [reasonId, req.params.id]
      );
      return { reason_id: reasonId, label, backfilled: updated };
    });

    res.json(out);
  } catch (err) { next(err); }
});

r.post("/unlisted/:id/dismiss", async (req, res, next) => {
  try {
    await query("UPDATE unlisted_cluster SET status = 'dismissed' WHERE cluster_id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------- reason admin (T20) */

/**
 * Adding a reason chip to an EXISTING work type is hers to do.
 *
 * Spec 6.7: "She is the domain expert, so she should never need permission to
 * add a label." This route required an admin, which meant the one person who
 * knows what the work is called had to ask someone else to name it — and the
 * predictable result is that she stops bothering and types it into Other
 * instead, which is the behaviour the whole vocabulary design exists to avoid.
 *
 * Merge, rename and retire stay admin-only: those rewrite history.
 */
r.post("/reasons", async (req, res, next) => {
  try {
    const { work_type_id, label } = req.body || {};
    if (typeof work_type_id !== "string" || typeof label !== "string" || !work_type_id.trim() || !label.trim()) {
      return res.status(400).json({ error: "work_type_and_label_required" });
    }
    const type = await one("SELECT work_type_id FROM work_type WHERE work_type_id = ? AND active = 1", [work_type_id]);
    if (!type) return res.status(400).json({ error: "unknown_work_type" });
    const reasonId = `${work_type_id}:${norm(label).replace(/ /g, "_").slice(0, 40)}`;
    await query(
      `INSERT INTO reason (reason_id, work_type_id, label, created_by)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE label = VALUES(label), active = 1`,
      [reasonId, work_type_id, String(label).slice(0, 80), req.user?.user_id || null]
    );
    res.status(201).json({ reason_id: reasonId });
  } catch (err) { next(err); }
});

r.patch("/reasons/:id", requireAdmin, async (req, res, next) => {
  try {
    const sets = [];
    const args = [];
    if (req.body?.label) { sets.push("label = ?"); args.push(String(req.body.label).slice(0, 80)); }
    if ("active" in (req.body || {})) { sets.push("active = ?"); args.push(req.body.active ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });
    args.push(req.params.id);
    await query(`UPDATE reason SET ${sets.join(", ")} WHERE reason_id = ?`, args);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Merge keeps an alias so historical records and links still resolve. */
r.post("/reasons/:id/merge", requireAdmin, async (req, res, next) => {
  try {
    const target = req.body?.into;
    if (!target) return res.status(400).json({ error: "target_required" });
    await tx(async (conn) => {
      const [[from]] = await conn.execute("SELECT * FROM reason WHERE reason_id = ?", [req.params.id]);
      if (!from) throw Object.assign(new Error("not_found"), { status: 404 });
      await conn.execute("UPDATE activity SET reason_id = ? WHERE reason_id = ?", [target, req.params.id]);
      await conn.execute("UPDATE reason_alias SET reason_id = ? WHERE reason_id = ?", [target, req.params.id]);
      await conn.execute("INSERT INTO reason_alias (reason_id, alias_text) VALUES (?,?)", [target, norm(from.label)]);
      await conn.execute("UPDATE reason SET active = 0 WHERE reason_id = ?", [req.params.id]);
      await conn.execute(
        `UPDATE reason SET usage_count = (SELECT COUNT(*) FROM activity WHERE reason_id = ?) WHERE reason_id = ?`,
        [target, target]
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default r;
