#!/usr/bin/env bash

# Authenticated pre-deploy freshness check. The caller must load the approved
# local Convex deploy credential before invoking this script.
#
# Starting clean matters: otherwise a pre-existing hand edit can be mistaken for
# codegen output. From a clean tree, a successful command that leaves no diff is
# direct evidence that this checkout matches the invoked codegen tool.
#
# Honest limit: this does not establish who approved the revision or credential,
# and it cannot make the credential-free CI check prove codegen ran. It proves
# only that the configured npm codegen command exited successfully here and left
# the committed generated tree byte-identical.

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

echo "Convex generated declarations match authenticated codegen from a clean generated tree."
echo "LIMITATION: this local result does not make the credential-free CI attestation unforgeable."
