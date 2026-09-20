import { Router } from "express";
import express from "express";
import crypto from "node:crypto";
import { query, one } from "../db/pool.js";
import { newId } from "../lib/domain.js";

// Two routers, not one mounted at the API root.
//
// Mounting at "/api" put requireAuth in front of EVERY /api path, so an
// unknown endpoint answered 401 instead of the documented 404 - a caller
// debugging a typo'd URL would be told to log in. Scope them properly.
const onActivity = Router();   // /api/activities/:id/attachments
const onFile = Router();       // /api/attachments/:id

/**
 * The dead "Pictures" column, done properly.
 *
 * In the workbook this column existed and was empty — there was nowhere for a
 * photo to go, so she stopped trying. A stand sent to a store, a damaged
 * pallet, a wrong label: the photo IS the record, and a row saying "sent
 * stand" without it settles no argument later.
 *
 * Bytes go in the database rather than on disk. Free hosting wipes the
 * filesystem on every redeploy and spin-down, so a photo written to disk would
 * quietly disappear within the week. See db/002_phase2.sql.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

/** List what is attached to an activity. Never returns the bytes. */
onActivity.get("/:id/attachments", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT attachment_id, file_key, mime, bytes, caption, uploaded_at
         FROM activity_attachment WHERE activity_id = ? ORDER BY uploaded_at`,
      [req.params.id]
    );
    res.json({
      attachments: rows.map((a) => ({
        ...a,
        bytes: Number(a.bytes || 0),
        url: `/api/attachments/${a.attachment_id}`,
      })),
    });
  } catch (err) { next(err); }
});

/**
 * Upload.
 *
 * The body is the file itself, with its type in Content-Type — no multipart
 * parser, which means no extra dependency to install on a machine where npm
 * may well be blocked. The filename and caption ride in the query string.
 */
onActivity.post(
  "/:id/attachments",
  express.raw({ type: () => true, limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED.has(mime)) {
        return res.status(415).json({ error: "unsupported_type", allowed: [...ALLOWED] });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "empty_body" });
      }
      if (req.body.length > MAX_BYTES) {
        return res.status(413).json({ error: "too_large", max_bytes: MAX_BYTES });
      }

      const act = await one("SELECT activity_id FROM activity WHERE activity_id = ?", [req.params.id]);
      if (!act) return res.status(404).json({ error: "not_found" });

      // file_key is a content hash, so the same photo uploaded twice is obvious
      const hash = crypto.createHash("sha1").update(req.body).digest("hex").slice(0, 32);
      const id = newId();
      const name = String(req.query.name || "").slice(0, 120) || `photo.${mime.split("/")[1]}`;

      await query(
        `INSERT INTO activity_attachment (attachment_id, activity_id, file_key, data, mime, bytes, caption)
         VALUES (?,?,?,?,?,?,?)`,
        [id, req.params.id, `${hash}-${name}`, req.body, mime, req.body.length,
         String(req.query.caption || "").slice(0, 255) || null]
      );

      res.status(201).json({
        attachment_id: id,
        bytes: req.body.length,
        mime,
        url: `/api/attachments/${id}`,
      });
    } catch (err) { next(err); }
  }
);

/** Serve the bytes. */
onFile.get("/:id", async (req, res, next) => {
  try {
    const row = await one(
      "SELECT mime, bytes, data, file_key FROM activity_attachment WHERE attachment_id = ?",
      [req.params.id]
    );
    if (!row || !row.data) return res.status(404).json({ error: "not_found" });

    res.setHeader("Content-Type", row.mime || "application/octet-stream");
    res.setHeader("Content-Length", String(row.data.length));
    // The id is unique per upload and the bytes never change, so this is safe
    // to cache hard. It also keeps a free tier's bandwidth down.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Content-Disposition", `inline; filename="${(row.file_key || "file").replace(/"/g, "")}"`);
    res.end(row.data);
  } catch (err) { next(err); }
});

onFile.delete("/:id", async (req, res, next) => {
  try {
    const row = await one("SELECT attachment_id FROM activity_attachment WHERE attachment_id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    await query("DELETE FROM activity_attachment WHERE attachment_id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export { onActivity, onFile };
