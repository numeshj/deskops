import crypto from "node:crypto";

/**
 * Deterministic 16-char ids, matching migrate_workbook.py exactly
 * (sha1 of the parts joined by "|", first 16 hex chars). Re-running the
 * import must not create duplicate rows.
 */
export function rid(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function newId() {
  return crypto.randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------- store codes

const FS_EXACT = /^\s*[Ff][Ss]\s*0*(\d{1,4})\s*$/;
const FS_LOOSE = /[Ff][Ss]\s*0*(\d{1,4})/;

/** 'fs 30' | 'FS030' | 'Fs0030'  ->  'FS0030'. null if not a store code. */
export function normStore(value) {
  if (!value) return null;
  const m = FS_EXACT.exec(String(value));
  return m ? "FS" + m[1].padStart(4, "0") : null;
}

/** Pull the first FS code out of free text. */
export function findStore(value) {
  if (!value) return null;
  const m = FS_LOOSE.exec(String(value));
  return m ? "FS" + m[1].padStart(4, "0") : null;
}

export function displayStore(canonical) {
  if (!canonical) return "";
  return "Fs" + canonical.slice(2).replace(/^0+/, "").padStart(3, "0");
}

// -------------------------------------------------------------- order numbers

/**
 * Both generations coexist. Validation is a soft signal for the UI, never a
 * hard block — she must always be able to save what the ERP actually gave her.
 */
export const ORDER_RE = /^(1\d{6}|11\d{6})$/;

export function orderGeneration(number) {
  const n = String(number || "");
  if (/^11\d{6}$/.test(n)) return "current8";
  if (/^1\d{6}$/.test(n)) return "legacy7";
  return "other";
}

export function looksLikeOrder(number) {
  return ORDER_RE.test(String(number || "").trim());
}

// ------------------------------------------------------------ paste detection

const ORDER_IN_TEXT = /\b(11\d{6}|1\d{6})\b/;
const TRACKING_IN_TEXT = /\b(\d{10,16})\b/;

/** T12 — pull structured values out of whatever she pasted. */
export function parsePaste(text) {
  const s = String(text || "");
  const out = {};
  const order = ORDER_IN_TEXT.exec(s);
  if (order) out.orderNumber = order[1];
  const fs = FS_LOOSE.exec(s);
  if (fs) out.storeCode = "FS" + fs[1].padStart(4, "0");
  const tracking = TRACKING_IN_TEXT.exec(s.replace(ORDER_IN_TEXT, ""));
  if (tracking && tracking[1] !== out.orderNumber) out.trackingNo = tracking[1];
  return out;
}

// ---------------------------------------------------- unlisted-work clustering

/** Lowercase, strip punctuation, collapse whitespace. */
export function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["the", "and", "for", "with", "about", "from", "that", "this", "was", "has"]);

function tokens(text) {
  return new Set(norm(text).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
}

/**
 * MySQL has no pg_trgm, so clustering is done in the application layer with
 * token overlap. Same threshold, same effect: "pringle labels missing" and
 * "Pringles label chase" land in one cluster.
 */
export function similar(a, b, threshold = 0.6) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return norm(a) === norm(b);
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / Math.min(A.size, B.size) >= threshold;
}

// ------------------------------------------------------------------ misc

export function toPence(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function fromPence(pence) {
  if (pence == null) return null;
  return Number(pence) / 100;
}

/** Age in whole days from a datetime string to now. */
export function ageDays(when) {
  if (!when) return null;
  const then = new Date(String(when).replace(" ", "T") + "Z");
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}
