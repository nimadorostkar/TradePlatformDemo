#!/usr/bin/env bash
set -euo pipefail

# TradingView's licensed package must never be committed to Git. CI restores it
# from either a private artifact URL or a read-only artifact host.
#
# CREDENTIAL BOUNDARY — this script runs in `verify`, `build` and `e2e`, and
# those jobs run on PULL REQUESTS. It must therefore never be given the
# production deployment key: a pull request can modify this file, so any secret
# reachable from here is a secret a contributor can exfiltrate before review.
#
# Fetching an artifact and publishing a release are different privileges and
# use different credentials:
#
#   TRADINGVIEW_ARTIFACT_URL  — preferred; a private, read-only URL.
#   TRADINGVIEW_SSH_*         — fallback; a READ-ONLY key for the artifact host.
#   DEPLOY_SSH_KEY            — write access to the production web root. Used
#                               ONLY by the deploy job. Never referenced here.

artifact_dir="$(mktemp -d)"
trap 'rm -rf "${artifact_dir}"' EXIT
archive="${artifact_dir}/tradingview.tar.gz"

artifact_path="${TRADINGVIEW_ARTIFACT_PATH:-/C:/sites/opotrade-ui-new/artifacts/tradingview.tar.gz}"

if [[ -n "${TRADINGVIEW_ARTIFACT_URL:-}" ]]; then
  curl --fail --show-error --silent --location \
    "${TRADINGVIEW_ARTIFACT_URL}" \
    --output "${archive}"
elif [[ -n "${TRADINGVIEW_SSH_KEY:-}" ]]; then
  : "${TRADINGVIEW_HOST:?TRADINGVIEW_HOST is required when using TRADINGVIEW_SSH_KEY}"
  : "${TRADINGVIEW_USER:?TRADINGVIEW_USER is required when using TRADINGVIEW_SSH_KEY}"
  : "${TRADINGVIEW_KNOWN_HOSTS:?TRADINGVIEW_KNOWN_HOSTS is required when using TRADINGVIEW_SSH_KEY}"

  install -m 700 -d "${artifact_dir}/ssh"
  printf '%s\n' "${TRADINGVIEW_SSH_KEY}" > "${artifact_dir}/ssh/id_ed25519"
  printf '%s\n' "${TRADINGVIEW_KNOWN_HOSTS}" > "${artifact_dir}/ssh/known_hosts"
  chmod 600 "${artifact_dir}/ssh/id_ed25519" "${artifact_dir}/ssh/known_hosts"

  scp \
    -i "${artifact_dir}/ssh/id_ed25519" \
    -o "UserKnownHostsFile=${artifact_dir}/ssh/known_hosts" \
    "${TRADINGVIEW_USER}@${TRADINGVIEW_HOST}:${artifact_path}" \
    "${archive}"
else
  cat >&2 <<'MESSAGE'
FATAL: no licensed TradingView asset source is configured.

Set ONE of the following in the repository's Actions secrets:

  TRADINGVIEW_ARTIFACT_URL   a private, read-only URL for tradingview.tar.gz
  TRADINGVIEW_SSH_KEY        a READ-ONLY key for the artifact host, together
    + TRADINGVIEW_HOST       with its host, user and known_hosts entry
    + TRADINGVIEW_USER
    + TRADINGVIEW_KNOWN_HOSTS

Do NOT reuse DEPLOY_SSH_KEY here. That key can write to the production web
root, and this script runs on pull requests.
MESSAGE
  exit 1
fi

tar -xzf "${archive}" -C "${artifact_dir}"
npm run tv:sync -- --source="${artifact_dir}"
