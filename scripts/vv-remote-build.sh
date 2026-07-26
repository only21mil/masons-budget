#!/usr/bin/env bash
#
# shellcheck disable=SC2029
#
# Approval-gated Mac build bridge for Vogel Vault.
#
# Linux cannot run Xcode or Apple SDK builds. This script lets a Linux machine
# stay the orchestrator while a Mac build host performs the Apple-only commands.
# It refuses to run xcodebuild unless an explicit approval flag and approval note
# are provided at invocation time.
#
# There is no default host or repo path: nothing is kept at a fixed location on
# any machine, so both must be supplied. Prefer the GitHub Actions release
# workflow (.github/workflows/deploy.yml) over this bridge where it applies.

set -euo pipefail

REMOTE_HOST="${VV_MAC_HOST:-}"
REMOTE_REPO="${VV_MAC_REPO:-}"
ACTION="status"
APPROVED=0
APPROVAL_NOTE="${VV_BUILD_APPROVAL_NOTE:-}"

usage() {
  cat <<'EOF'
Usage: scripts/vv-remote-build.sh [options] <action>

Actions:
  status       Read-only Mac/Xcode/repo status. No build.
  preflight    Mac-side non-build prep: xcodegen generate + git diff --check.
  ios-build    Run approved iOS simulator build on the Mac.
  ios-test     Run approved iOS simulator tests on the Mac.
  mac-build    Run approved macOS build on the Mac.

Options:
  --host <user@host>       SSH target. Required, or set VV_MAC_HOST.
  --repo <path>            Remote repo path. Or set VV_MAC_REPO.
  --approved               Required for any xcodebuild action.
  --approval-note <text>   Required for any xcodebuild action.
  --help                   Show this help.

This script does not handle signing secrets, archives, exports, uploads, or
TestFlight. Those remain governed by the release-flow approval process.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      REMOTE_HOST="$2"
      shift 2
      ;;
    --repo)
      REMOTE_REPO="$2"
      shift 2
      ;;
    --approved)
      APPROVED=1
      shift
      ;;
    --approval-note)
      APPROVAL_NOTE="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    status | preflight | ios-build | ios-test | mac-build)
      ACTION="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$REMOTE_HOST" ]]; then
  cat >&2 <<'EOF'
ERROR: missing Mac SSH target.

There is no default host — machines and addresses change. Set VV_MAC_HOST or
pass --host, for example:
  VV_MAC_HOST=victor@my-mac VV_MAC_REPO=~/checkouts/masons-budget scripts/vv-remote-build.sh status
EOF
  exit 2
fi

if [[ -z "$REMOTE_REPO" ]]; then
  cat >&2 <<'EOF'
ERROR: missing remote repo path.

Set VV_MAC_REPO or pass --repo, for example:
  VV_MAC_HOST=victor@my-mac VV_MAC_REPO=~/checkouts/masons-budget scripts/vv-remote-build.sh status
EOF
  exit 2
fi

case "$ACTION" in
  status | preflight) ;;
  ios-build | ios-test | mac-build)
    if [[ $APPROVED -ne 1 || -z "$APPROVAL_NOTE" ]]; then
      cat >&2 <<'EOF'
ERROR: xcodebuild action refused.

Victor approval is required at invocation time. Re-run with:
  --approved --approval-note "Victor approved <scope> on <date/time>"

Do not use this flag unless the approval is real and current for this app/issue.
EOF
      exit 3
    fi
    ;;
  *)
    echo "Unsupported action: $ACTION" >&2
    exit 2
    ;;
esac

remote_quote() {
  printf "%q" "$1"
}

REMOTE_REPO_Q="$(remote_quote "$REMOTE_REPO")"

status_script="
set -euo pipefail
cd $REMOTE_REPO_Q
echo '== Mac host =='
hostname
sw_vers || true
echo '== Repo =='
pwd
git branch --show-current
git status --short
echo '== Tools =='
xcodebuild -version
command -v xcodegen && xcodegen --version
"

preflight_script="
set -euo pipefail
cd $REMOTE_REPO_Q/MasonsBudget
xcodegen generate --spec project.yml
cd ..
git diff --check
"

ios_build_script="
set -euo pipefail
cd $REMOTE_REPO_Q
echo 'Approval: $APPROVAL_NOTE'
xcodebuild build -scheme MasonsBudget -destination 'platform=iOS Simulator,name=iPhone 17' 2>&1 |
  tee /tmp/vv-ios-build.log |
  grep -E '(error:|warning:|BUILD|FAILED|SUCCEEDED|\\*\\* [A-Z])'
"

ios_test_script="
set -euo pipefail
cd $REMOTE_REPO_Q
echo 'Approval: $APPROVAL_NOTE'
xcodebuild test -scheme MasonsBudget -destination 'platform=iOS Simulator,name=iPhone 17' 2>&1 |
  tee /tmp/vv-ios-test.log |
  grep -E '(Test Case|passed|failed|error:|Executed|TEST|FAILED|SUCCEEDED)'
"

mac_build_script="
set -euo pipefail
cd $REMOTE_REPO_Q
echo 'Approval: $APPROVAL_NOTE'
xcodebuild build -scheme MasonsBudgetMac -destination 'platform=macOS' 2>&1 |
  tee /tmp/vv-mac-build.log |
  grep -E '(error:|warning:|BUILD|FAILED|SUCCEEDED|\\*\\* [A-Z])'
"

case "$ACTION" in
  status) ssh "$REMOTE_HOST" "$status_script" ;;
  preflight) ssh "$REMOTE_HOST" "$preflight_script" ;;
  ios-build) ssh "$REMOTE_HOST" "$ios_build_script" ;;
  ios-test) ssh "$REMOTE_HOST" "$ios_test_script" ;;
  mac-build) ssh "$REMOTE_HOST" "$mac_build_script" ;;
esac
