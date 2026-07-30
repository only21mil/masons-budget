#!/usr/bin/env bash
set -euo pipefail

for name in ENCODED_PROFILE PROFILE_DIR PROFILE_UUID PROFILE_EXTENSION GITHUB_ENV; do
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
if [ ! -f "$ENCODED_PROFILE" ]; then
  echo "install-provisioning-profile: decoded profile payload is missing." >&2
  exit 1
fi

install -d -m 700 "$PROFILE_DIR"
installed_profile_path="$PROFILE_DIR/$PROFILE_UUID.$PROFILE_EXTENSION"
created_profile=false
path_recorded=false
staged_profile=""

cleanup_stage() {
  status=$?
  if [ -n "$staged_profile" ]; then
    rm -f "$staged_profile"
  fi
  if [ "$status" -ne 0 ] && [ "$created_profile" = "true" ]; then
    rm -f "$installed_profile_path"
  fi
  return "$status"
}
trap cleanup_stage EXIT

if [ -e "$installed_profile_path" ]; then
  if ! cmp -s "$ENCODED_PROFILE" "$installed_profile_path"; then
    echo "install-provisioning-profile: refusing to replace a different profile at UUID $PROFILE_UUID." >&2
    exit 1
  fi
else
  echo "INSTALLED_PROFILE_PATH=$installed_profile_path" >> "$GITHUB_ENV"
  path_recorded=true
  staged_profile="$(mktemp "$PROFILE_DIR/.vogel-vault-profile.XXXXXX")"
  install -m 600 "$ENCODED_PROFILE" "$staged_profile"
  if ln "$staged_profile" "$installed_profile_path" 2>/dev/null; then
    created_profile=true
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
