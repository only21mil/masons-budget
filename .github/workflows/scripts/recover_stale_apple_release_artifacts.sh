#!/usr/bin/env bash
set -euo pipefail

readonly OWNER_MARKER=".vogel-vault-release-owner"
readonly OWNER_MAGIC="vogel-vault-release-state-v1"
readonly PROFILE_RECORD=".vogel-vault-owned-profile"
readonly PROFILE_CREATED_MARKER=".vogel-vault-profile-created"

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "recover-apple-release: RUNNER_TEMP is required." >&2
  exit 1
fi
if [ -L "$RUNNER_TEMP" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "recover-apple-release: RUNNER_TEMP must be a real directory." >&2
  exit 1
fi

PROFILE_DIR="${PROFILE_DIR:-$HOME/Library/MobileDevice/Provisioning Profiles}"
cleanup_failed=false
blocked_release_roots=()

is_owned_directory() {
  local directory=$1
  local marker="$directory/$OWNER_MARKER"

  [ -d "$directory" ] &&
    [ ! -L "$directory" ] &&
    [ -O "$directory" ] &&
    [ -f "$marker" ] &&
    [ ! -L "$marker" ] &&
    [ "$(cat "$marker")" = "$OWNER_MAGIC" ]
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "::error::No SHA-256 utility is available for ownership verification." >&2
    return 1
  fi
}

remove_owned_profile() {
  local signing_root=$1
  local suffix=$2
  local record="$signing_root/$PROFILE_RECORD"
  local created_marker="$signing_root/$PROFILE_CREATED_MARKER"
  local uuid extension expected_sha stage_name extra
  local target stage

  [ -e "$record" ] || return 0
  if [ -L "$record" ] || [ ! -f "$record" ]; then
    echo "::error::Refusing malformed profile ownership record in $signing_root."
    return 1
  fi

  IFS=$'\t' read -r uuid extension expected_sha stage_name extra < "$record" || true
  if [[ ! "$uuid" =~ ^[0-9A-Fa-f-]{36}$ ]] ||
    [[ ! "$extension" =~ ^(mobileprovision|provisionprofile)$ ]] ||
    [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]] ||
    [ "$stage_name" != ".vogel-vault-profile-$suffix" ] ||
    [ -n "${extra:-}" ]; then
    echo "::error::Refusing invalid profile ownership metadata in $signing_root."
    return 1
  fi

  if [ -L "$PROFILE_DIR" ] || { [ -e "$PROFILE_DIR" ] && [ ! -d "$PROFILE_DIR" ]; }; then
    echo "::error::Refusing profile cleanup through an unsafe profile directory."
    return 1
  fi

  target="$PROFILE_DIR/$uuid.$extension"
  stage="$PROFILE_DIR/$stage_name"

  if [ -e "$created_marker" ]; then
    if [ -L "$created_marker" ] ||
      [ ! -f "$created_marker" ] ||
      [ "$(cat "$created_marker")" != "$OWNER_MAGIC" ]; then
      echo "::error::Refusing an invalid created-profile marker in $signing_root."
      return 1
    fi
    if [ -e "$target" ] || [ -L "$target" ]; then
      if [ -L "$target" ] ||
        [ ! -f "$target" ] ||
        [ "$(sha256_file "$target")" != "$expected_sha" ]; then
        echo "::error::Refusing to remove a profile whose ownership digest no longer matches."
        return 1
      fi
      rm -f -- "$target"
    fi
  elif [ -e "$target" ] && [ -e "$stage" ] && [ "$target" -ef "$stage" ]; then
    if [ -L "$target" ] ||
      [ ! -f "$target" ] ||
      [ "$(sha256_file "$target")" != "$expected_sha" ]; then
      echo "::error::Refusing to remove an interrupted profile link with a mismatched digest."
      return 1
    fi
    rm -f -- "$target"
  fi

  if [ -e "$stage" ] || [ -L "$stage" ]; then
    if [ -L "$stage" ] ||
      [ ! -f "$stage" ] ||
      [ "$(sha256_file "$stage")" != "$expected_sha" ]; then
      echo "::error::Refusing to remove an unsafe staged profile."
      return 1
    fi
    rm -f -- "$stage"
  fi
}

