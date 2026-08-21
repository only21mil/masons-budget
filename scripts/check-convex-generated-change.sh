#!/usr/bin/env bash

# Credential-free smoke alarm for CI. This validates the schema attestation,
# verifies that api.d.ts names every current Convex source module exactly once,
# and catches a schema diff with no attestation diff.
#
# Honest limit: every checked artifact is writable repository text. This cannot
# prove codegen ran, cannot distinguish generated declarations from a convincing
# hand edit, and cannot prove that types inside an existing module are fresh.
# scripts/verify-convex-generated-freshness.sh supplies the stronger local check
# by actually invoking authenticated codegen from a clean generated tree.

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
if [[ -f convex/schema.sha256 ]]; then
  recorded_schema_checksum="$(< convex/schema.sha256)"
fi

if [[ "$recorded_schema_checksum" != "$expected_schema_checksum" ]]; then
  cat >&2 <<'EOF'
ERROR: convex/schema.sha256 does not attest the current convex/schema.ts.

Regenerate and commit the generated declarations from the repository root:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
  npm run codegen
  git add convex/_generated convex/schema.sha256

This CI check is credential-free. The local codegen command must succeed before
it writes the schema checksum; a checksum can still be forged manually, so this
is a smoke alarm rather than proof that codegen ran.
EOF
  exit 1
fi

if ! node --input-type=module <<'NODE'
import fs from "node:fs"
import path from "node:path"

const sourceModules = []
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "_generated") continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(absolute)
      continue
    }
    if (
      !entry.name.endsWith(".ts")
      || entry.name === "schema.ts"
      || entry.name.endsWith(".d.ts")
      || /\.test(?:[-.][^.]+)*\.ts$/.test(entry.name)
      || entry.name.endsWith(".config.ts")
    ) {
      continue
    }
    sourceModules.push(
      path.relative("convex", absolute).split(path.sep).join("/").replace(/\.ts$/, ""),
    )
  }
}
walk("convex")
sourceModules.sort()

const apiPath = "convex/_generated/api.d.ts"
if (!fs.existsSync(apiPath)) {
  console.error("ERROR: Convex generated API module inventory is missing api.d.ts.")
  process.exit(1)
}
const api = fs.readFileSync(apiPath, "utf8")
const generatedModules = [...api.matchAll(/import type \* as \w+ from "\.\.\/(.+)\.js";/g)]
  .map((match) => match[1])
  .sort()
const missing = sourceModules.filter((module) => !generatedModules.includes(module))
const stale = generatedModules.filter((module) => !sourceModules.includes(module))
const duplicates = generatedModules.filter(
  (module, index) => generatedModules.indexOf(module) !== index,
)

if (missing.length > 0 || stale.length > 0 || duplicates.length > 0) {
  console.error("ERROR: Convex generated API module inventory does not match source modules.")
  if (missing.length > 0) console.error(`  Missing from api.d.ts: ${missing.join(", ")}`)
  if (stale.length > 0) console.error(`  Stale in api.d.ts: ${stale.join(", ")}`)
  if (duplicates.length > 0) {
    console.error(`  Duplicated in api.d.ts: ${[...new Set(duplicates)].join(", ")}`)
  }
  process.exit(1)
}
NODE
then
  cat >&2 <<'EOF'

Regenerate and commit the generated declarations from the repository root:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
  npm run codegen
  git add convex/_generated

This inventory comparison is deterministic but still cannot prove codegen ran
or that declarations within an existing module were generated rather than
edited by hand.
EOF
  exit 1
fi

base_schema_checksum="$(
  git show "${base_revision}:convex/schema.ts" | sha256sum | cut -d' ' -f1
)"
base_attestation_path="convex/schema.sha256"
if ! git cat-file -e "${base_revision}:${base_attestation_path}" 2>/dev/null; then
  # Accept the old location only as a baseline so the move can land safely.
  base_attestation_path="convex/_generated/schema.sha256"
fi
base_recorded_checksum="$(
  git show "${base_revision}:${base_attestation_path}" 2>/dev/null \
    | awk 'NR == 1 { print $1 }' \
    || true
)"
if [[ -z "$base_recorded_checksum" || "$base_recorded_checksum" != "$base_schema_checksum" ]]; then
  cat >&2 <<EOF
ERROR: base revision ${base_revision} does not contain a valid schema attestation.

The credential-free comparison cannot reason from an unattested baseline.
EOF
  exit 1
fi

if ! grep -Fxq "convex/schema.ts" <<<"$changed_files"; then
  echo "Convex generated-type drift checks passed: schema checksum and API module inventory match."
  exit 0
fi

if grep -Fxq "convex/schema.sha256" <<<"$changed_files"; then
  echo "Convex generated-type drift checks passed: schema attestation changed and API module inventory matches."
  echo "LIMITATION: repository checks cannot prove codegen ran or rule out hand-edited generated files."
  exit 0
fi

cat >&2 <<'EOF'
ERROR: convex/schema.ts changed without a corresponding schema.sha256 attestation change.

Regenerate and commit the generated declarations from the repository root:
  set -a; . "$HOME/.config/sats/secrets.env"; set +a
  npm run codegen
  git add convex/_generated convex/schema.sha256

This CI check is only a credential-free heuristic. Even a matching changed
checksum can be forged by hand. The authenticated codegen command above is what
determines whether the committed declarations are fresh.
EOF
exit 1
