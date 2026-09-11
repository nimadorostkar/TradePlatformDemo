#!/bin/sh
set -eu

# Runtime configuration for the static frontend.
#
# The bundle is built once and configured at CONTAINER START, so the same image
# can serve staging and production. Two things are substituted:
#
#   1. The CSP `connect-src` and `frame-ancestors` directives in nginx.conf.
#   2. The external `runtime-config.js`, which the app reads in preference to
#      its build-time VITE_* values. Keeping it external preserves the strict
#      `script-src 'self'` CSP; inline injection would be blocked.
#
# Only PUBLIC values are ever injected here. A secret placed in any of these
# variables would be served to every visitor.

HTML_ROOT="${HTML_ROOT:-/usr/share/nginx/html}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/nginx.conf}"

GATEWAY_HTTP_URL="${GATEWAY_HTTP_URL:-}"
GATEWAY_WS_URL="${GATEWAY_WS_URL:-}"
CRM_HTTP_URL="${CRM_HTTP_URL:-}"
APP_ENV="${APP_ENV:-production}"
BRAND_CONFIG_URL="${BRAND_CONFIG_URL:-}"
APP_VERSION="${APP_VERSION:-0.0.0}"

# Optional overrides. An unset value is emitted as an empty string, which the
# client treats as "not configured" and resolves from its build-time default —
# so leaving these alone is always safe.
DEFAULT_TIMEZONE="${DEFAULT_TIMEZONE:-}"
QUOTE_STALE_AFTER_MS="${QUOTE_STALE_AFTER_MS:-}"
CONFIRM_TRADES="${CONFIRM_TRADES:-}"
ENABLE_ONE_CLICK_TRADING="${ENABLE_ONE_CLICK_TRADING:-}"
ENABLE_LEGACY_AUTH_STORAGE="${ENABLE_LEGACY_AUTH_STORAGE:-}"

# Refuse to start misconfigured rather than serving a terminal that cannot
# reach its gateway.
if [ -z "$GATEWAY_HTTP_URL" ] || [ -z "$GATEWAY_WS_URL" ]; then
  echo "FATAL: GATEWAY_HTTP_URL and GATEWAY_WS_URL must be set." >&2
  exit 1
fi

if [ "$APP_ENV" = "production" ]; then
  case "$GATEWAY_HTTP_URL" in
    https://*) ;;
    *) echo "FATAL: GATEWAY_HTTP_URL must use https:// in production." >&2; exit 1 ;;
  esac
  case "$GATEWAY_WS_URL" in
    wss://*) ;;
    *) echo "FATAL: GATEWAY_WS_URL must use wss:// in production." >&2; exit 1 ;;
  esac
  # The client's own validator refuses this too. Failing at container start
  # surfaces it in the deployment logs instead of in every trader's browser.
  case "$ENABLE_LEGACY_AUTH_STORAGE" in
    true|1)
      echo "FATAL: ENABLE_LEGACY_AUTH_STORAGE must be off in production." >&2
      exit 1 ;;
  esac
fi

# ── CSP ──────────────────────────────────────────────────────────────────────
CSP_CONNECT_SRC="${GATEWAY_HTTP_URL} ${GATEWAY_WS_URL}"
[ -n "$CRM_HTTP_URL" ] && CSP_CONNECT_SRC="${CSP_CONNECT_SRC} ${CRM_HTTP_URL}"
[ -n "$BRAND_CONFIG_URL" ] && CSP_CONNECT_SRC="${CSP_CONNECT_SRC} ${BRAND_CONFIG_URL}"

# Defaults to 'none' — the terminal is not embeddable unless a host origin is
# explicitly allowed, which is the clickjacking protection.
CSP_FRAME_ANCESTORS="${ALLOWED_HOST_ORIGINS:-'none'}"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

CSP_CONNECT_SRC_ESCAPED=$(escape_sed_replacement "$CSP_CONNECT_SRC")
CSP_FRAME_ANCESTORS_ESCAPED=$(escape_sed_replacement "$CSP_FRAME_ANCESTORS")
NGINX_CONF_TMP="/tmp/nginx.conf.$$"
trap 'rm -f "$NGINX_CONF_TMP"' EXIT HUP INT TERM
sed \
  -e "s|\${CSP_CONNECT_SRC}|${CSP_CONNECT_SRC_ESCAPED}|g" \
  -e "s|\${CSP_FRAME_ANCESTORS}|${CSP_FRAME_ANCESTORS_ESCAPED}|g" \
  "$NGINX_CONF" > "$NGINX_CONF_TMP"
# The file itself is owned by nginx, but /etc/nginx is intentionally not.
# Redirecting into the existing file replaces its contents without directory
# write access; `cp` cannot be used here — BusyBox ≥ 1.37 unlinks and
# recreates the destination, which fails with "File exists" in a read-only
# directory.
cat "$NGINX_CONF_TMP" > "$NGINX_CONF"
rm -f "$NGINX_CONF_TMP"
trap - EXIT HUP INT TERM

# ── External runtime config ──────────────────────────────────────────────────
#
# Every VITE_* key the client reads is emitted, so one image can be retuned for
# a new environment without a rebuild. Empty values are ignored by the client
# and fall back to the compiled-in defaults.

# A stray quote or backslash in an operator-supplied value would otherwise
# produce a runtime-config.js that fails to parse — and the app would silently
# fall back to its build-time configuration.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

RUNTIME_JSON=$(cat <<JSON
{"VITE_APP_ENV":"$(json_escape "$APP_ENV")","VITE_GATEWAY_HTTP_URL":"$(json_escape "$GATEWAY_HTTP_URL")","VITE_GATEWAY_WS_URL":"$(json_escape "$GATEWAY_WS_URL")","VITE_CRM_HTTP_URL":"$(json_escape "$CRM_HTTP_URL")","VITE_BRAND_CONFIG_URL":"$(json_escape "$BRAND_CONFIG_URL")","VITE_APP_VERSION":"$(json_escape "$APP_VERSION")","VITE_ALLOWED_HOST_ORIGINS":"$(json_escape "${ALLOWED_HOST_ORIGINS:-}")","VITE_DEFAULT_TIMEZONE":"$(json_escape "$DEFAULT_TIMEZONE")","VITE_QUOTE_STALE_AFTER_MS":"$(json_escape "$QUOTE_STALE_AFTER_MS")","VITE_CONFIRM_TRADES":"$(json_escape "$CONFIRM_TRADES")","VITE_ENABLE_ONE_CLICK_TRADING":"$(json_escape "$ENABLE_ONE_CLICK_TRADING")","VITE_ENABLE_LEGACY_AUTH_STORAGE":"$(json_escape "$ENABLE_LEGACY_AUTH_STORAGE")"}
JSON
)

RUNTIME_CONFIG="$HTML_ROOT/runtime-config.js"
RUNTIME_CONFIG_TMP="$HTML_ROOT/.runtime-config.js.tmp"
printf 'window.__RUNTIME_CONFIG__ = %s;\n' "$RUNTIME_JSON" > "$RUNTIME_CONFIG_TMP"
mv "$RUNTIME_CONFIG_TMP" "$RUNTIME_CONFIG"

echo "Runtime configuration applied (env=${APP_ENV}, version=${APP_VERSION})."
