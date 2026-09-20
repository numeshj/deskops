import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { one } from "../db/pool.js";

const SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const TTL = "12h";
export const COOKIE = "deskops_token";

export function signToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role, name: user.display_name },
    SECRET,
    { expiresIn: TTL }
  );
}

export function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function tokenFrom(req) {
  if (req.cookies?.[COOKIE]) return req.cookies[COOKIE];
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

export async function requireAuth(req, res, next) {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: "not_authenticated" });
  try {
    const claims = jwt.verify(token, SECRET);
    const user = await one(
      "SELECT user_id, email, display_name, role, active FROM app_user WHERE user_id = ?",
      [claims.sub]
    );
    if (!user || !user.active) return res.status(401).json({ error: "not_authenticated" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "not_authenticated" });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}
