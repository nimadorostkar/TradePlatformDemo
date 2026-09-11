#!/usr/bin/env bash
# Fails if any tracked file references the previous operator's domains,
# services or servers. This project must not link to, call, or default to
# any of them — in URLs, API hosts, docs or code. Run by `make check` and CI.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATTERN='opofinance|opotrade|opomtsocket|46\.62\.247\.67'
if hits=$(git grep -nIiE "$PATTERN" -- . ':!frontend/package-lock.json' ':!scripts/check-no-legacy-refs.sh'); then
  echo "Forbidden legacy references found:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "no legacy references"
