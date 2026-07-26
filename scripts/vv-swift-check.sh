#!/usr/bin/env bash
#
# Linux-safe Vogel Vault Swift preflight.
#
# This script deliberately avoids xcodebuild, simulator actions, archives,
# signing, uploads, and app-target tests. It is meant to shrink the gap between
# Linux static cleanup and Mac/Xcode build verification without crossing the app
# build approval gate.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${VV_SWIFT_CHECK_ARTIFACT_DIR:-$ROOT/.build/vv-swift-check}"
mkdir -p "$ARTIFACT_DIR"

FAILURES=0
WARNINGS=0
PACKAGE_RESOLVED_BEFORE="$ARTIFACT_DIR/package-resolved.before"
PACKAGE_RESOLVED_AFTER="$ARTIFACT_DIR/package-resolved.after"

usage() {
  cat <<'EOF'
Usage: scripts/vv-swift-check.sh [options]

Options:
  --quick              Skip slower style/secret scans.
  --no-secrets         Skip gitleaks scan.
  --no-format          Skip SwiftFormat lint.
  --no-swiftlint       Skip SwiftLint.
  --no-xcodegen        Skip temp XcodeGen generation check.
  --help               Show this help.

Never runs xcodebuild, simulator flows, archive/export/upload, signing changes,
or app-target tests.
EOF
}

QUICK=0
RUN_SECRETS=1
RUN_FORMAT=1
RUN_SWIFTLINT=1
RUN_XCODEGEN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      QUICK=1
      RUN_SECRETS=0
      RUN_FORMAT=0
      ;;
    --no-secrets) RUN_SECRETS=0 ;;
    --no-format) RUN_FORMAT=0 ;;
    --no-swiftlint) RUN_SWIFTLINT=0 ;;
    --no-xcodegen) RUN_XCODEGEN=0 ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '%s\n' "$*"
}

pass() {
  log "PASS $*"
}

fail() {
  FAILURES=$((FAILURES + 1))
  log "FAIL $*"
}

run_capture() {
  local name="$1"
  shift
  local outfile="$ARTIFACT_DIR/$name.log"

  log ""
  log "==> $name"
  "$@" >"$outfile" 2>&1
  local status=$?
  if [[ $status -eq 0 ]]; then
    pass "$name"
  else
    fail "$name (exit $status, log: $outfile)"
    sed -n '1,80p' "$outfile"
  fi
}

require_tool() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    pass "tool: $tool -> $(command -v "$tool")"
  else
    fail "missing tool: $tool"
  fi
}

snapshot_package_resolved() {
  local outfile="$1"
  find . \
    -name Package.resolved \
    -not -path './.build/*' \
    -not -path './DerivedData/*' \
    -print0 |
    sort -z |
    xargs -0 -r sha256sum >"$outfile"
}

cd "$ROOT" || exit 1

log "Vogel Vault Swift preflight"
log "repo: $ROOT"
log "artifacts: $ARTIFACT_DIR"
log "quick: $QUICK"
log ""

for tool in git swift swiftc swiftlint swiftformat xcodegen flock; do
  require_tool "$tool"
done
if [[ $RUN_SECRETS -eq 1 ]]; then
  require_tool gitleaks
fi

run_capture versions bash -lc '
  set -euo pipefail
  git branch --show-current
  swift --version
  swiftc --version
  swiftlint version
  swiftformat --version
  xcodegen --version
'

run_capture git-diff-check git diff --check

snapshot_package_resolved "$PACKAGE_RESOLVED_BEFORE"

if [[ $RUN_XCODEGEN -eq 1 ]]; then
  # shellcheck disable=SC2016
  run_capture xcodegen-temp-generate bash -lc '
    set -euo pipefail
    tmp="$(mktemp -d /tmp/vv-xcodegen-check.XXXXXX)"
    trap "rm -rf \"$tmp\"" EXIT
    xcodegen generate \
      --spec "$PWD/MasonsBudget/project.yml" \
      --project "$tmp" \
      --project-root "$PWD/MasonsBudget" \
      --quiet
    test -f "$tmp/MasonsBudget.xcodeproj/project.pbxproj"
  '
fi

if [[ $RUN_SWIFTLINT -eq 1 ]]; then
  run_capture swiftlint-app-and-tests swiftlint lint \
    --strict \
    --quiet \
    "$ROOT/MasonsBudget/MasonsBudget" \
    "$ROOT/MasonsBudget/MasonsBudgetTests"
fi

if [[ $RUN_FORMAT -eq 1 ]]; then
  run_capture swiftformat-lint swiftformat \
    "$ROOT/MasonsBudget/MasonsBudget" \
    "$ROOT/MasonsBudget/MasonsBudgetTests" \
    --swiftversion 6.3 \
    --lint \
    --dry-run \
    --quiet \
    --exclude "$ROOT/.build,$ROOT/.claude,$ROOT/.serena,$ROOT/drafts,$ROOT/node_modules"
fi

run_capture swift-stdin-typecheck bash -lc '
  set -euo pipefail
  printf "struct VVSwiftProbe { let value: Int }\n" | swiftc -typecheck -
'

if [[ -f "$ROOT/Package.swift" ]]; then
  run_capture swiftpm-core-tests flock "$ARTIFACT_DIR/swiftpm.lock" swift test --package-path "$ROOT"
fi

snapshot_package_resolved "$PACKAGE_RESOLVED_AFTER"
if cmp -s "$PACKAGE_RESOLVED_BEFORE" "$PACKAGE_RESOLVED_AFTER"; then
  pass "Package.resolved unchanged"
else
  fail "Package.resolved changed during preflight (logs: $PACKAGE_RESOLVED_BEFORE, $PACKAGE_RESOLVED_AFTER)"
  diff -u "$PACKAGE_RESOLVED_BEFORE" "$PACKAGE_RESOLVED_AFTER" | sed -n '1,80p'
fi

if [[ $RUN_SECRETS -eq 1 ]]; then
  # shellcheck disable=SC2016
  run_capture gitleaks-working-tree-source bash -lc '
    set -euo pipefail
    scan_dir="$(mktemp -d /tmp/vv-gitleaks-source.XXXXXX)"
    trap "rm -rf \"$scan_dir\"" EXIT
    git ls-files -z --cached --modified --others --exclude-standard |
      while IFS= read -r -d "" file; do
        [ -f "$file" ] || continue
        mkdir -p "$scan_dir/$(dirname "$file")"
        cp "$file" "$scan_dir/$file"
      done
    gitleaks detect --no-banner --redact --no-git --source "$scan_dir"
  '
fi

log ""
log "Summary: failures=$FAILURES warnings=$WARNINGS artifacts=$ARTIFACT_DIR"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi

exit 0
