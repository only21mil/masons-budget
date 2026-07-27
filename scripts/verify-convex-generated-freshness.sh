#!/usr/bin/env bash

# Authenticated pre-deploy freshness check. The caller must load the approved
# local Convex deploy credential before invoking this script.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

npm run codegen

untracked_generated="$(
  git ls-files --others --exclude-standard -- convex/_generated
)"
if [[ -n "$untracked_generated" ]]; then
  printf '%s\n' "ERROR: Convex codegen created untracked generated files:" >&2
  printf '  %s\n' "$untracked_generated" >&2
  echo "Add and commit them before deploying." >&2
  exit 1
fi

if ! git diff --exit-code -- convex/_generated; then
  cat >&2 <<'EOF'
ERROR: Convex codegen changed committed files under convex/_generated.
Review and commit the regenerated declarations before deploying.
EOF
  exit 1
fi

if ! git diff --cached --exit-code -- convex/_generated; then
  cat >&2 <<'EOF'
ERROR: staged Convex generated declarations differ from HEAD.
Commit them before deploying the reviewed revision.
EOF
  exit 1
fi

echo "Convex generated declarations match authenticated codegen."
