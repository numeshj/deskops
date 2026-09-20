import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });

/**
 * One pool for the whole process.
 *
 * dateStrings is on deliberately: every date in this system is a UK calendar
 * date, and letting the driver build JS Date objects in the server's timezone
 * is how "30/04" silently becomes "29/04" overnight. The source workbook
 * already suffered from exactly that class of bug — we are not repeating it.
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "deskops",
  password: process.env.DB_PASSWORD || "deskops",
  database: process.env.DB_NAME || "deskops",
  socketPath: process.env.DB_SOCKET || undefined,

  // Every hosted free MySQL (Aiven, TiDB, Clever Cloud) requires TLS. Their
  // certs are publicly trusted, so the default CA store is enough — we never
  // disable verification.
  ssl: process.env.DB_SSL === "1" ? { minVersion: "TLSv1.2" } : undefined,

  waitForConnections: true,

  // Free database tiers cap connections hard — Aiven's free MySQL allows very
  // few. A big pool here is how a free deploy starts throwing ER_CON_COUNT_ERROR
  // under no real load at all. Keep it small.
  connectionLimit: Number(process.env.DB_POOL || 5),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  connectTimeout: 15_000,
  dateStrings: true,
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function ping() {
  const row = await one("SELECT 1 AS ok");
  return row?.ok === 1;
}

/**
 * Free hosts send SIGTERM on every redeploy and on spin-down. Closing the pool
 * cleanly stops the database seeing a pile of half-dead connections, which on
 * a small free tier is the difference between a clean restart and a locked-out
 * one.
 */
let closing = false;
export async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received — closing database pool`);
  try {
    await pool.end();
  } catch {
    /* already gone */
  }
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => shutdown(sig));
}
