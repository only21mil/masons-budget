#!/usr/bin/env bash
#
# Report whether Convex reads are OPEN (unauthenticated queries succeed),
# ENFORCED (rejected by the auth gate) — or whether the deployment is simply
# broken, which is a different thing and used to be indistinguishable.
#
# This is the observable signal for every step of the read-auth cutover —
# see docs/convex-read-auth-cutover.md. It is a pure read probe: it issues
# Convex *queries* only, never a mutation, so it is safe to run repeatedly and
# safe to run against production.
#
# ── Why there is a CONTROL probe ─────────────────────────────────────────────
#
# A single unauthenticated probe cannot tell "correctly rejected" from "server
# is on fire". It proved that the moment enforcement went live: production
# redacts a thrown error's `errorMessage` to a bare "[Request ID: …] Server
# Error", so the script printed INDETERMINATE / STATE: UNKNOWN while the door
# was, in fact, correctly shut. A checker that returns UNKNOWN exactly when it
# is needed is not a checker — and this script is the *only* automated
# detector of the hazard the "hatch outranks the token" design knowingly buys
# (a set CONVEX_READ_TOKEN silently doing nothing).
#
# So every run sends a second, deliberately-wrong credential, and — when
# CONVEX_READ_TOKEN is in the environment — a third, known-good one. The pair
# is what makes the answer falsifiable:
#
#   good ACCEPTED + wrong REJECTED  → ENFORCED. The gate is running AND the
#                                     token we hold is the token it holds.
#   good REJECTED + wrong REJECTED  → OUTAGE. Everything is failing; that is
#                                     not enforcement, it is a lockout.
#   wrong ACCEPTED                  → OPEN. The gate is not comparing tokens at
#                                     all (hatch on, or gate not deployed) —
#                                     the Trap 1 hazard, caught without needing
#                                     the real token.
#
# Without CONVEX_READ_TOKEN there is no known-good control, so the script can
# still prove OPEN vs not-OPEN and can still recognise the gate's own
# `Unauthorized:` payload — but it says out loud that it has not verified the
# token's value. It never guesses.
#
# ── Safety properties, unchanged and non-negotiable ──────────────────────────
#
# Metadata only, deliberately. Every probe calls `dataFiles:list`, which
# returns file names, versions and timestamps. It never calls `dataFiles:get`
# and never touches a payload, so no balance, transaction, merchant or todo
# text can be printed by this script even when reads are wide open. The probe
# path is hardcoded, not a parameter, so it cannot be pointed at a
# payload-returning function by accident.
#
# Tokens are read from the environment and are never echoed, logged, written to
# a file, or passed in argv — every request body is assembled in a mode-0600
# temp file so no token can leak into `ps` output. The script reports a token as
# present/absent and accepted/rejected, never by value. The control credential
# is generated fresh per run from the CSPRNG, is never persisted, and is not a
# secret: it is a string the deployment is *supposed* to refuse.

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

Reports the read-authentication state of a Convex deployment. Sends an
unauthenticated metadata query (dataFiles:list), the same query with a
deliberately wrong credential, and — if CONVEX_READ_TOKEN is set — the same
query with that credential, then classifies the deployment from the pair.

Options:
  --url URL          Deployment URL (default: the committed app deployment;
                     env CONVEX_URL takes precedence over the default)
  --expect STATE     Assert the state: "open" or "enforced". Exit 0 on match,
                     1 on mismatch. Use this to gate a cutover step.
  --timeout SECONDS  Per-request timeout (default 20, env
                     VERIFY_READ_AUTH_TIMEOUT)
  --verbose          Also print file names/versions/timestamps returned by a
                     successful metadata query. Still never prints file
                     contents.
  -h, --help         This text.

Environment:
  CONVEX_URL         Deployment URL override.
  CONVEX_READ_TOKEN  If set and non-empty, the known-good control probe runs.
                     This is what upgrades "the door seems shut" to "the door
                     is shut and my key opens it". The value is never printed.

