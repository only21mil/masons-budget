#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:-only21mil/masons-budget}"
mode="${1:---check}"

if [[ "$mode" != "--check" && "$mode" != "--apply" ]]; then
  echo "usage: $0 [--check|--apply]" >&2
  exit 2
fi

expected_checks="$(
  jq -cn '[
    {"context":"Detect changed trees","app_id":15368},
    {"context":"Detect Apple changes","app_id":15368},
    {"context":"actionlint + secret inventory","app_id":15368},
    {"context":"Credential mint tooling","app_id":15368},
    {"context":"Verify committed Xcode project","app_id":15368},
    {"context":"Shared domain contract","app_id":15368},
    {"context":"Production wire golden decoders","app_id":15368},
    {"context":"Convex functions","app_id":15368},
    {"context":"Linux client","app_id":15368},
    {"context":"Android client","app_id":15368},
    {"context":"Build and test the Apple client","app_id":15368}
  ]'
)"

protection="$(gh api "repos/${repository}/branches/main/protection")"
if [[ "$(jq -r '.enforce_admins.enabled' <<<"$protection")" != "true" ]]; then
  echo "refusing to continue: main must enforce protection for administrators" >&2
  exit 1
fi

runner_inventory="$(gh api "repos/${repository}/actions/runners")"
if ! jq -e '
  [.runners[]
    | select(
        .status == "online" and
        ([.labels[].name] | contains(["self-hosted", "macOS", "ARM64", "xcode"]))
      )]
  | length > 0
' <<<"$runner_inventory" >/dev/null; then
  echo "refusing to continue: no online runner has self-hosted/macOS/ARM64/xcode labels" >&2
  exit 1
fi

if [[ "$mode" == "--apply" ]]; then
  payload="$(jq -cn --argjson checks "$expected_checks" '{strict:false, checks:$checks}')"
  gh api \
    --method PATCH \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/${repository}/branches/main/protection/required_status_checks" \
    --input - <<<"$payload" >/dev/null
fi

protection="$(gh api "repos/${repository}/branches/main/protection")"
actual_checks="$(
  jq -c '
    [.required_status_checks.checks[] | {context, app_id}]
    | sort_by(.context, .app_id)
  ' <<<"$protection"
)"
sorted_expected="$(jq -c 'sort_by(.context, .app_id)' <<<"$expected_checks")"

if [[ "$(jq -r '.required_status_checks.strict' <<<"$protection")" != "false" ]]; then
  echo "main required checks unexpectedly use strict mode" >&2
  exit 1
fi
if [[ "$actual_checks" != "$sorted_expected" ]]; then
  echo "main required checks do not match the expected nine-check policy" >&2
  jq -r '.[] | "  \(.context) (app \(.app_id))"' <<<"$actual_checks" >&2
  exit 1
fi

echo "main protection verified: enforce_admins=true, strict=false, 9 required checks"
jq -r '.[] | "  \(.context) (app \(.app_id))"' <<<"$actual_checks"
