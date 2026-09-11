#!/usr/bin/env bash
# Manual stage deploy — stand-in for the CI deploy job while the Actions quota
# is exhausted. Mirrors .github/workflows/ci.yml exactly: production env baked
# in as fallback, runtime-config.js generated per-release, junction-swap deploy
# with health check and automatic rollback via deploy/windows/deploy.ps1.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=46.62.247.67
USER=administrator
ROOT="C:/sites/opotrade-ui-new"
BASE_URL="https://opotrade-ui-stage.opofinance.com"
SHA=$(git rev-parse HEAD)

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "FATAL: uncommitted changes — the deployed version stamp must be honest." >&2
  exit 1
fi

export VITE_APP_ENV=production
export VITE_GATEWAY_HTTP_URL="$BASE_URL/gateway"
export VITE_GATEWAY_WS_URL="wss://${BASE_URL#https://}/gateway"
export VITE_CRM_HTTP_URL="$BASE_URL/crm"
export VITE_CONFIRM_TRADES=true
export VITE_ENABLE_ONE_CLICK_TRADING=false
export VITE_ENABLE_LEGACY_AUTH_STORAGE=false
export VITE_APP_VERSION="$SHA"

npm run build

cat > dist/runtime-config.js <<CFG
const runtimeOrigin = window.location.origin;
window.__RUNTIME_CONFIG__ = {
  "VITE_APP_ENV": "production",
  "VITE_GATEWAY_HTTP_URL": runtimeOrigin + "/gateway",
  "VITE_GATEWAY_WS_URL": (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/gateway",
  "VITE_CRM_HTTP_URL": runtimeOrigin + "/crm",
  "VITE_CONFIRM_TRADES": "true",
  "VITE_ENABLE_ONE_CLICK_TRADING": "false",
  "VITE_ENABLE_LEGACY_AUTH_STORAGE": "false",
  "VITE_APP_VERSION": "$SHA",
  "VITE_ALLOWED_HOST_ORIGINS": ""
};
CFG

(cd dist && rm -f ../release.zip && zip -qr ../release.zip .)

# SSHPASS must be exported by the caller; the password never lives in the repo.
sshpass -e scp -q release.zip "$USER@$HOST:$ROOT/incoming/$SHA.zip"
sshpass -e scp -q deploy/windows/deploy.ps1 "$USER@$HOST:$ROOT/deploy.ps1"
sshpass -e ssh "$USER@$HOST" \
  "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ROOT/deploy.ps1 -Archive $ROOT/incoming/$SHA.zip -Version $SHA -HealthUrl $BASE_URL/healthz -Root $ROOT"

curl --fail --show-error --silent --retry 5 --retry-delay 3 "$BASE_URL/healthz" >/dev/null
echo "Deployed $SHA and health check passed."