States:
  OPEN                 unauthenticated reads succeed.
  ENFORCED             the gate is running and a valid credential is accepted.
  OUTAGE               reads are failing for everyone, including a caller
                       holding CONVEX_READ_TOKEN. Not enforcement — a lockout.
  CLOSED-UNCONFIRMED   reads are definitely not open, but with no known-good
                       credential to compare against, a shut door and a broken
                       server look the same. Re-run with CONVEX_READ_TOKEN.
  UNKNOWN              could not probe (network, non-200, unparseable answer),
                       or the probes contradict each other.

Exit codes (without --expect, the code encodes the state, not success):
  0   ENFORCED
  10  OPEN
  11  OUTAGE
  12  CLOSED-UNCONFIRMED
  2   UNKNOWN
With --expect: 0 = state matched, 1 = state did not match, 2 = indeterminate.
Note that --expect enforced deliberately FAILS on OUTAGE: "nobody can read,
including me" is the step-5 rollback trigger, not a successful cutover.
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

# The control credential. Generated per run from the CSPRNG so it cannot
# collide with the real token, and prefixed so anyone who later finds it in a
# deployment log can see at a glance what it was. Held in a variable that is
# never printed — not because this string is a secret (the deployment is
# supposed to refuse it) but because the next person to copy this function may
# be handling one that is. Read out of the environment by the probe body,
# never passed in argv.
VERIFY_READ_AUTH_CONTROL_TOKEN="verify-read-auth-control-$(node -e '
  import("node:crypto").then((c) => {
    process.stdout.write(c.randomBytes(16).toString("hex"));
  });
')"
export VERIFY_READ_AUTH_CONTROL_TOKEN

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
  // A rejected query still answers 200 — the envelope carries the error. A
  // non-200 is the platform failing, so it says nothing either way about auth.
  emit({ outcome: "unknown", unconfigured: "no", detail: `HTTP ${httpCode}` });
  process.exit(0);
}

let json;
try {
  json = JSON.parse(raw);
} catch {
  emit({ outcome: "unknown", unconfigured: "no", detail: "response was not JSON" });
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
    unconfigured: "no",
    count: rows.length,
    rows: JSON.stringify(rows),
  });
  process.exit(0);
}

if (json?.status === "error") {
  // ORDER MATTERS HERE, and having it backwards is what broke this script.
  //
  // A production deployment REDACTS `errorMessage`: every thrown error becomes
  // "[Request ID: …] Server Error", auth or not. `errorData` carries the
  // ConvexError payload through untouched — that is the entire point of
  // ConvexError over Error. Reading errorMessage first meant the gate's own
  // "Unauthorized: invalid read token" was masked by the redaction sitting in
  // front of it, and a correctly closed door read as INDETERMINATE. errorData
  // wins; errorMessage is the fallback for a dev deployment, which does not
  // redact, and for a plain Error, which has no errorData at all.
  const data = json.errorData;
  const dataText =
    data === undefined || data === null
      ? ""
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
  const messageText =
    typeof json.errorMessage === "string" ? json.errorMessage : "";

  // validateReadToken throws ConvexError("Unauthorized: …") for both the
  // fail-closed case and the wrong-token case. An error carrying that word is
  // the gate speaking. Anything else is a rejection we cannot attribute, and
  // saying so plainly is the honest answer.
  const isAuth =
    /unauthorized/i.test(dataText) || /unauthorized/i.test(messageText);

  emit({
    outcome: isAuth ? "rejected_auth" : "rejected_other",
    // "not configured" means the deployment holds no CONVEX_READ_TOKEN at all,
    // so it is refusing every reader on earth, not just this one.
    unconfigured:
      /not configured/i.test(dataText) || /not configured/i.test(messageText)
        ? "yes"
        : "no",
    detail: (dataText || messageText || "unknown error").slice(0, 300),
  });
  process.exit(0);
}

emit({
  outcome: "unknown",
  unconfigured: "no",
  detail: "unrecognized Convex response envelope",
});
NODE

