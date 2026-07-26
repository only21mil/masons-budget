#!/usr/bin/env bash
#
# Report whether Convex reads are OPEN (unauthenticated queries succeed) or
# ENFORCED (unauthenticated queries are rejected).
#
# This is the observable signal for every step of the read-auth cutover —
# see docs/convex-read-auth-cutover.md. It is a pure read probe: it issues
# Convex *queries* only, never a mutation, so it is safe to run repeatedly and
# safe to run against production.
#
# Metadata only, deliberately. The probe calls `dataFiles:list`, which returns
# file names, versions and timestamps. It never calls `dataFiles:get` and never
# touches a payload, so no balance, transaction, merchant or todo text can be
# printed by this script even when reads are wide open.
#
# Tokens are read from the environment and are never echoed, logged, written to
# a file, or passed in argv — the request body is assembled in a mode-0600
# temp file so the token cannot leak into `ps` output. The script reports a
# token as present/absent and accepted/rejected, never its value.

set -euo pipefail

readonly DEFAULT_URL="https://keen-elephant-452.convex.cloud"

# Hardcoded, not a parameter: the whole point of this script is that it cannot
# be pointed at a payload-returning function by accident.
readonly PROBE_PATH="dataFiles:list"

url="${CONVEX_URL:-$DEFAULT_URL}"
timeout="${VERIFY_READ_AUTH_TIMEOUT:-20}"
expect=""
verbose=0

usage() {
  cat <<'EOF'
Usage: scripts/verify-read-auth.sh [options]

Reports the read-authentication state of a Convex deployment by issuing one
unauthenticated metadata query (dataFiles:list) and observing whether it is
rejected.

Options:
  --url URL          Deployment URL (default: the committed app deployment;
                     env CONVEX_URL takes precedence over the default)
  --expect STATE     Assert the state: "open" or "enforced". Exit 0 on match,
                     1 on mismatch. Use this to gate a cutover step.
  --timeout SECONDS  Per-request timeout (default 20, env
                     VERIFY_READ_AUTH_TIMEOUT)
  --verbose          Also print file names/versions/timestamps returned by the
                     metadata query. Still never prints file contents.
  -h, --help         This text.

Environment:
  CONVEX_URL         Deployment URL override.
  CONVEX_READ_TOKEN  If set and non-empty, a second probe is sent WITH the
                     token to confirm the deployment accepts it. The value is
                     never printed.

Exit codes (without --expect, the code encodes the state, not success):
  0   ENFORCED  - unauthenticated reads are rejected
  10  OPEN      - unauthenticated reads succeed
  2   UNKNOWN   - could not determine (network, unexpected response shape,
                  or an error that is not an authorization error)
With --expect: 0 = state matched, 1 = state did not match, 2 = UNKNOWN.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)
      [ $# -ge 2 ] || { echo "verify-read-auth: --url needs a value" >&2; exit 2; }
      url="$2"; shift 2 ;;
    --url=*) url="${1#--url=}"; shift ;;
    --expect)
      [ $# -ge 2 ] || { echo "verify-read-auth: --expect needs a value" >&2; exit 2; }
      expect="$2"; shift 2 ;;
    --expect=*) expect="${1#--expect=}"; shift ;;
    --timeout)
      [ $# -ge 2 ] || { echo "verify-read-auth: --timeout needs a value" >&2; exit 2; }
      timeout="$2"; shift 2 ;;
    --timeout=*) timeout="${1#--timeout=}"; shift ;;
    --verbose|-v) verbose=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "verify-read-auth: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$expect" in
  ""|open|OPEN|enforced|ENFORCED) ;;
  *) echo "verify-read-auth: --expect must be 'open' or 'enforced'" >&2; exit 2 ;;
esac

case "$timeout" in
  ''|*[!0-9]*) echo "verify-read-auth: --timeout must be a whole number of seconds" >&2; exit 2 ;;
esac

for tool in curl node; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-read-auth: $tool is not on PATH" >&2
    exit 2
  }
done

url="${url%/}"
case "$url" in
  https://*) ;;
  *) echo "verify-read-auth: refusing a non-https deployment URL: $url" >&2; exit 2 ;;
esac

umask 077
workdir="$(mktemp -d "${TMPDIR:-/tmp}/verify-read-auth.XXXXXX")"
# shellcheck disable=SC2329  # invoked via trap
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT INT TERM

# Classifier runs in node (already required by the repo) so the response is
# parsed as JSON rather than grepped. It reads from files, never argv.
cat >"$workdir/classify.mjs" <<'NODE'
import fs from "node:fs";

const [, , bodyPath, httpCode] = process.argv;
const raw = fs.readFileSync(bodyPath, "utf8");

