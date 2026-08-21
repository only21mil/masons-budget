#!/usr/bin/env bash
set -euo pipefail

: "${KEYSTORE_PATH:?KEYSTORE_PATH must name the decoded Android debug keystore}"

if [ ! -s "$KEYSTORE_PATH" ]; then
  echo "::error::The Android debug keystore is missing or empty." >&2
  exit 1
fi

export VOGEL_VALIDATION_STORE_PASSWORD="${VOGEL_DEBUG_KEYSTORE_PASSWORD:-android}"
export VOGEL_VALIDATION_KEY_PASSWORD="${VOGEL_DEBUG_KEY_PASSWORD:-android}"
readonly key_alias="${VOGEL_DEBUG_KEY_ALIAS:-androiddebugkey}"
validation_directory="$(mktemp -d)"
readonly validation_directory
trap 'rm -rf "$validation_directory"' EXIT

# Keep certificate details and password prompts out of the log. Listing checks
# the decoded store and alias; signing a disposable jar also proves that the
# private-key password works before Gradle sees any signing configuration.
mkdir "$validation_directory/payload"
printf 'validation\n' > "$validation_directory/payload/marker"
jar --create \
  --file "$validation_directory/validation.jar" \
  -C "$validation_directory/payload" . \
  >/dev/null 2>&1

if ! keytool -list \
  -keystore "$KEYSTORE_PATH" \
  -storepass:env VOGEL_VALIDATION_STORE_PASSWORD \
  -alias "$key_alias" \
  >/dev/null 2>&1 || \
  ! jarsigner \
  -keystore "$KEYSTORE_PATH" \
  -storepass:env VOGEL_VALIDATION_STORE_PASSWORD \
  -keypass:env VOGEL_VALIDATION_KEY_PASSWORD \
  "$validation_directory/validation.jar" "$key_alias" \
  >/dev/null 2>&1; then
  echo "::error::The decoded Android debug keystore or its credentials are invalid." >&2
  exit 1
fi
