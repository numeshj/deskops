import { Router } from "express";
import { pool, query, one, tx } from "../db/pool.js";
import { newId, rid, looksLikeOrder, orderGeneration, norm, similar, parsePaste } from "../lib/domain.js";

const r = Router();

// The enum in 001_schema.sql. Anything else is stored as "" rather than
// rejected — the channel is metadata, never a reason to refuse a record.
const CHANNELS = new Set([
  "call_3cx", "call_cloudtalk", "whatsapp", "email_yash", "email_mfg", "in_person", "system", "",
]);

/* ------------------------------------------------------------------ helpers */

const SELECT_ACTIVITY = `
  SELECT
    a.activity_id, a.work_type_id, a.occurred_at, a.status, a.follow_up,
    a.follow_up_due, a.is_draft, a.note, a.detail, a.channel,
    a.contact_freetext, a.reason_freetext, a.capture_seconds, a.source_ref,
    w.label       AS work_type_label,
    w.colour      AS work_type_colour,
    s.code_display AS store_code,
    s.name         AS store_name,
    c.name         AS contact_name,
    rs.label       AS reason_label,
    o.number       AS order_number,
    ro.number      AS related_order_number
  FROM activity a
  JOIN work_type w         ON w.work_type_id = a.work_type_id
  LEFT JOIN store s        ON s.store_id = a.store_id
  LEFT JOIN store_contact c ON c.contact_id = a.contact_id
  LEFT JOIN reason rs      ON rs.reason_id = a.reason_id
  LEFT JOIN order_ref o    ON o.order_id = a.order_id
  LEFT JOIN order_ref ro   ON ro.order_id = a.related_order_id
`;

