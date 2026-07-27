#!/usr/bin/env bash
set -euo pipefail

readonly stable_signing="${STABLE_SIGNING:-false}"
readonly apk_directory="${APK_DIRECTORY:-android/app/build/outputs/apk/debug}"
readonly build_tools_directory="${ANDROID_HOME:-/usr/local/lib/android/sdk}/build-tools"

fail_if_stable() {
  if [ "$stable_signing" = "true" ]; then
    echo "::error::Stable Android signing was claimed, but no SHA-256 certificate digest could be verified." >&2
    exit 1
  fi
  exit 0
}

shopt -s nullglob
apks=("$apk_directory"/*.apk)
if [ "${#apks[@]}" -eq 0 ]; then
  fail_if_stable
fi

mapfile -d '' apksigners < <(find "$build_tools_directory" -type f -name apksigner -print0 2>/dev/null | sort -zV)
if [ "${#apksigners[@]}" -eq 0 ]; then
  fail_if_stable
fi

certificate_output=$(
  "${apksigners[-1]}" verify --print-certs "${apks[0]}" 2>/dev/null
) || fail_if_stable

digest=$(printf '%s\n' "$certificate_output" | awk -F': ' '/^Signer #1 certificate SHA-256 digest: / { print $2; exit }')
digest=$(printf '%s' "$digest" | tr '[:upper:]' '[:lower:]' | tr -d ':[:space:]')

if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
  fail_if_stable
fi

printf 'ANDROID_DEBUG_CERT_SHA256=%s\n' "$digest"
