#!/usr/bin/env bash
#
# Classify the Convex WRITE-auth posture with three probes of a mutation that
# cannot change anything: a delete of a name that never exists.
#
# Companion to scripts/verify-read-auth.sh. The read gate has had a probe since
# the 2026-07-26 cutover; the write gate did not, which is why the write-side
# hatch state had to be recorded as "Unknown" in
# docs/convex-deploy-hatch-state.md. This script is that missing probe.
#
# The probe target is dataFiles:remove on a random name. If auth is enforced
# the mutation is rejected before touching anything. If the hatch is open the
# mutation runs and finds nothing to delete — a no-op either way, so the probe
# is safe against a deployment in either state.
#
# The known-good token is copied from CONVEX_SYNC_TOKEN into a mode-0600 file,
# removed from the environment before any child process runs, and never passed
# in argv or printed. Responses are reduced to local status words; deployment
# payloads, server-authored error text, and returned data are never printed.

set -euo pipefail

readonly DEFAULT_URL="https://keen-elephant-452.convex.cloud"
readonly PROBE_PATH="dataFiles:remove"

url="${CONVEX_URL:-$DEFAULT_URL}"
timeout="${VERIFY_SYNC_AUTH_TIMEOUT:-20}"
expect=""
curl_bin="${VERIFY_SYNC_AUTH_CURL:-curl}"
known_good_token="${CONVEX_SYNC_TOKEN:-}"
unset CONVEX_SYNC_TOKEN

usage() {
  cat <<'EOF'
Usage: scripts/verify-sync-auth.sh [options]

Reports the write-authentication state of a Convex deployment. Sends an
unauthenticated no-op mutation (dataFiles:remove of a name that cannot exist),
the same mutation with a freshly generated wrong credential, and, when
CONVEX_SYNC_TOKEN is non-empty, the same mutation with that known-good
credential.

Options:
  --url URL          Deployment URL (default: committed app deployment;
                     env CONVEX_URL takes precedence)
  --expect STATE     Assert "open" or "enforced". Exit 0 only on an exact,
                     fully verified match.
  --timeout SECONDS  Per-request timeout (default 20; env
                     VERIFY_SYNC_AUTH_TIMEOUT)
  -h, --help         This text.

Environment:
  CONVEX_URL          Deployment URL override.
  CONVEX_SYNC_TOKEN   Known-good write credential. It is copied into a mode-0600
                      temporary file, removed from child-process environments,
                      and never printed or passed in argv.

States (same vocabulary as verify-read-auth.sh):
  OPEN                  an anonymous or deliberately wrong credential executed
                        the mutation — the write hatch is open.
  ENFORCED              anonymous and wrong credentials were rejected by the
                        auth gate, and the supplied known-good credential
                        executed.
  TOKEN-UNCONFIGURED    the auth gate reports no deployment token is configured.
  WRONG-KNOWN-GOOD      the auth gate rejected the supplied known-good credential.
  OUTAGE                the probes failed for a non-auth or transport reason.
  CLOSED-UNCONFIRMED    anonymous and wrong credentials were rejected, but no
                        known-good credential was supplied; enforcement is not
                        certified.
  UNKNOWN               the probe results contradict the expected gate behavior.

Exit codes without --expect:
  0   ENFORCED
  10  OPEN
  11  OUTAGE
  12  CLOSED-UNCONFIRMED
  13  TOKEN-UNCONFIGURED
  14  WRONG-KNOWN-GOOD
  2   UNKNOWN
With --expect: 0 = exact match, 1 = mismatch, 2 = indeterminate.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      [ "$#" -ge 2 ] || { printf '%s\n' "verify-sync-auth: --url needs a value" >&2; exit 2; }
      url="$2"
      shift 2
      ;;
    --url=*)
      url="${1#--url=}"
      shift
      ;;
    --expect)
      [ "$#" -ge 2 ] || { printf '%s\n' "verify-sync-auth: --expect needs a value" >&2; exit 2; }
      expect="$2"
      shift 2
      ;;
    --expect=*)
      expect="${1#--expect=}"
      shift
      ;;
    --timeout)
      [ "$#" -ge 2 ] || { printf '%s\n' "verify-sync-auth: --timeout needs a value" >&2; exit 2; }
      timeout="$2"
      shift 2
      ;;
    --timeout=*)
      timeout="${1#--timeout=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'verify-sync-auth: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$expect" in
  ""|open|OPEN|enforced|ENFORCED) ;;
  *)
    printf '%s\n' "verify-sync-auth: --expect must be 'open' or 'enforced'" >&2
    exit 2
    ;;
esac

