#!/usr/bin/env bash
#
# Linux-safe SwiftPM / SourceKit-LSP helper for Vogel Vault.
#
# This script only touches SwiftPM/SourceKit local caches. It never runs
# xcodebuild, simulator flows, app-target tests, archive/export/upload, or
# signing commands.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/vv-swift-lsp-reset.sh <status|prime|reset>

Commands:
  status   Show Swift, SourceKit-LSP, and local SwiftPM cache state.
  prime    Serialize and run a pure SwiftPM build to refresh local indexing.
  reset    Remove local SwiftPM/SourceKit index caches, then run prime.

Never runs xcodebuild, simulator flows, archive/export/upload, signing changes,
or app-target tests.
EOF
}

status() {
  cd "$ROOT"
  printf 'repo: %s\n' "$ROOT"
  swift --version
  sourcekit-lsp --version 2>/dev/null || true
  if [[ -f .swift-version ]]; then
    printf '.swift-version: %s\n' "$(tr -d '\n' <.swift-version)"
  fi
  find . \
    -name Package.resolved \
    -not -path './.build/*' \
    -print
  du -sh .build 2>/dev/null || true
}

prime() {
  cd "$ROOT"
  mkdir -p .build/vv-swift-check
  flock .build/vv-swift-check/swiftpm.lock swift build --package-path "$ROOT"
}

reset_indexes() {
  cd "$ROOT"
  rm -rf \
    .build/index \
    .build/index-build \
    .build/sourcekit-lsp \
    .build/sourcekit-lsp-index \
    .build/workspace-state.json
}

case "${1:-}" in
  status) status ;;
  prime) prime ;;
  reset)
    reset_indexes
    prime
    ;;
  --help | -h | help | '')
    usage
    ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac
