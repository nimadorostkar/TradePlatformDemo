# syntax=docker/dockerfile:1
# Runtime-only image for a PREBUILT terminal.
#
# The SPA is built by `deploy/deploy.sh` (or CI) and only dist/ is shipped, so
# the host needs no Node toolchain. This image is frontend/Dockerfile's serve stage
# with the build stage removed; nginx.conf and entrypoint.sh are the same files.
#
# Build context: a directory containing dist/, nginx.conf, entrypoint.sh.

FROM nginx:1.27-alpine
RUN apk add --no-cache tini

COPY --chown=nginx:nginx nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
COPY --chown=nginx:nginx dist /usr/share/nginx/html
# --chown covers the copied files, not the image's pre-existing html directory;
# the entrypoint writes runtime-config.js there at start, so nginx must own it.
RUN chown nginx:nginx /usr/share/nginx/html

EXPOSE 8080
USER nginx
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
