#!/usr/bin/env bash

# Credential-free smoke alarm for CI. This validates the schema attestation and
# catches a schema diff with no generated-file diff, but cannot prove codegen ran.

set -euo pipefail

usage() {
  echo "Usage: $0 <base-revision> [head-revision]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

base_revision="$1"
git rev-parse --verify "${base_revision}^{commit}" >/dev/null

diff_args=("$base_revision")
if [[ $# -eq 2 ]]; then
  head_revision="$2"
  git rev-parse --verify "${head_revision}^{commit}" >/dev/null
  diff_args+=("$head_revision")
fi

changed_files="$(git diff --name-only "${diff_args[@]}" --)"

expected_schema_checksum="$(sha256sum convex/schema.ts)"
recorded_schema_checksum=""
if [[ -f convex/_generated/schema.sha256 ]]; then
  recorded_schema_checksum="$(< convex/_generated/schema.sha256)"
fi

if [[ "$recorded_schema_checksum" != "$expected_schema_checksum" ]]; then
  cat >&2 <<'EOF'
ERROR: convex/_generated/schema.sha256 does not attest the current convex/schema.ts.

Regenerate and commit the generated declarations from the repository root:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
  npm run codegen
  git add convex/_generated

This CI check is credential-free. The local codegen command must succeed before
it writes the schema checksum; a checksum can still be forged manually, so this
is a smoke alarm rather than proof that codegen ran.
EOF
  exit 1
fi

if ! grep -Fxq "convex/schema.ts" <<<"$changed_files"; then
  echo "Convex generated-type drift heuristic passed: schema checksum matches."
  exit 0
fi

if grep -q '^convex/_generated/' <<<"$changed_files"; then
  echo "Convex generated-type drift heuristic passed: schema checksum matches and generated files changed."
  exit 0
fi

cat >&2 <<'EOF'
ERROR: convex/schema.ts changed without a corresponding convex/_generated change.

Regenerate and commit the generated declarations from the repository root:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
  npm run codegen
  git add convex/_generated

This CI check is only a credential-free heuristic. The authenticated codegen
command above is what determines whether the committed declarations are fresh.
EOF
exit 1
