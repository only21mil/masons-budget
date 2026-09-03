#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
subject="$repo_root/scripts/verify-sync-auth.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/verify-sync-auth-test.XXXXXX")"
real_chmod="$(command -v chmod)"
# shellcheck disable=SC2329  # invoked by trap
cleanup() { rm -rf "$test_dir"; }
trap cleanup EXIT INT TERM

mkdir "$test_dir/bin"
cat >"$test_dir/bin/chmod" <<STUB
#!/usr/bin/env bash
set -euo pipefail

# No child process, including chmod, may briefly inherit the known-good token.
[ -z "\${CONVEX_SYNC_TOKEN:-}" ] || exit 98
exec "$real_chmod" "\$@"
STUB
"$real_chmod" 700 "$test_dir/bin/chmod"

stub="$test_dir/curl-stub"
cat >"$stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

# The subject must remove the known-good credential from child environments.
if [ -n "${CONVEX_SYNC_TOKEN:-}" ]; then
  exit 97
fi

output=""
request=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --data-binary)
      request="${2#@}"
      shift 2
      ;;
    --max-time|--header|--write-out)
      shift 2
      ;;
    --silent|--show-error)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$output" ] && [ -n "$request" ]

token="$(node -e '
  const fs = require("node:fs");
  const request = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (request.path !== "dataFiles:remove") process.exit(91);
  if (!/^__sync_auth_probe_[0-9a-f]{32}__$/.test(request.args?.name ?? "")) {
    process.exit(93);
  }
  process.stdout.write(request.args?.token ?? "");
' "$request")"

kind="known_good"
if [ -z "$token" ]; then
  kind="anonymous"
elif [[ "$token" == verify-sync-auth-control-* ]]; then
  kind="control"
fi

success() {
  printf '%s' '{"status":"success","value":null,"private":"SERVER-PAYLOAD-MUST-NOT-PRINT"}' >"$output"
  printf '%s' '200'
}

auth_rejection() {
  local message="$1"
  printf '{"status":"error","errorData":"%s","errorMessage":"SERVER-AUTHORED-ERROR-DETAIL"}' "$message" >"$output"
  printf '%s' '200'
}

other_rejection() {
  printf '%s' '{"status":"error","errorData":"SERVER-AUTHORED-OUTAGE-DETAIL","errorMessage":"Server Error"}' >"$output"
  printf '%s' '200'
}

case "${VERIFY_SYNC_AUTH_TEST_SCENARIO:?}" in
  enforced)
    if [ "$kind" = "known_good" ]; then success; else auth_rejection "Unauthorized: invalid sync token"; fi
    ;;
  wrong_known_good)
    auth_rejection "Unauthorized: invalid sync token"
    ;;
  unconfigured)
    auth_rejection "Unauthorized: write auth is not configured (fail-closed)."
    ;;
  outage)
    other_rejection
    ;;
  open)
    success
    ;;
  wrong_credential_accepted)
    if [ "$kind" = "control" ]; then success; else auth_rejection "Unauthorized: invalid sync token"; fi
    ;;
  transport_outage)
    printf '%s' 'SERVER-PAYLOAD-MUST-NOT-PRINT' >"$output"
    printf '%s' '503'
    ;;
  *)
    exit 92
    ;;
esac
STUB
chmod 700 "$stub"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "output leaked forbidden text: $needle"
}

run_case() {
  local name="$1" scenario="$2" token_mode="$3" expected_rc="$4" expected_state="$5"
  local output rc
  set +e
  if [ "$token_mode" = "present" ]; then
    output="$(
      CONVEX_SYNC_TOKEN='known-good-test-token-DO-NOT-PRINT' \
      VERIFY_SYNC_AUTH_CURL="$stub" \
      VERIFY_SYNC_AUTH_TEST_SCENARIO="$scenario" \
      PATH="$test_dir/bin:$PATH" \
      "$subject" --url https://stub.invalid --expect enforced 2>&1
    )"
    rc=$?
  else
    output="$(
      env -u CONVEX_SYNC_TOKEN \
        VERIFY_SYNC_AUTH_CURL="$stub" \
        VERIFY_SYNC_AUTH_TEST_SCENARIO="$scenario" \
        PATH="$test_dir/bin:$PATH" \
        "$subject" --url https://stub.invalid --expect enforced 2>&1
    )"
    rc=$?
  fi
  set -e

  [ "$rc" -eq "$expected_rc" ] || {
    printf '%s\n' "$output" >&2
    fail "$name returned $rc, expected $expected_rc"
  }
  assert_contains "$output" "STATE: $expected_state"
  assert_not_contains "$output" "known-good-test-token-DO-NOT-PRINT"
  assert_not_contains "$output" "SERVER-AUTHORED-PRIVATE-DATA"
  assert_not_contains "$output" "SERVER-PAYLOAD-MUST-NOT-PRINT"
  assert_not_contains "$output" "SERVER-AUTHORED-ERROR-DETAIL"
  assert_not_contains "$output" "SERVER-AUTHORED-OUTAGE-DETAIL"
  assert_not_contains "$output" "__sync_auth_probe_"
  printf 'ok - %s\n' "$name"
}

run_case "verified write enforcement" enforced present 0 ENFORCED
run_case "missing known-good credential" enforced absent 2 CLOSED-UNCONFIRMED
run_case "wrong supplied known-good credential" wrong_known_good present 1 WRONG-KNOWN-GOOD
run_case "deployment token unconfigured" unconfigured present 1 TOKEN-UNCONFIGURED
run_case "server outage" outage present 1 OUTAGE
run_case "transport outage" transport_outage present 1 OUTAGE
run_case "anonymous writes open" open present 1 OPEN
run_case "wrong credential accepted" wrong_credential_accepted present 1 OPEN

printf '%s\n' "verify-sync-auth tests passed"
