# syntax=docker/dockerfile:1

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The LICENSED TradingView Charting Library is never committed to this repo:
# every deployment brings its own licence. When the package is absent the
# build still succeeds and the terminal shows a "chart library not installed"
# panel in place of the chart — it never falls back to a public widget.
ARG TRADINGVIEW_SOURCE_DIR=/tradingview
RUN --mount=type=bind,source=.,target=/src,rw \
    if [ -d "$TRADINGVIEW_SOURCE_DIR/charting_library" ]; then \
      node scripts/sync-tradingview-assets.mjs --source="$TRADINGVIEW_SOURCE_DIR"; \
    fi; \
    node scripts/sync-tradingview-assets.mjs --check \
      || echo "WARNING: TradingView Charting Library not installed; building without a chart."

RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

RUN apk add --no-cache tini

COPY --chown=nginx:nginx deploy/nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx deploy/entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
# --chown covers the copied files, not the image's pre-existing html directory;
# the entrypoint writes runtime-config.js there at start, so nginx must own it.
RUN chown nginx:nginx /usr/share/nginx/html

EXPOSE 8080

# nginx runs unprivileged on 8080; the image never needs root at runtime.
USER nginx

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