remove_keychain_from_search_list() {
  local keychain_path=$1
  local keychain_output keychain
  local found=false
  local -a filtered_keychains=()

  if ! keychain_output="$(security list-keychains -d user)"; then
    echo "::error::Could not read the current user keychain search list."
    return 1
  fi

  while IFS= read -r keychain; do
    keychain="$(printf '%s\n' "$keychain" |
      sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
    [ -n "$keychain" ] || continue
    if [ "$keychain" = "$keychain_path" ]; then
      found=true
    else
      filtered_keychains+=("$keychain")
    fi
  done <<< "$keychain_output"

  if [ "$found" = "true" ] &&
    ! security list-keychains -d user -s "${filtered_keychains[@]}"; then
    echo "::error::Could not remove the stale release keychain from the search list."
    return 1
  fi
}

remove_owned_release_root() {
  local release_root=$1

  [ -e "$release_root" ] || return 0
  if ! is_owned_directory "$release_root"; then
    echo "::warning::Preserving unowned release lookalike: $release_root"
    return 0
  fi
  rm -rf -- "$release_root"
}

remove_owned_signing_root() {
  local signing_root=$1
  local basename suffix keychain_path release_root

  basename=${signing_root##*/}
  if [[ ! "$basename" =~ ^vogel-vault-signing-([0-9]+-[0-9]+-(ios|macos))$ ]]; then
    echo "::warning::Preserving signing path with an invalid run-scoped name: $signing_root"
    return 0
  fi
  suffix=${BASH_REMATCH[1]}
  if ! is_owned_directory "$signing_root"; then
    echo "::warning::Preserving unowned signing lookalike: $signing_root"
    return 0
  fi

  if ! remove_owned_profile "$signing_root" "$suffix"; then
    return 1
  fi

  keychain_path="$signing_root/manual-signing.keychain-db"
  if [ -L "$keychain_path" ] ||
    { [ -e "$keychain_path" ] && [ ! -f "$keychain_path" ]; }; then
    echo "::error::Refusing to remove an unsafe run-owned keychain path."
    return 1
  fi
  if ! remove_keychain_from_search_list "$keychain_path"; then
    return 1
  fi
  if [ -e "$keychain_path" ]; then
    if ! security delete-keychain "$keychain_path"; then
      echo "::error::Could not delete the stale run-owned keychain."
      return 1
    fi
  fi

  release_root="$RUNNER_TEMP/vogel-vault-release-$suffix"
  if ! remove_owned_release_root "$release_root"; then
    return 1
  fi
  rm -rf -- "$signing_root"
}

shopt -s nullglob
for signing_root in "$RUNNER_TEMP"/vogel-vault-signing-*; do
  if ! remove_owned_signing_root "$signing_root"; then
    cleanup_failed=true
    signing_basename=${signing_root##*/}
    blocked_release_roots+=(
      "$RUNNER_TEMP/${signing_basename/vogel-vault-signing-/vogel-vault-release-}"
    )
  fi
done

# A crash can happen after the signing root was removed but before its release
# root. Recover those marker-validated orphans independently.
for release_root in "$RUNNER_TEMP"/vogel-vault-release-*; do
  release_blocked=false
  if [ "${#blocked_release_roots[@]}" -gt 0 ]; then
    for blocked_release_root in "${blocked_release_roots[@]}"; do
      if [ "$release_root" = "$blocked_release_root" ]; then
        release_blocked=true
        break
      fi
    done
  fi
  if [ "$release_blocked" = "true" ]; then
    continue
  fi
  release_basename=${release_root##*/}
  if [[ ! "$release_basename" =~ ^vogel-vault-release-[0-9]+-[0-9]+-(ios|macos)$ ]]; then
    echo "::warning::Preserving release path with an invalid run-scoped name: $release_root"
    continue
  fi
  if ! remove_owned_release_root "$release_root"; then
    cleanup_failed=true
  fi
done

[ "$cleanup_failed" = "false" ]
