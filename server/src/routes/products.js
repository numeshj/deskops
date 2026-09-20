import { Router } from "express";
import { query } from "../db/pool.js";

const r = Router();

/** A limit that is always a whole number inside [1, max], whatever arrives. */
function clampLimit(value, fallback, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Product lookup, shared by request lines, the campaign grid and the stock
 * check. Same rule as the store picker: matching has to be forgiving, because
 * she types what the store said, not what the catalogue calls it.
 */
r.get("/", async (req, res, next) => {
  try {
    const raw = String(req.query.q || "").trim();
    // see the note in stores.js: a negative limit returned the whole catalogue
    const limit = clampLimit(req.query.limit, 12, 50);

    if (!raw) {
      const rows = await query(
        `SELECT product_id, brand_group, brand, description, flavour, strength, form
           FROM product WHERE active = 1
          ORDER BY COALESCE(brand_group,'zzz'), description
          LIMIT ?`,
        [String(limit)]
      );
      return res.json({ products: rows, mode: "all" });
    }

    // every word must appear somewhere, in any order: "zyn cool" finds
    // "ZYN Cool Mint 6mg" without her having to know the full name
    const words = raw.split(/\s+/).filter(Boolean).slice(0, 6);
    const where = words
      .map(() => "(description LIKE ? OR brand_group LIKE ? OR brand LIKE ? OR flavour LIKE ?)")
      .join(" AND ");
    const args = words.flatMap((w) => Array(4).fill(`%${w}%`));

    const rows = await query(
      `SELECT product_id, brand_group, brand, description, flavour, strength, form
         FROM product
        WHERE active = 1 AND ${where}
        ORDER BY CASE WHEN description LIKE ? THEN 0 ELSE 1 END, description
        LIMIT ?`,
      [...args, `${raw}%`, String(limit)]
    );
    res.json({ products: rows, mode: "search" });
  } catch (err) { next(err); }
});

/** The brand groups, for the stock check's section headings. */
r.get("/groups", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT COALESCE(brand_group, 'Other') AS name, COUNT(*) AS skus
         FROM product WHERE active = 1
        GROUP BY COALESCE(brand_group, 'Other')
        ORDER BY name`
    );
    res.json({ groups: rows.map((g) => ({ ...g, skus: Number(g.skus) })) });
  } catch (err) { next(err); }
});

export default r;
