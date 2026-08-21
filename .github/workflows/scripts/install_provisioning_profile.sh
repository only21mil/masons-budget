#!/usr/bin/env bash
set -euo pipefail

for name in \
  ENCODED_PROFILE \
  PROFILE_DIR \
  PROFILE_UUID \
  PROFILE_EXTENSION \
  GITHUB_ENV \
  RELEASE_STATE_DIR \
  GITHUB_RUN_ID \
  GITHUB_RUN_ATTEMPT \
  PLATFORM; do
  if [ -z "${!name:-}" ]; then
    echo "install-provisioning-profile: $name is required." >&2
    exit 1
  fi
done

if [[ ! "$PROFILE_UUID" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
  echo "install-provisioning-profile: PROFILE_UUID is not a UUID." >&2
  exit 1
fi
if [[ ! "$PROFILE_EXTENSION" =~ ^(mobileprovision|provisionprofile)$ ]]; then
  echo "install-provisioning-profile: unsupported profile extension." >&2
  exit 1
fi
if [[ ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]] ||
  [[ ! "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]] ||
  [[ ! "$PLATFORM" =~ ^(ios|macos)$ ]]; then
  echo "install-provisioning-profile: invalid run identity." >&2
  exit 1
fi
if [ ! -f "$ENCODED_PROFILE" ]; then
  echo "install-provisioning-profile: decoded profile payload is missing." >&2
  exit 1
fi

owner_marker="$RELEASE_STATE_DIR/.vogel-vault-release-owner"
if [ -L "$RELEASE_STATE_DIR" ] ||
  [ ! -d "$RELEASE_STATE_DIR" ] ||
  [ ! -O "$RELEASE_STATE_DIR" ] ||
  [ -L "$owner_marker" ] ||
  [ ! -f "$owner_marker" ] ||
  [ "$(cat "$owner_marker")" != "vogel-vault-release-state-v1" ]; then
  echo "install-provisioning-profile: release state directory is not workflow-owned." >&2
  exit 1
fi

if [ -L "$PROFILE_DIR" ] || { [ -e "$PROFILE_DIR" ] && [ ! -d "$PROFILE_DIR" ]; }; then
  echo "install-provisioning-profile: profile directory must be a real directory." >&2
  exit 1
fi
if [ ! -e "$PROFILE_DIR" ]; then
  (
    umask 077
    mkdir -p "$PROFILE_DIR"
  )
fi
if [ -L "$PROFILE_DIR" ] || [ ! -d "$PROFILE_DIR" ]; then
  echo "install-provisioning-profile: profile directory changed while being prepared." >&2
  exit 1
fi
installed_profile_path="$PROFILE_DIR/$PROFILE_UUID.$PROFILE_EXTENSION"
created_profile=false
path_recorded=false
staged_profile=""
ownership_record="$RELEASE_STATE_DIR/.vogel-vault-owned-profile"
created_marker="$RELEASE_STATE_DIR/.vogel-vault-profile-created"

cleanup_stage() {
  status=$?
  if [ -n "$staged_profile" ]; then
    rm -f "$staged_profile"
  fi
  if [ "$status" -ne 0 ] && [ "$created_profile" = "true" ]; then
    rm -f "$installed_profile_path"
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$ownership_record" "$created_marker"
  fi
  return "$status"
}
trap cleanup_stage EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "install-provisioning-profile: no SHA-256 utility is available." >&2
    return 1
  fi
}

if [ -e "$installed_profile_path" ]; then
  if ! cmp -s "$ENCODED_PROFILE" "$installed_profile_path"; then
    echo "install-provisioning-profile: refusing to replace a different profile at UUID $PROFILE_UUID." >&2
    exit 1
  fi
else
  echo "INSTALLED_PROFILE_PATH=$installed_profile_path" >> "$GITHUB_ENV"
  path_recorded=true
  staged_profile="$PROFILE_DIR/.vogel-vault-profile-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${PLATFORM}"
  if [ -e "$staged_profile" ] || [ -L "$staged_profile" ]; then
    echo "install-provisioning-profile: run-scoped staging path already exists." >&2
    exit 1
  fi
  profile_sha="$(sha256_file "$ENCODED_PROFILE")"
  printf '%s\t%s\t%s\t%s\n' \
    "$PROFILE_UUID" \
    "$PROFILE_EXTENSION" \
    "$profile_sha" \
    "${staged_profile##*/}" > "$ownership_record"
  chmod 600 "$ownership_record"
  install -m 600 "$ENCODED_PROFILE" "$staged_profile"
  if ln "$staged_profile" "$installed_profile_path" 2>/dev/null; then
    created_profile=true
    printf '%s\n' "vogel-vault-release-state-v1" > "$created_marker"
    chmod 600 "$created_marker"
  elif ! cmp -s "$ENCODED_PROFILE" "$installed_profile_path"; then
    echo "install-provisioning-profile: UUID path appeared with different contents; refusing to replace it." >&2
    exit 1
  fi
fi

{
  if [ "$path_recorded" = "false" ]; then
    echo "INSTALLED_PROFILE_PATH=$installed_profile_path"
  fi
  echo "CREATED_PROFILE=$created_profile"
} >> "$GITHUB_ENV"

if [ "$created_profile" = "true" ]; then
  echo "Installed a run-created provisioning profile."
else
  echo "Reused the identical provisioning profile already present on this host."
fi