# probe <label> [token-env-var-name]
#
# With no env var name the query is sent as `args: {}` — the shape iOS, Android
# and the MC2 bridge send when they have no credential. With one, the token is
# read from that variable *inside* node, so it never appears in argv nor in
# this script's own expansions. Writes classifier output to out.<label>.
probe() {
  local label="$1"
  local token_var="${2:-}"
  local req="$workdir/req.$label"
  local resp="$workdir/resp.$label"
  local code_file="$workdir/code.$label"

  : >"$req"
  chmod 600 "$req"
  if [ -n "$token_var" ]; then
    CONVEX_PROBE_PATH="$PROBE_PATH" CONVEX_PROBE_TOKEN_VAR="$token_var" node -e '
      const name = process.env.CONVEX_PROBE_TOKEN_VAR;
      const token = process.env[name] ?? "";
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
    printf 'outcome=unknown\nunconfigured=no\ndetail=curl failed (exit %s): %s\n' \
      "$rc" "$(tr '\n' ' ' <"$workdir/curl.err.$label")" >"$workdir/out.$label"
    return 0
  fi

  node "$workdir/classify.mjs" "$resp" "$(cat "$code_file")" >"$workdir/out.$label"
}

field() {
  # field <label> <key> — first match wins; values never contain a newline.
  sed -n "s/^$2=//p" "$workdir/out.$1" | head -n 1
}

print_rows() {
  # print_rows <label> — metadata only; the classifier already discarded
  # everything except name/version/updatedAt.
  # shellcheck disable=SC2016  # node source, not shell expansion
  METADATA_ROWS="$(field "$1" rows)" node -e '
    const rows = JSON.parse(process.env.METADATA_ROWS || "[]");
    for (const r of rows) {
      console.log(`    - ${r.name}  v${r.version}  ${r.updatedAt}`);
    }
  '
}

describe() {
  # describe <label> <human prefix> — one line per probe, in the same
  # vocabulary for all three, so the three answers can be read against each
  # other rather than one at a time.
  local label="$1" prefix="$2"
  case "$(field "$label" outcome)" in
    success)
      echo "  $prefix: ACCEPTED ($(field "$label" count) data files visible)"
      if [ "$verbose" -eq 1 ]; then print_rows "$label"; fi
      ;;
    rejected_auth)
      echo "  $prefix: REJECTED by the auth gate — $(field "$label" detail)" ;;
    rejected_other)
      echo "  $prefix: REJECTED, reason not attributable to auth — $(field "$label" detail)" ;;
    *)
      echo "  $prefix: NO ANSWER — $(field "$label" detail)" ;;
  esac
}

echo "verify-read-auth: $url"
echo "  probe: $PROBE_PATH (metadata only — never dataFiles:get)"

probe anonymous
probe control VERIFY_READ_AUTH_CONTROL_TOKEN
anon="$(field anonymous outcome)"
ctl="$(field control outcome)"

have_token=0
good="absent"
if [ -n "${CONVEX_READ_TOKEN:-}" ]; then
  have_token=1
  probe token CONVEX_READ_TOKEN
  good="$(field token outcome)"
fi

describe anonymous "unauthenticated query"
describe control "control query (deliberately wrong token)"
if [ "$have_token" -eq 1 ]; then
  echo "  CONVEX_READ_TOKEN in this shell: present"
  describe token "known-good token query"
else
  echo "  CONVEX_READ_TOKEN in this shell: absent"
fi

# ── Classification ───────────────────────────────────────────────────────────
#
# Read it as: what did the deployment do with callers who differ *only* in the
# credential they presented?
state="UNKNOWN"
case "$anon" in
  success)
    # Whatever else is true, an anonymous caller just read the household's file
    # listing. That is OPEN, and no other probe can talk us out of it.
    state="OPEN"
    ;;
  rejected_auth|rejected_other)
    if [ "$ctl" = "success" ]; then
      # No credential refused, a garbage credential admitted. validateReadToken
      # cannot produce that ordering, so something other than the gate we think
      # we deployed is answering — and whatever it is just handed the file
      # listing to a caller holding a random string. Refuse to classify rather
      # than pick the flattering reading; UNKNOWN fails every --expect.
      state="UNKNOWN"
    elif [ "$have_token" -eq 1 ]; then
      if [ "$good" = "success" ]; then
        state="ENFORCED"
      else
        # The caller holding the real token cannot read either. Enforcement is
        # not the story here; a lockout is.
        state="OUTAGE"
      fi
    elif [ "$anon" = "rejected_auth" ] || [ "$ctl" = "rejected_auth" ]; then
      # No control pair, but the deployment volunteered an `Unauthorized:`
      # payload and only validateReadToken emits that, so the gate is running.
      # What stays unproven is whether the token any reader holds still matches.
      state="ENFORCED"
    else
      state="CLOSED-UNCONFIRMED"
    fi
    ;;
  *)
    state="UNKNOWN"
    ;;
