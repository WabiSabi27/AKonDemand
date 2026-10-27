#!/bin/bash
set -euo pipefail
CI=true pnpm install --frozen-lockfile

# Never force through data-loss or rename prompts in unattended setup.
# Drizzle can wait indefinitely even with stdin closed; bound that wait and
# fail explicitly so a human can review the schema instead of losing data.
if timeout --signal=TERM --kill-after=5s 30s \
  pnpm --filter @workspace/db run push </dev/null; then
  # The web export is generated, not checked in. Rebuild it after merges so
  # the static preview uses the same source as Metro and production builds.
  pnpm --filter @workspace/mobile run build-web
  exit 0
else
  status=$?
  if [[ "$status" == 124 || "$status" == 137 ]]; then
    echo "Schema sync timed out. Review the schema diff for an interactive prompt; do not force destructive changes." >&2
  fi
  exit "$status"
fi
