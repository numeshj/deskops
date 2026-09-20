/**
 * Schema migration. Runs on boot in production so a free-tier deploy needs no
 * shell access — most free hosts do not give you one.
 *
 *   node src/db/migrate.js        (standalone)
 *   import { migrate } from ...   (called from index.js when MIGRATE_ON_BOOT=1)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(here, "../../../db");

/** Split on semicolons that are not inside quotes or comments. */
function statements(sql) {
  const out = [];
  let buf = "";
  let quote = null;
  let lineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      buf += ch;
      continue;
    }
    if (!quote && ch === "-" && next === "-") {
      lineComment = true;
      buf += ch;
      continue;
    }
    if (!quote && (ch === "'" || ch === '"' || ch === "`")) {
      quote = ch;
    } else if (quote && ch === quote && sql[i - 1] !== "\\") {
      quote = null;
    }
    if (ch === ";" && !quote) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

export async function migrate({ quiet = false } = {}) {
  // Files whose name contains "_compat" are opt-in: they are for one specific
  // database engine and must never run automatically. Apply them by hand, or
  // set MIGRATE_INCLUDE=tidb_compat.
  const include = (process.env.MIGRATE_INCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean);
  const files = fs
    .readdirSync(DB_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !f.includes("_compat") || include.some((i) => f.includes(i)))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   VARCHAR(160) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB
  `);

  const [done] = await pool.query("SELECT filename FROM schema_migration");
  const applied = new Set(done.map((d) => d.filename));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DB_DIR, file), "utf8");
    for (const stmt of statements(sql)) {
      await pool.query(stmt);
    }
    await pool.query("INSERT INTO schema_migration (filename) VALUES (?)", [file]);
    ran += 1;
    if (!quiet) console.log(`  applied ${file}`);
  }

  if (!quiet) {
    console.log(ran ? `${ran} migration(s) applied.` : "Schema already up to date.");
  }
  return ran;
}

// Run directly?
//
// Do NOT write this as `file://${process.argv[1]}`. On Windows argv[1] is
// D:\Metta\deskops\server\src\db\migrate.js while import.meta.url is
// file:///D:/Metta/deskops/server/src/db/migrate.js — two slashes, forward
// slashes, drive letter. They never match, so the file silently does nothing
// and exits 0, and the next step fails with "table doesn't exist". pathToFileURL
// does the conversion properly on every platform.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