esac

# ── Findings that deserve a line of their own ────────────────────────────────

if [ "$state" = "OPEN" ] && [ "$ctl" = "success" ]; then
  echo "  ⚠️  a deliberately WRONG token was ACCEPTED: this deployment is not"
  echo "      comparing tokens at all. Either ALLOW_TOKENLESS_READ=true (Trap 1 —"
  echo "      a set CONVEX_READ_TOKEN is being ignored) or the gated code is not"
  echo "      deployed. Either way the data is readable by anyone with the URL."
fi

if [ "$state" = "OPEN" ] && [ "$ctl" != "success" ] && [ "$ctl" != "rejected_auth" ]; then
  echo "  hint: reads are open, but the deployment refuses a 'token' argument, so"
  echo "        the gated code is probably not deployed yet (Trap 2). Do not ship"
  echo "        clients that send a read token until it is."
fi

if [ "$state" = "ENFORCED" ] && [ "$have_token" -eq 0 ]; then
  echo "  note: no known-good control probe ran, so enforcement is read off the"
  echo "        gate's own Unauthorized payload. The deployment's token VALUE is"
  echo "        unverified from here — re-run with CONVEX_READ_TOKEN set to prove"
  echo "        a legitimate reader can still get in."
fi

if [ "$state" = "OUTAGE" ]; then
  echo "  ⚠️  the known-good token was refused as well: nobody can read, this"
  echo "      shell or the phone. That is a lockout, not a cutover. Roll back"
  echo "      with 'npx convex env set ALLOW_TOKENLESS_READ true', then diagnose."
fi

if [ "$(field anonymous unconfigured)" = "yes" ] ||
  [ "$(field control unconfigured)" = "yes" ]; then
  echo "  ⚠️  the gate reports CONVEX_READ_TOKEN is NOT CONFIGURED on the"
  echo "      deployment. Reads are shut the way a jammed lock is shut — no"
  echo "      reader can get in, because there is no key to hold."
fi

if [ "$state" = "CLOSED-UNCONFIRMED" ]; then
  echo "  note: reads are NOT open — but the rejection carries no authorization"
  echo "        payload, so a shut door and a broken deployment look identical"
  echo "        from here. Re-run with CONVEX_READ_TOKEN set; a control pair is"
  echo "        the only thing that settles it."
fi

if [ "$state" = "UNKNOWN" ] && [ "$ctl" = "success" ]; then
  echo "  ⚠️  the probes contradict each other: no credential was REFUSED but a"
  echo "      deliberately wrong one was ACCEPTED. validateReadToken cannot do"
  echo "      that, so something else is answering — and it just served the file"
  echo "      listing to a random string. Treat this as reads being reachable."
fi

echo "STATE: $state"

if [ -n "$expect" ]; then
  want="$(printf '%s' "$expect" | tr '[:lower:]' '[:upper:]')"
  if [ "$state" = "$want" ]; then
    echo "EXPECT $want: OK"
    exit 0
  fi
  case "$state" in
    UNKNOWN)
      echo "EXPECT $want: INDETERMINATE" >&2
      exit 2 ;;
    CLOSED-UNCONFIRMED)
      if [ "$want" = "OPEN" ]; then
        # Not open is not open; that much is settled without a control.
        echo "EXPECT OPEN: MISMATCH (actual $state)" >&2
        exit 1
      fi
      # Refusing to certify ENFORCED without a control probe is the whole fix.
      echo "EXPECT $want: INDETERMINATE (set CONVEX_READ_TOKEN to confirm)" >&2
      exit 2 ;;
    *)
      # OUTAGE lands here against --expect enforced, on purpose: a deployment
      # that refuses the real token has not been cut over, it has been broken.
      echo "EXPECT $want: MISMATCH (actual $state)" >&2
      exit 1 ;;
  esac
fi

case "$state" in
  ENFORCED) exit 0 ;;
  OPEN) exit 10 ;;
  OUTAGE) exit 11 ;;
  CLOSED-UNCONFIRMED) exit 12 ;;
  *) exit 2 ;;
esac
