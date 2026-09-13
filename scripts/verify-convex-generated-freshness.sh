#!/usr/bin/env bash

# Remote preparation plus generated-file comparison. Requires separate Victor
# approval for the exact revision, target and possible persistent schema/index
# effects. The acknowledgement argument does not establish that approval.
# See docs/convex-codegen-safety.md for the pre-existing injection requirement.
# This is never an ordinary local/static check, including with --dry-run.
# Starting with a clean generated tree lets the comparison attribute changes
# to this invocation. The result does not prove approval or no remote effects.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

preexisting_generated_changes="$(git status --porcelain=v1 -- convex/_generated)"
if [[ -n "$preexisting_generated_changes" ]]; then
  cat >&2 <<'EOF'
ERROR: authenticated freshness requires a clean generated tree before codegen.

Commit or remove the pre-existing staged, unstaged, or untracked changes under
convex/_generated, then run this check again. Codegen was not invoked because
the check could not attribute those bytes to the generator.
EOF
  exit 1
fi

node scripts/convex-codegen-remote.mjs "$@"

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

echo "Convex generated declarations match authenticated codegen from a clean generated tree."
echo "LIMITATION: remote preparation may persist schema/index work; repository checks cannot prove approval or freshness."