function shape(row) {
  return {
    ...row,
    follow_up: !!row.follow_up,
    is_draft: !!row.is_draft,
    detail: typeof row.detail === "string" ? safeJson(row.detail) : row.detail,
    reason: row.reason_label || row.reason_freetext || null,
    unlisted: !row.reason_label && !!row.reason_freetext,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Fit a value to its column.
 *
 * Every VARCHAR in the schema has a width, and MySQL answers an over-long
 * insert with an error, not a truncation. That surfaced as a 500 and a LOST
 * RECORD the moment a long WhatsApp message was pasted into "Describe the
 * work" — which is exactly what the paste box invites. Cutting to fit is the
 * right trade here: a record with a clipped note is worth far more than no
 * record at all, and the capture screen's whole promise is that a save never
 * fails for a reason she cannot see.
 */
function fit(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** Find or create an order by its number. Never rejects an odd number. */
async function resolveOrder(conn, number, storeId, kind = "unknown") {
  const n = String(number || "").trim();
  if (!n) return null;
  const [rows] = await conn.execute("SELECT order_id FROM order_ref WHERE number = ?", [n]);
  if (rows.length) {
    if (storeId) {
      await conn.execute(
        "UPDATE order_ref SET store_id = COALESCE(store_id, ?) WHERE order_id = ?",
        [storeId, rows[0].order_id]
      );
    }
    return rows[0].order_id;
  }
  const id = rid("order", n);
  await conn.execute(
    `INSERT INTO order_ref (order_id, number, number_generation, store_id, placed_on, order_type)
     VALUES (?,?,?,?,CURDATE(),?)
     ON DUPLICATE KEY UPDATE store_id = COALESCE(order_ref.store_id, VALUES(store_id))`,
    [id, n, orderGeneration(n), storeId || null, kind]
  );
  return id;
}

/**
 * Section 6.3 — when a record is saved as "Other" with free text, fold it into
 * a cluster so the promotion queue fills itself. MySQL has no pg_trgm, so the
 * match is done here with token overlap.
 */
async function recordUnlisted(conn, text, workTypeId, activityId) {
  const clean = String(text || "").trim();
  if (!clean) return null;
  const n = norm(clean);
  if (!n) return null;

  const exactId = rid("cluster", n);

  // 1. The same words again. Deterministic id, so this needs no scan.
  const [[exact]] = await conn.execute(
    "SELECT cluster_id FROM unlisted_cluster WHERE cluster_id = ? AND status <> 'dismissed'",
    [exactId]
  );

  // 2. The same job, worded differently. This is the whole point of clustering,
  //    so it must look at EVERY live cluster.
  //
  //    It used to be `ORDER BY occurrences DESC LIMIT 400`. With 674 clusters
  //    seeded from the workbook, of which 621 sit at a single occurrence, that
  //    window silently hid most of them - including, always, a cluster that had
  //    just been created. The effect was that three wordings of one new job
  //    produced two or three clusters, none of which ever reached the promotion
  //    threshold. Volume here is a few dozen rows a day against a table in the
  //    hundreds, so scanning it is cheap and being right matters more.
  let hit = null;
  if (!exact) {
    const [candidates] = await conn.execute(
      `SELECT cluster_id, suggested_label, norm_text, occurrences
         FROM unlisted_cluster
        WHERE status IN ('new','watching')
        ORDER BY last_seen DESC, occurrences DESC
        LIMIT 5000`
    );
    hit = candidates.find((c) => similar(c.norm_text, n)) || null;
  }

  const clusterId = exact?.cluster_id || hit?.cluster_id || exactId;

  if (exact || hit) {
    await conn.execute(
      `UPDATE unlisted_cluster
          SET occurrences = occurrences + 1,
              last_seen = CURDATE(),
              status = IF(occurrences + 1 >= 3, 'new', 'watching')
        WHERE cluster_id = ?`,
      [clusterId]
    );
  } else {
    await conn.execute(
      `INSERT INTO unlisted_cluster (cluster_id, suggested_label, norm_text, work_type_id,
                                     occurrences, first_seen, last_seen, status)
       VALUES (?,?,?,?,1,CURDATE(),CURDATE(),'watching')
       ON DUPLICATE KEY UPDATE occurrences = occurrences + 1, last_seen = CURDATE()`,
      [clusterId, clean.slice(0, 160), n.slice(0, 160), workTypeId]
    );
  }

  await conn.execute(
    "INSERT INTO unlisted_label (raw_text, norm_text, cluster_id, activity_id) VALUES (?,?,?,?)",
    [clean.slice(0, 255), n.slice(0, 255), clusterId, activityId]
  );

  // Read the count back rather than guessing it. The old code returned a
  // hard-coded 1 whenever it took the insert path, so the second time she
  // typed the same phrase the screen still said "seen once".
  const [[row]] = await conn.execute(
    "SELECT suggested_label, occurrences FROM unlisted_cluster WHERE cluster_id = ?",
    [clusterId]
  );
  const occurrences = Number(row?.occurrences ?? 1);
  return {
    cluster_id: clusterId,
    occurrences,
    label: row?.suggested_label || clean,
    ready: occurrences >= 3,
  };
}

/* ------------------------------------------------------------------ create */

/**
 * T10 — the save path. Defaults are applied here, not in the UI, so every
 * client gets them: status done, follow_up false, occurred_at now().
 * The only genuinely required field is work_type_id — a record with just a
 * chip is a valid draft, never an error.
 */
r.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.work_type_id) return res.status(400).json({ error: "work_type_required" });

    const out = await tx(async (conn) => {
      const [[type]] = await conn.execute(
        "SELECT work_type_id FROM work_type WHERE work_type_id = ? AND active = 1",
        [b.work_type_id]
      );
      if (!type) throw Object.assign(new Error("unknown_work_type"), { status: 400 });

      let storeId = null;
      if (b.store_id) {
        const [[s]] = await conn.execute("SELECT store_id FROM store WHERE store_id = ?", [b.store_id]);
        storeId = s?.store_id ?? null;
      }

      const orderId = await resolveOrder(conn, b.order_number, storeId, b.work_type_id === "two_p" ? "two_p" : "normal");
      const relatedId = await resolveOrder(conn, b.related_order_number, storeId, "two_p");

      // a reason that is not in the vocabulary is free text, never an error
      let reasonId = null;
      if (b.reason_id && b.reason_id !== "other") {
        const [[rr]] = await conn.execute(
          "SELECT reason_id FROM reason WHERE reason_id = ? AND active = 1",
          [b.reason_id]
        );
        reasonId = rr?.reason_id ?? null;
      }
      const freeText = reasonId ? null : fit(b.reason_freetext, 255);

      const followUp = b.follow_up === true || b.follow_up === 1;
      const status = followUp && (!b.status || b.status === "done") ? "needs_reply" : (b.status || "done");
      const isDraft = b.is_draft === true || (!storeId && !b.allow_missing_store);

      const id = newId();
      await conn.execute(
        `INSERT INTO activity
          (activity_id, work_type_id, occurred_at, store_id, contact_id, contact_freetext,
           reason_id, reason_freetext, order_id, related_order_id, channel, direction,
           note, detail, status, follow_up, follow_up_due, is_draft, source_ref,
           capture_seconds, created_by)
         VALUES (?,?,COALESCE(?,NOW()),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          b.work_type_id,
          b.occurred_at || null,
          storeId,
          b.contact_id || null,
          fit(b.contact_freetext, 120),
          reasonId,
          freeText,
          orderId,
          relatedId,
          CHANNELS.has(b.channel) ? b.channel : "",
          b.direction === "in" || b.direction === "out" ? b.direction : "",
          fit(b.note, 60000),
          b.detail ? JSON.stringify(b.detail) : null,
          status,
          followUp ? 1 : 0,
          b.follow_up_due || null,
          isDraft ? 1 : 0,
          fit(b.source_ref, 120),
          b.capture_seconds ?? null,
          req.user?.user_id || null,
        ]
      );

      if (reasonId) {
        await conn.execute("UPDATE reason SET usage_count = usage_count + 1 WHERE reason_id = ?", [reasonId]);
      }

      let cluster = null;
      if (freeText) cluster = await recordUnlisted(conn, freeText, b.work_type_id, id);

      return { id, cluster };
    });

    const row = await one(`${SELECT_ACTIVITY} WHERE a.activity_id = ?`, [out.id]);
    res.status(201).json({ activity: shape(row), cluster: out.cluster });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- read */

/** Today's log — T15. */
r.get("/today", async (req, res, next) => {
  try {
    const rows = await query(
      `${SELECT_ACTIVITY} WHERE DATE(a.occurred_at) = CURDATE() AND a.is_draft = 0
       ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 200`
    );
    const [counts] = await query(`
      SELECT
        SUM(work_type_id='call')  AS calls,
        SUM(work_type_id='order') AS orders,
        SUM(work_type_id='issue') AS issues,
        SUM(work_type_id IN ('two_p','replacement')) AS replacements,
        COUNT(*) AS total
      FROM activity
      WHERE DATE(occurred_at) = CURDATE() AND is_draft = 0
    `);
    const [open] = await query("SELECT COUNT(*) AS n FROM activity WHERE follow_up = 1 AND resolved_at IS NULL");
    const [speed] = await query(`
      SELECT ROUND(AVG(capture_seconds),1) AS avg_seconds, COUNT(*) AS n
      FROM activity WHERE capture_seconds IS NOT NULL AND DATE(occurred_at) = CURDATE()
    `);
    res.json({
      activities: rows.map(shape),
      counts: {
        calls: Number(counts.calls || 0),
        orders: Number(counts.orders || 0),
        issues: Number(counts.issues || 0),
        replacements: Number(counts.replacements || 0),
        total: Number(counts.total || 0),
        open: Number(open.n || 0),
      },
      speed: { average: speed.avg_seconds, count: Number(speed.n || 0), baseline: 45 },
    });
  } catch (err) { next(err); }
});

/** Drafts tray — T16. */
r.get("/drafts", async (_req, res, next) => {
  try {
    const rows = await query(
      `${SELECT_ACTIVITY} WHERE a.is_draft = 1 ORDER BY a.occurred_at DESC LIMIT 100`
    );
    res.json({ drafts: rows.map(shape) });
  } catch (err) { next(err); }
});

/** Open items — T17, grouped by age. */
r.get("/open", async (_req, res, next) => {
  try {
    const rows = await query(
      `${SELECT_ACTIVITY}
       WHERE a.follow_up = 1 AND a.resolved_at IS NULL
       ORDER BY a.occurred_at ASC LIMIT 300`
    );
    const items = rows.map((row) => {
      const s = shape(row);
      const days = Math.floor((Date.now() - new Date(String(row.occurred_at).replace(" ", "T") + "Z")) / 86400000);
      return { ...s, age_days: Math.max(0, days) };
    });
    const buckets = { today: 0, week: 0, older: 0 };
    for (const i of items) {
      if (i.age_days === 0) buckets.today += 1;
      else if (i.age_days <= 7) buckets.week += 1;
      else buckets.older += 1;
    }
    res.json({ items, buckets, total: items.length });
  } catch (err) { next(err); }
});

/** One activity, with its lines. */
r.get("/:id", async (req, res, next) => {
  try {
    const row = await one(`${SELECT_ACTIVITY} WHERE a.activity_id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    const lines = await query(
      "SELECT line_id, direction, description, qty, form FROM activity_line WHERE activity_id = ?",
      [req.params.id]
    );
    res.json({ activity: shape(row), lines });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ update */

r.patch("/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const args = [];
    const allow = {
      store_id: "store_id", contact_id: "contact_id", contact_freetext: "contact_freetext",
      reason_id: "reason_id", reason_freetext: "reason_freetext", note: "note",
      status: "status", channel: "channel", follow_up_due: "follow_up_due",
      occurred_at: "occurred_at",
    };
    for (const [k, col] of Object.entries(allow)) {
      if (k in b) { sets.push(`${col} = ?`); args.push(b[k] === "" ? null : b[k]); }
    }
    if ("follow_up" in b) { sets.push("follow_up = ?"); args.push(b.follow_up ? 1 : 0); }
    if ("is_draft" in b) { sets.push("is_draft = ?"); args.push(b.is_draft ? 1 : 0); }
    if ("detail" in b) { sets.push("detail = ?"); args.push(JSON.stringify(b.detail)); }
    if (b.order_number !== undefined) {
      const conn = await pool.getConnection();
      try {
        const orderId = await resolveOrder(conn, b.order_number, b.store_id || null);
        sets.push("order_id = ?"); args.push(orderId);
      } finally { conn.release(); }
    }
    if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });

    // Without this an unknown id updated nothing, then shape(null) threw and the
    // caller got a 500 where it should have got a plain "no such record".
    const exists = await one("SELECT activity_id FROM activity WHERE activity_id = ?", [req.params.id]);
    if (!exists) return res.status(404).json({ error: "not_found" });

    args.push(req.params.id);
    await query(`UPDATE activity SET ${sets.join(", ")} WHERE activity_id = ?`, args);
    const row = await one(`${SELECT_ACTIVITY} WHERE a.activity_id = ?`, [req.params.id]);
    res.json({ activity: shape(row) });
  } catch (err) { next(err); }
});

/** Close an open item. */
r.post("/:id/resolve", async (req, res, next) => {
  try {
    const exists = await one("SELECT activity_id FROM activity WHERE activity_id = ?", [req.params.id]);
    if (!exists) return res.status(404).json({ error: "not_found" });
    await query(
      `UPDATE activity
          SET follow_up = 0, status = 'done', resolved_at = NOW(), note = COALESCE(?, note)
        WHERE activity_id = ?`,
      [req.body?.note || null, req.params.id]
    );
    const row = await one(`${SELECT_ACTIVITY} WHERE a.activity_id = ?`, [req.params.id]);
    res.json({ activity: shape(row) });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------- paste */

/** T12 — the UI posts whatever was pasted, gets back structured fields. */
r.post("/parse-paste", async (req, res, next) => {
  try {
    const found = parsePaste(req.body?.text || "");
    let store = null;
    if (found.storeCode) {
      store = await one(
        "SELECT store_id, code, code_display, name FROM store WHERE code = ?",
        [found.storeCode]
      );
    }
    res.json({ ...found, store, valid_order: found.orderNumber ? looksLikeOrder(found.orderNumber) : null });
  } catch (err) { next(err); }
});

export default r;