case "$timeout" in
  ''|*[!0-9]*)
    printf '%s\n' "verify-sync-auth: --timeout must be a whole number of seconds" >&2
    exit 2
    ;;
esac

command -v node >/dev/null 2>&1 || {
  printf '%s\n' "verify-sync-auth: node is not on PATH" >&2
  exit 2
}
if [[ "$curl_bin" == */* ]]; then
  [ -x "$curl_bin" ] || {
    printf '%s\n' "verify-sync-auth: curl command is not executable" >&2
    exit 2
  }
else
  command -v "$curl_bin" >/dev/null 2>&1 || {
    printf '%s\n' "verify-sync-auth: curl is not on PATH" >&2
    exit 2
  }
fi

url="${url%/}"
case "$url" in
  https://*) ;;
  *)
    printf 'verify-sync-auth: refusing a non-https deployment URL: %s\n' "$url" >&2
    exit 2
    ;;
esac

umask 077
workdir="$(mktemp -d "${TMPDIR:-/tmp}/verify-sync-auth.XXXXXX")"
# shellcheck disable=SC2329  # invoked by trap
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT INT TERM

have_token=0
known_good_file="$workdir/known-good-token"
if [ -n "$known_good_token" ]; then
  printf '%s' "$known_good_token" >"$known_good_file"
  known_good_token=""
  chmod 600 "$known_good_file"
  have_token=1
fi

# One-shot probe target name. Random per run, so the probe can never match a
# real data file; deleting a nonexistent dataFiles document is a no-op.
probe_name_file="$workdir/probe-name"
node -e '
  import("node:crypto").then((crypto) => {
    process.stdout.write(
      `__sync_auth_probe_${crypto.randomBytes(16).toString("hex")}__`,
    );
  });
' >"$probe_name_file"
probe_name="$(cat "$probe_name_file")"

control_file="$workdir/control-token"
node -e '
  import("node:crypto").then((crypto) => {
    process.stdout.write(
      `verify-sync-auth-control-${crypto.randomBytes(16).toString("hex")}`,
    );
  });
' >"$control_file"
chmod 600 "$control_file"

# Reduce each response to locally generated classification fields. No response
# value or server-authored error text crosses this boundary into script output.
classifier="$workdir/classify.mjs"
cat >"$classifier" <<'NODE'
import fs from "node:fs";

const [, , bodyPath, httpCode] = process.argv;
const raw = fs.readFileSync(bodyPath, "utf8");

function emit(outcome, unconfigured = false) {
  process.stdout.write(
    `outcome=${outcome}\nunconfigured=${unconfigured ? "yes" : "no"}\n`,
  );
}

if (httpCode !== "200") {
  emit("unknown");
  process.exit(0);
}

let json;
try {
  json = JSON.parse(raw);
} catch {
  emit("unknown");
  process.exit(0);
}

if (json?.status === "success") {
  emit("success");
  process.exit(0);
}

if (json?.status === "error") {
  // ConvexError data survives production redaction; ordinary Error text does not.
  // Never infer authorization from a generic failure plus a successful control.
  let data = json.errorData;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* Legacy errorData may be plain text. */ }
  }
  const code = data && typeof data === "object" ? data.code : undefined;
  const legacyMessage = typeof data === "string" ? data : json.errorMessage;
  const unconfigured = code === "SYNC_AUTH_UNCONFIGURED" ||
    (code === undefined && legacyMessage === "Unauthorized: write auth is not configured (fail-closed).");
  const isAuth = unconfigured || code === "SYNC_AUTH_REJECTED" ||
    (code === undefined && legacyMessage === "Unauthorized: invalid sync token");
  emit(isAuth ? "rejected_auth" : "rejected_other", unconfigured);
  process.exit(0);
}

emit("unknown");
NODE
chmod 600 "$classifier"

