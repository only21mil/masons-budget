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

exec node scripts/mc2-to-convex.mjs --watch "$@"
