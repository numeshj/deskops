import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fs from "node:fs";
import { ping, query, one } from "./db/pool.js";
import { requireAuth, signToken, checkPassword, COOKIE } from "./lib/auth.js";
import activities from "./routes/activities.js";
import stores from "./routes/stores.js";
import vocab from "./routes/vocab.js";
import orders from "./routes/orders.js";
import stock from "./routes/stock.js";
import requests from "./routes/requests.js";
import campaigns from "./routes/campaigns.js";
import products from "./routes/products.js";
import dashboard from "./routes/dashboard.js";
import impact from "./routes/impact.js";
import { onActivity as activityAttachments, onFile as attachmentFiles } from "./routes/attachments.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });

export const app = express();

// every free host (Render, Netlify, Koyeb, Fly) terminates TLS at a proxy —
// without this secure cookies never set and req.protocol is always "http"
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// In single-service mode the SPA is served from this same origin, so CORS is
// not needed at all. Only enable it when the web app is deployed separately.
const SERVE_WEB = process.env.SERVE_WEB !== "0";
if (!SERVE_WEB || process.env.WEB_ORIGIN) {
  app.use(
    cors({
      origin: (process.env.WEB_ORIGIN || "http://localhost:5173").split(","),
      credentials: true,
    })
  );
}

/* ------------------------------------------------------------------ health */

/**
 * Also the keep-warm endpoint. A free uptime pinger hitting this every 10
 * minutes during business hours stops a free host spinning down, which is the
 * difference between a 5-second save and a 50-second one.
 */
app.get("/api/health", async (_req, res) => {
  const started = Date.now();
  const db = await ping().catch(() => false);
  res.json({
    ok: true,
    db,
    db_ms: Date.now() - started,
    uptime_s: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

/* -------------------------------------------------------------------- auth */

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "credentials_required" });
    const user = await one(
      "SELECT user_id, email, display_name, role, password_hash, active FROM app_user WHERE email = ?",
      [String(email).toLowerCase().trim()]
    );
    if (!user || !user.active || !(await checkPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    await query("UPDATE app_user SET last_login_at = NOW() WHERE user_id = ?", [user.user_id]);
    const token = signToken(user);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000,
    });
    res.json({
      token,
      user: { user_id: user.user_id, email: user.email, display_name: user.display_name, role: user.role },
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

/* ------------------------------------------------------------------ routes */

app.use("/api/activities", requireAuth, activities);
app.use("/api/stores", requireAuth, stores);
app.use("/api/vocab", requireAuth, vocab);
app.use("/api/orders", requireAuth, orders);
app.use("/api/stock", requireAuth, stock);
app.use("/api/requests", requireAuth, requests);
app.use("/api/campaigns", requireAuth, campaigns);
app.use("/api/products", requireAuth, products);
app.use("/api/dashboard", requireAuth, dashboard);
app.use("/api/impact", requireAuth, impact);

// Attachments live under two prefixes. They are mounted separately rather than
// at the /api root, so requireAuth never stands in front of an unknown path and
// turns its 404 into a 401.
app.use("/api/activities", requireAuth, activityAttachments);
app.use("/api/attachments", requireAuth, attachmentFiles);

/* --------------------------------------------------------------- api 404 */

// must come before the SPA fallback, or a typo'd endpoint returns index.html
app.use("/api", (_req, res) => res.status(404).json({ error: "unknown_endpoint" }));

/* ------------------------------------------------------ single-service mode */

/**
 * Serving the built React app from this same process means ONE free web
 * service instead of two, no CORS, and no second cold start. Set SERVE_WEB=0
 * on any host that serves web/dist itself (a static CDN in front of the API,
 * e.g. Netlify) — local dev uses Vite's own server either way.
 */
const WEB_DIST = path.resolve(here, "../../web/dist");
if (SERVE_WEB && fs.existsSync(WEB_DIST)) {
  app.use(
    express.static(WEB_DIST, {
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        // hashed assets are immutable; index.html must never be cached
        if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
        // Vite hashes are base64url-ish (index-Da0dOFuu.js), not hex
        else if (/-[A-Za-z0-9_-]{8}\.[a-z]+$/.test(filePath))
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    })
  );
  // client-side routing: anything not under /api falls through to the SPA
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
}

/* ------------------------------------------------------------- error handler */

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || "server_error",
    ...(process.env.NODE_ENV !== "production" && status >= 500 ? { stack: err.stack } : {}),
  });
});
