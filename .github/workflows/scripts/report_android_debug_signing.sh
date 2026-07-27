#!/usr/bin/env bash
set -euo pipefail

# Emits the APK's signing certificate SHA-256 so a stable-signed default-branch
# build is provably stable rather than merely claimed.
#
# Every bail-out below used to funnel into one identical message, so a failure
# said "no digest could be verified" without saying WHICH of four very different
# things went wrong — missing APK, missing apksigner, apksigner erroring, or an
# unparseable digest. That cost a full CI cycle to distinguish. Each guard now
# names itself and dumps what it actually looked at.

readonly stable_signing="${STABLE_SIGNING:-false}"
readonly apk_directory="${APK_DIRECTORY:-android/app/build/outputs/apk/debug}"
readonly sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"

fail_if_stable() {
  local reason="$1"
  echo "report_android_debug_signing: ${reason}" >&2
  echo "  cwd            : $(pwd)" >&2
  echo "  apk_directory  : ${apk_directory}" >&2
  echo "  sdk_root       : ${sdk_root}" >&2
  echo "  stable_signing : ${stable_signing}" >&2
  echo "  apk candidates :" >&2
  find android -type f -name '*.apk' 2>/dev/null | head -10 | sed 's/^/    /' >&2 ||
    echo "    (none found anywhere under android/)" >&2
  if [ "$stable_signing" = "true" ]; then
    echo "::error::Stable Android signing was claimed, but no SHA-256 certificate digest could be verified: ${reason}" >&2
    exit 1
  fi
  exit 0
}

shopt -s nullglob
apks=("$apk_directory"/*.apk)
if [ "${#apks[@]}" -eq 0 ]; then
  # The configured directory is the expected location, not the only possible
  # one: a variant or a changed output dir puts the APK elsewhere under the
  # module. Fall back to a search before declaring the APK missing.
  mapfile -d '' apks < <(find android -type f -name '*.apk' -print0 2>/dev/null | sort -z)
fi
if [ "${#apks[@]}" -eq 0 ]; then
  fail_if_stable "no .apk found in ${apk_directory} or anywhere under android/"
fi
readonly apk="${apks[0]}"

# apksigner lives under build-tools/<version>/, but the SDK layout and the
# variable naming it up (ANDROID_HOME vs ANDROID_SDK_ROOT) both vary by runner
# image. Search the whole SDK root, then fall back to PATH.
mapfile -d '' apksigners < <(find "$sdk_root" -type f -name apksigner -print0 2>/dev/null | sort -zV)
if [ "${#apksigners[@]}" -eq 0 ] && command -v apksigner >/dev/null 2>&1; then
  apksigners=("$(command -v apksigner)")
fi
if [ "${#apksigners[@]}" -eq 0 ]; then
  fail_if_stable "no apksigner under ${sdk_root} or on PATH"
fi
readonly apksigner="${apksigners[-1]}"

if ! certificate_output=$("$apksigner" verify --print-certs "$apk" 2>&1); then
  echo "  apksigner output:" >&2
  printf '%s\n' "$certificate_output" | head -10 | sed 's/^/    /' >&2
  fail_if_stable "apksigner could not verify ${apk}"
fi

digest=$(printf '%s\n' "$certificate_output" |
  awk -F': ' '/certificate SHA-256 digest: / { print $2; exit }')
digest=$(printf '%s' "$digest" | tr '[:upper:]' '[:lower:]' | tr -d ':[:space:]')

if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo "  apksigner output:" >&2
  printf '%s\n' "$certificate_output" | head -10 | sed 's/^/    /' >&2
  fail_if_stable "could not parse a 64-hex SHA-256 digest out of apksigner's output"
fi

echo "signed apk : ${apk}"
printf 'ANDROID_DEBUG_CERT_SHA256=%s\n' "$digest"
