# Berpal — WhatsApp bookkeeping bot. Build: docker build -t berpal .   Run: see DEPLOY.md.
# pg is pure JS (no pg-native), so alpine works; no build toolchain needed.

# --- deps: production node_modules only -------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime ----------------------------------------------------------------------------
FROM node:26-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
# The official image ships a non-root "node" user.
USER node
EXPOSE 3000
# Shallow probe: process up + db reachable (503 → unhealthy). ERPNext/Twilio outages only
# degrade /health, and probing them every 30s would spend Twilio API requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health?deep=0" || exit 1
CMD ["node", "server.js"]