# probe <label> [token-file]
probe() {
  local label="$1"
  local token_file="${2:-}"
  local request="$workdir/request.$label"
  local response="$workdir/response.$label"
  local code_file="$workdir/code.$label"
  local rc=0

  if [ -n "$token_file" ]; then
    CONVEX_PROBE_PATH="$PROBE_PATH" CONVEX_PROBE_NAME="$probe_name" \
      CONVEX_PROBE_TOKEN_FILE="$token_file" node -e '
      import("node:fs").then((fs) => {
        const token = fs.readFileSync(process.env.CONVEX_PROBE_TOKEN_FILE, "utf8");
        process.stdout.write(JSON.stringify({
          path: process.env.CONVEX_PROBE_PATH,
          args: { name: process.env.CONVEX_PROBE_NAME, token },
          format: "json",
        }));
      });
    ' >"$request"
  else
    CONVEX_PROBE_PATH="$PROBE_PATH" CONVEX_PROBE_NAME="$probe_name" node -e '
      process.stdout.write(JSON.stringify({
        path: process.env.CONVEX_PROBE_PATH,
        args: { name: process.env.CONVEX_PROBE_NAME },
        format: "json",
      }));
    ' >"$request"
  fi
  chmod 600 "$request"

  "$curl_bin" --silent --show-error \
    --max-time "$timeout" \
    --header "Content-Type: application/json" \
    --data-binary "@$request" \
    --output "$response" \
    --write-out '%{http_code}' \
    "$url/api/mutation" >"$code_file" 2>"$workdir/curl-error.$label" || rc=$?

  if [ "$rc" -ne 0 ]; then
    printf 'outcome=unknown\nunconfigured=no\n' >"$workdir/out.$label"
    return 0
  fi

  node "$classifier" "$response" "$(<"$code_file")" >"$workdir/out.$label"
}

field() {
  local label="$1"
  local wanted="$2"
  local key value
  while IFS='=' read -r key value; do
    if [ "$key" = "$wanted" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done <"$workdir/out.$label"
  return 1
}

status_word() {
  case "$(field "$1" outcome)" in
    success) printf '%s\n' "EXECUTED" ;;
    rejected_auth) printf '%s\n' "REJECTED-AUTH" ;;
    rejected_other) printf '%s\n' "REJECTED-NON-AUTH" ;;
    *) printf '%s\n' "NO-ANSWER" ;;
  esac
}

probe anonymous
probe control "$control_file"
if [ "$have_token" -eq 1 ]; then
  probe known_good "$known_good_file"
fi

anon="$(field anonymous outcome)"
control="$(field control outcome)"
good="absent"
if [ "$have_token" -eq 1 ]; then
  good="$(field known_good outcome)"
fi

state="UNKNOWN"
if [ "$anon" = "success" ] || [ "$control" = "success" ]; then
  # Either condition proves the deployment executes mutations for a caller that
  # must be refused. The probe itself deletes nothing either way.
  state="OPEN"
elif [ "$(field anonymous unconfigured)" = "yes" ] ||
  [ "$(field control unconfigured)" = "yes" ] ||
  { [ "$have_token" -eq 1 ] && [ "$(field known_good unconfigured)" = "yes" ]; }; then
  state="TOKEN-UNCONFIGURED"
elif [ "$anon" = "rejected_auth" ] && [ "$control" = "rejected_auth" ]; then
  if [ "$have_token" -eq 0 ]; then
    state="CLOSED-UNCONFIRMED"
  else
    case "$good" in
      success) state="ENFORCED" ;;
      rejected_auth) state="WRONG-KNOWN-GOOD" ;;
      rejected_other|unknown) state="OUTAGE" ;;
      *) state="UNKNOWN" ;;
    esac
  fi
elif [ "$anon" = "unknown" ] || [ "$control" = "unknown" ] ||
  [ "$anon" = "rejected_other" ] || [ "$control" = "rejected_other" ]; then
  state="OUTAGE"
fi

printf 'verify-sync-auth: %s\n' "$url"
printf '  probe: %s on a name that cannot exist (no-op when executed; response data suppressed)\n' "$PROBE_PATH"
printf '  anonymous: %s\n' "$(status_word anonymous)"
printf '  wrong credential: %s\n' "$(status_word control)"
if [ "$have_token" -eq 1 ]; then
  printf '  known-good credential: %s\n' "$(status_word known_good)"
else
  printf '%s\n' "  known-good credential: NOT-SUPPLIED"
fi
printf 'STATE: %s\n' "$state"

if [ -n "$expect" ]; then
  want="$(printf '%s' "$expect" | tr '[:lower:]' '[:upper:]')"
  if [ "$state" = "$want" ]; then
    printf 'EXPECT %s: OK\n' "$want"
    exit 0
  fi
  case "$state" in
    UNKNOWN|CLOSED-UNCONFIRMED)
      printf 'EXPECT %s: INDETERMINATE\n' "$want" >&2
      exit 2
      ;;
    *)
      printf 'EXPECT %s: MISMATCH (actual %s)\n' "$want" "$state" >&2
      exit 1
      ;;
  esac
fi

case "$state" in
  ENFORCED) exit 0 ;;
  OPEN) exit 10 ;;
  OUTAGE) exit 11 ;;
  CLOSED-UNCONFIRMED) exit 12 ;;
  TOKEN-UNCONFIGURED) exit 13 ;;
  WRONG-KNOWN-GOOD) exit 14 ;;
  *) exit 2 ;;
esac
