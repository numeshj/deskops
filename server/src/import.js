/**
 * Ticket T2 — load the migrated CSVs into MySQL.
 *
 * Idempotent: ids are deterministic (sha1 of source identity), so re-running
 * updates rather than duplicating. Safe to run against a partly-loaded db.
 *
 *   node src/import.js ../../migrated
 *
 * Prints a reconciliation table at the end. Those counts MUST match
 * migrated/reconciliation.txt — if one is off by a single row, stop and
 * find out why before building on top of it.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { pool, query } from "./db/pool.js";
import { orderGeneration, displayStore } from "./lib/domain.js";

const DIR = process.argv[2] || path.resolve(process.cwd(), "../migrated");

// Every individual file is optional — a partial migration should still load.
// A wrong directory is not: without this the import "succeeds" with zero rows
// and the app comes up empty with nothing to explain why.
if (!fs.existsSync(path.join(DIR, "activities.csv"))) {
  console.error(`No activities.csv in ${DIR}`);
  console.error("Pass the migrated folder as the first argument, e.g.");
  console.error("  node src/import.js ../migrated");
  process.exit(1);
}

function read(name) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    console.warn(`  (skip) ${name} not found`);
    return [];
  }
  return parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: false,
  });
}

const nz = (v) => (v === "" || v === undefined ? null : v);
const int = (v) => (v === "" || v == null ? null : Number.parseInt(v, 10) || null);
const bool = (v) => (String(v).toLowerCase() === "true" || v === "1" ? 1 : 0);

/** Chunked upsert so a 4,000-row file is a handful of round trips, not 4,000. */
async function bulk(table, cols, rows, build, chunk = 500) {
  if (!rows.length) return 0;
  const updates = cols
    .filter((c) => !c.endsWith("_id") || c === "store_id" || c === "order_id" || c === "product_id")
    .map((c) => `\`${c}\`=VALUES(\`${c}\`)`)
    .join(", ");
  let done = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk).map(build).filter(Boolean);
    if (!slice.length) continue;
    const placeholders = slice.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    const flat = slice.flat();
    const sql =
      `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(",")}) ` +
      `VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updates}`;
    await pool.query(sql, flat);
    done += slice.length;
  }
  return done;
}

// ---------------------------------------------------------------- work types

const WORK_TYPES = [
  ["call", "Call", "#2a78d6", "phone", '["store","contact"]', "calls", 1],
  ["order", "Order placed", "#eb6834", "cart", '["store","order"]', "orders", 2],
  ["issue", "Delivery issue", "#1baf7a", "truck", '["store","order","carrier"]', "issues", 3],
  ["two_p", "2p replacement", "#eda100", "refresh", '["order","related_order"]', "repl", 4],
  ["replacement", "Faulty / expired", "#e87ba4", "box", '["store","product","qty","order"]', "repl", 5],
  ["credit", "Return / credit", "#7B8E8F", "receipt", '["store","amount"]', null, 6],
  ["stand", "Stand sent", "#4E6162", "display", '["store","order","attachment"]', null, 7],
  ["request", "Customer request", "#0A7A6E", "list", '["store","order","lines"]', null, 8],
  ["other", "Other", "#C2D1D1", "dots", '["store"]', null, 9],
];

async function importWorkTypes() {
  return bulk(
    "work_type",
    ["work_type_id", "label", "colour", "icon", "shared_fields", "counter_key", "sort_order", "is_system"],
    WORK_TYPES,
    (t) => [t[0], t[1], t[2], t[3], t[4], t[5], t[6], 1]
  );
}

// ------------------------------------------------------------------- main