function emit(fields) {
  process.stdout.write(
    Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}`)
      .join("\n") + "\n",
  );
}

if (httpCode !== "200") {
  emit({ outcome: "unknown", detail: `HTTP ${httpCode}` });
  process.exit(0);
}

let json;
try {
  json = JSON.parse(raw);
} catch {
  emit({ outcome: "unknown", detail: "response was not JSON" });
  process.exit(0);
}

if (json?.status === "success") {
  const value = Array.isArray(json.value) ? json.value : [];
  // Metadata only: name/version/updatedAt are the three fields dataFiles:list
  // returns. Anything else that ever appears here is dropped on the floor.
  const rows = value.map((entry) => ({
    name: typeof entry?.name === "string" ? entry.name : "?",
    version: Number.isFinite(entry?.version) ? entry.version : "?",
    updatedAt: Number.isFinite(entry?.updatedAt)
      ? new Date(entry.updatedAt).toISOString()
      : "?",
  }));
  emit({
    outcome: "success",
    count: rows.length,
    rows: JSON.stringify(rows),
  });
  process.exit(0);
}

if (json?.status === "error") {
  const message = String(json.errorMessage ?? json.errorData ?? "unknown error");
  // validateReadToken throws ConvexError("Unauthorized: ...") for both the
  // fail-closed case and the wrong-token case.
  const isAuth = /unauthorized/i.test(message);
  emit({
    outcome: isAuth ? "rejected" : "unknown",
    detail: message.slice(0, 300),
  });
  process.exit(0);
}

emit({ outcome: "unknown", detail: "unrecognized Convex response envelope" });
NODE

# $1 = "anonymous" | "token"; writes classifier output to $workdir/out.<label>
probe() {
  local label="$1"
  local req="$workdir/req.$label"
  local resp="$workdir/resp.$label"
  local code_file="$workdir/code.$label"

  : >"$req"
  chmod 600 "$req"
  if [ "$label" = "token" ]; then
    CONVEX_PROBE_PATH="$PROBE_PATH" node -e '
      const token = process.env.CONVEX_READ_TOKEN ?? "";
      process.stdout.write(JSON.stringify({
        path: process.env.CONVEX_PROBE_PATH,
        args: { token },
        format: "json",
      }));
    ' >"$req"
  else
    CONVEX_PROBE_PATH="$PROBE_PATH" node -e '
      process.stdout.write(JSON.stringify({
        path: process.env.CONVEX_PROBE_PATH,
        args: {},
        format: "json",
      }));
    ' >"$req"
  fi

  local rc=0
  curl --silent --show-error \
    --max-time "$timeout" \
    --header "Content-Type: application/json" \
    --data-binary "@$req" \
    --output "$resp" \
    --write-out '%{http_code}' \
    "$url/api/query" >"$code_file" 2>"$workdir/curl.err.$label" || rc=$?

  if [ "$rc" -ne 0 ]; then
    printf 'outcome=unknown\ndetail=curl failed (exit %s): %s\n' \
      "$rc" "$(tr '\n' ' ' <"$workdir/curl.err.$label")" >"$workdir/out.$label"
    return 0
  fi

  node "$workdir/classify.mjs" "$resp" "$(cat "$code_file")" >"$workdir/out.$label"
}

field() {
  # field <label> <key> — first match wins; values never contain a newline.
  sed -n "s/^$2=//p" "$workdir/out.$1" | head -n 1
}

echo "verify-read-auth: $url"
echo "  probe: $PROBE_PATH (metadata only — never dataFiles:get)"

probe anonymous
anon_outcome="$(field anonymous outcome)"

state="UNKNOWN"
case "$anon_outcome" in
  success)
    state="OPEN"
    echo "  unauthenticated query: ACCEPTED ($(field anonymous count) data files visible)"
    if [ "$verbose" -eq 1 ]; then
      # shellcheck disable=SC2016  # node source, not shell expansion
      METADATA_ROWS="$(field anonymous rows)" node -e '
        const rows = JSON.parse(process.env.METADATA_ROWS || "[]");
        for (const r of rows) {
          console.log(`    - ${r.name}  v${r.version}  ${r.updatedAt}`);
        }
      '
    fi
    ;;
  rejected)
    state="ENFORCED"
    echo "  unauthenticated query: REJECTED — $(field anonymous detail)"
    ;;
  *)
    echo "  unauthenticated query: INDETERMINATE — $(field anonymous detail)"
    ;;
esac

if [ -n "${CONVEX_READ_TOKEN:-}" ]; then
  echo "  CONVEX_READ_TOKEN in this shell: present"
  probe token
  token_detail="$(field token detail)"
  case "$(field token outcome)" in
    success) echo "  authenticated query: ACCEPTED ($(field token count) data files visible)" ;;
    rejected) echo "  authenticated query: REJECTED — $token_detail" ;;
    *)
      echo "  authenticated query: INDETERMINATE — $token_detail"
      # A pre-gate deployment has no `token` argument in its validator, so the
      # extra arg is an ArgumentValidationError, which production reports as a
      # bare "Server Error". That is the signal that step 2 of the cutover
      # (deploying the gated code) has not happened yet — and the reason
      # clients must not start sending the token before it does.
      if [ "$state" = "OPEN" ] && printf '%s' "$token_detail" |
        grep -qiE 'server error|argumentvalidationerror'; then
        echo "  hint: the deployment appears to reject a 'token' argument, so the"
        echo "        gated code is probably not deployed yet. Do not ship clients"
        echo "        that send a read token until it is."
      fi
      ;;
  esac
else
  echo "  CONVEX_READ_TOKEN in this shell: absent (skipping the authenticated probe)"
fi

echo "STATE: $state"

if [ -n "$expect" ]; then
  want="$(printf '%s' "$expect" | tr '[:lower:]' '[:upper:]')"
  if [ "$state" = "UNKNOWN" ]; then
    echo "EXPECT $want: INDETERMINATE" >&2
    exit 2
  fi
  if [ "$state" = "$want" ]; then
    echo "EXPECT $want: OK"
    exit 0
  fi
  echo "EXPECT $want: MISMATCH (actual $state)" >&2
  exit 1
fi

case "$state" in
  ENFORCED) exit 0 ;;
  OPEN) exit 10 ;;
  *) exit 2 ;;
esac
