# Single image: builds the React app, then serves it from the Express process.
# One container, one free web service, no CORS, no second cold start.

# ---------- 1. build the web app ----------
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 2. install server deps (production only) ----------
FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 3. runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# curl is only for the healthcheck; tini reaps zombies on free hosts that
# send SIGTERM without a shell
RUN apk add --no-cache curl tini

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY db/ ./db/
COPY --from=web /app/web/dist ./web/dist

# never run as root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 4000
ENV PORT=4000 SERVE_WEB=1 MIGRATE_ON_BOOT=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