async function main() {
  console.log(`Importing from ${DIR}\n`);
  const counts = {};

  counts.work_type = await importWorkTypes();

  const stores = read("stores.csv");
  counts.store = await bulk(
    "store",
    ["store_id", "code", "code_display", "name", "status", "mention_count"],
    stores,
    (r) => [
      r.store_id,
      r.code,
      r.code_display || displayStore(r.code),
      nz(r.name),
      r.status || "active",
      int(r.mention_count) || 0,
    ]
  );

  const contacts = read("store_contacts.csv");
  counts.store_contact = await bulk(
    "store_contact",
    ["contact_id", "store_id", "name", "role", "phone", "is_primary", "mention_count"],
    contacts,
    (r) =>
      r.store_id
        ? [r.contact_id, r.store_id, r.name, nz(r.role), nz(r.phone), bool(r.is_primary), int(r.mention_count) || 0]
        : null
  );

  const products = read("products.csv");
  counts.product = await bulk(
    "product",
    ["product_id", "brand_group", "brand", "description", "flavour", "strength", "shopify_code"],
    products,
    (r) => [
      r.product_id,
      nz(r.brand_group),
      nz(r.brand),
      r.description.slice(0, 255),
      nz(r.flavour),
      nz(r.strength),
      nz(r.shopify_code),
    ]
  );

  const orders = read("orders.csv");
  const storeIds = new Set(stores.map((s) => s.store_id));
  counts.order_ref = await bulk(
    "order_ref",
    ["order_id", "number", "number_generation", "store_id", "placed_on", "order_type"],
    orders,
    (r) => [
      r.order_id,
      r.number,
      r.number_generation || orderGeneration(r.number),
      storeIds.has(r.store_id) ? r.store_id : null,
      nz(r.placed_on),
      r.order_type || "unknown",
    ]
  );

  // reasons must exist before activities reference them
  const reasons = read("reasons.csv");
  counts.reason = await bulk(
    "reason",
    ["reason_id", "work_type_id", "label", "sort_order", "active"],
    reasons,
    (r) => [r.reason_id, r.activity_type, r.label, int(r.sort_order) || 0, 1]
  );

  const aliases = read("reason_aliases.csv");
  const knownReasons = new Set(reasons.map((r) => r.reason_id));
  await query("DELETE FROM reason_alias");
  counts.reason_alias = await bulk(
    "reason_alias",
    ["reason_id", "alias_text"],
    aliases,
    (r) => (knownReasons.has(r.reason_id) ? [r.reason_id, r.alias_text] : null)
  );

  // activities — the spine
  const acts = read("activities.csv");
  const orderIds = new Set(orders.map((o) => o.order_id));
  const contactIds = new Set(contacts.map((c) => c.contact_id));
  counts.activity = await bulk(
    "activity",
    [
      "activity_id", "work_type_id", "occurred_at", "store_id", "contact_id",
      "contact_freetext", "reason_id", "reason_freetext", "order_id",
      "related_order_id", "channel", "note", "detail", "status", "follow_up",
      "source_sheet", "source_row", "date_flag",
    ],
    acts,
    (r) => {
      let detail = null;
      if (r.detail) {
        try { detail = JSON.stringify(JSON.parse(r.detail)); } catch { detail = JSON.stringify({ raw: r.detail }); }
      }
      return [
        r.activity_id,
        r.type,
        r.occurred_on ? `${r.occurred_on} 09:00:00` : "2026-01-01 09:00:00",
        storeIds.has(r.store_id) ? r.store_id : null,
        contactIds.has(r.contact_id) ? r.contact_id : null,
        nz(r.contact_freetext)?.slice(0, 120) ?? null,
        knownReasons.has(r.reason_id) ? r.reason_id : null,
        nz(r.reason_freetext)?.slice(0, 255) ?? null,
        orderIds.has(r.order_id) ? r.order_id : null,
        orderIds.has(r.related_order_id) ? r.related_order_id : null,
        r.channel || "",
        nz(r.note),
        detail,
        r.status || "done",
        bool(r.follow_up),
        nz(r.source_sheet),
        nz(r.source_row),
        r.date_flag || "",
      ];
    }
  );

  const actIds = new Set(acts.map((a) => a.activity_id));
  const lines = read("activity_lines.csv");
  counts.activity_line = await bulk(
    "activity_line",
    ["line_id", "activity_id", "direction", "description", "qty", "form"],
    lines,
    (r) => (actIds.has(r.activity_id) ? [r.line_id, r.activity_id, r.direction, r.description.slice(0, 255), int(r.qty), nz(r.form)] : null)
  );

  const productIds = new Set(products.map((p) => p.product_id));
  const stock = read("stock_oos.csv");
  counts.stock_oos = await bulk(
    "stock_oos",
    ["product_id", "on_date"],
    stock,
    (r) => (productIds.has(r.product_id) ? [r.product_id, r.on_date] : null),
    1000
  );

  // campaign + lines
  const allocs = read("allocation_lines.csv");
  if (allocs.length) {
    const campaignId = allocs[0].campaign_id;
    await query(
      `INSERT INTO campaign (campaign_id, name, brand, status) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name)`,
      [campaignId, "Hayati Pro Max+ 6K — Jul 2026", "Hayati", "open"]
    );
    counts.campaign_line = await bulk(
      "campaign_line",
      ["line_id", "campaign_id", "store_id", "order_id", "fulfilment", "uploaded_to_booker", "occurred_on"],
      allocs,
      (r) => [
        r.line_id,
        r.campaign_id,
        storeIds.has(r.store_id) ? r.store_id : null,
        orderIds.has(r.order_id) ? r.order_id : null,
        r.fulfilment || "pending",
        bool(r.uploaded_to_booker),
        nz(r.occurred_on),
      ]
    );
  }

  // unmapped free text seeds the promotion queue (section 6.4) rather than
  // starting it empty — these are real recurring jobs with no chip yet.
  const unmapped = read("unmapped_reasons.csv");
  const { rid } = await import("./lib/domain.js");
  const { norm } = await import("./lib/domain.js");
  counts.unlisted_cluster = await bulk(
    "unlisted_cluster",
    ["cluster_id", "suggested_label", "norm_text", "occurrences", "status"],
    unmapped,
    (r) => {
      const n = norm(r.raw_text);
      if (!n) return null;
      const occ = int(r.occurrences) || 1;
      return [rid("cluster", n), r.raw_text.slice(0, 160), n.slice(0, 160), occ, occ >= 3 ? "new" : "watching"];
    }
  );

  // reason usage counts drive chip order, so derive them from real history
  await query(`
    UPDATE reason r
    LEFT JOIN (
      SELECT reason_id, COUNT(*) AS n FROM activity WHERE reason_id IS NOT NULL GROUP BY reason_id
    ) a ON a.reason_id = r.reason_id
    SET r.usage_count = COALESCE(a.n, 0)
  `);

  // Report what is IN the table, not how many rows were sent to it. Those two
  // numbers differ wherever ids are deterministic and two source rows normalise
  // to the same thing: unmapped_reasons.csv has 672 phrases but only 668
  // distinct normalised forms, so "672" here sent anyone following the
  // reconciliation instructions hunting a discrepancy that was correct
  // behaviour. Where they differ the line now says so.
  console.log("Loaded\n" + "-".repeat(46));
  for (const [k, v] of Object.entries(counts)) {
    let actual = v;
    try {
      const [row] = await query(`SELECT COUNT(*) AS n FROM \`${k}\``);
      actual = Number(row.n);
    } catch { /* not a table we can count - fall back to the sent count */ }
    // Only a SHORTFALL is a merge. A surplus means the table already held rows
    // from earlier runs or from the app itself, which is not a discrepancy to
    // hunt — saying "-390 merged" sent someone looking for a bug that was a
    // previous test run.
    const note =
      actual < v ? `   (${v} rows read, ${v - actual} merged by normalisation)`
      : actual > v ? `   (${v} rows read, ${actual - v} already present)`
      : "";
    console.log(`  ${k.padEnd(20)} ${String(actual).padStart(8)}${note}`);
  }

  const checks = await query(`
    SELECT work_type_id AS t, COUNT(*) AS n FROM activity GROUP BY work_type_id ORDER BY n DESC
  `);
  console.log("\nActivities by type\n" + "-".repeat(46));
  for (const c of checks) console.log(`  ${c.t.padEnd(20)} ${String(c.n).padStart(8)}`);

  const [cov] = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(store_id IS NOT NULL) AS with_store,
      SUM(reason_id IS NOT NULL) AS with_reason,
      SUM(follow_up = 1) AS open_items
    FROM activity
  `);
  console.log("\nCoverage\n" + "-".repeat(46));
  console.log(`  store coverage       ${((cov.with_store / cov.total) * 100).toFixed(1)}%  (51.3% expected from the workbook)`);
  console.log(`  reason coverage      ${((cov.with_reason / cov.total) * 100).toFixed(1)}%`);
  console.log(`  open items           ${cov.open_items}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
