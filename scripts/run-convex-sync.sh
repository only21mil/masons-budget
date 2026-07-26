#!/usr/bin/env bash
#
# Run the MC2 -> Convex sync in watch mode.
#
# Resolves the repo from this script's own location rather than a hardcoded
# home directory, so it works from any checkout on any machine. Uses whatever
# node is on PATH instead of a Homebrew-specific absolute path.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "run-convex-sync: node is not on PATH" >&2
  exit 127
fi

# SAT-READ-AUTH: the bridge's Convex reads are token-gated once
# ALLOW_TOKENLESS_READ is removed from the deployment. Warn at launch rather
# than letting a long-running watch loop discover it on the first poll. This is
# a warning, not a hard exit, because the permissive cutover phase is a valid
# state to run in. Presence only — the value is never read or echoed here.
if [[ -z "${CONVEX_READ_TOKEN:-}" ]] &&
  ! grep -qE '^[[:space:]]*CONVEX_READ_TOKEN=' .env.local 2>/dev/null; then
  echo "run-convex-sync: warning - CONVEX_READ_TOKEN is not set in the environment or .env.local." >&2
  echo "run-convex-sync: Convex reads will fail once the deployment stops allowing tokenless reads." >&2
fi

exec node scripts/mc2-to-convex.mjs --watch "$@"
