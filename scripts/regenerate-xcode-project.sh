#!/usr/bin/env bash
#
# Reproduce the committed Xcode project from MasonsBudget/project.yml.
#
# This is intentionally usable on Linux as well as macOS. If the pinned
# XcodeGen is not already installed, the script downloads its checksummed source
# archive and builds the command with Swift into the ignored .build directory.

set -euo pipefail

readonly XCODEGEN_VERSION="2.46.0"
readonly XCODEGEN_SHA256="c83c7bd70255b0ddf4116dadce16bdf0e5939165b43a544e124de294ec84aa27"
readonly SWIFT_CONTAINER_IMAGE="docker.io/library/swift@sha256:1c1f422aee767a7f33b88bc3aee99cad5de4af8723fbee8a3ab6951a6879f929"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$REPO_ROOT/MasonsBudget"
SPEC_PATH="$PROJECT_ROOT/project.yml"
COMMITTED_PROJECT="$PROJECT_ROOT/MasonsBudget.xcodeproj"
TOOL_ROOT="$REPO_ROOT/.build/tools/xcodegen/$XCODEGEN_VERSION"
XCODEGEN_SOURCE="$TOOL_ROOT/source"
PINNED_XCODEGEN="$XCODEGEN_SOURCE/.build/release/xcodegen"
PINNED_XCODEGEN_COMPLETE="$TOOL_ROOT/.complete"
SOURCE_ARCHIVE="$REPO_ROOT/.build/downloads/xcodegen-$XCODEGEN_VERSION.tar.gz"
MODE="write"

usage() {
  cat <<'EOF'
Usage: scripts/regenerate-xcode-project.sh [--check]

With no arguments, regenerate MasonsBudget.xcodeproj from project.yml.

Options:
  --check  Compare a clean generated project with the committed project without
           changing the worktree. Exits nonzero when they differ.
  --help   Show this help.

The script runs on Linux and macOS. It uses XcodeGen 2.46.0, bootstrapping the
checksummed source release into the ignored .build directory when necessary.
If Swift is not installed, it uses Podman or Docker with a digest-pinned
official Swift image.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

checksum_archive() {
  local archive="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$XCODEGEN_SHA256" "$archive" |
      sha256sum --check --strict -
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$XCODEGEN_SHA256" "$archive" |
      shasum -a 256 --check -
  else
    printf 'ERROR: sha256sum or shasum is required to verify XcodeGen.\n' >&2
    exit 2
  fi
}

ensure_source_archive() {
  if [[ -f "$SOURCE_ARCHIVE" ]] &&
    checksum_archive "$SOURCE_ARCHIVE" >/dev/null 2>&1; then
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    printf 'ERROR: curl is required to download XcodeGen source.\n' >&2
    exit 2
  fi

  mkdir -p "$(dirname "$SOURCE_ARCHIVE")"
  archive_download="$SOURCE_ARCHIVE.part"
  curl --fail --silent --show-error --location --retry 3 \
    -o "$archive_download" \
    "https://github.com/yonaskolb/XcodeGen/archive/refs/tags/${XCODEGEN_VERSION}.tar.gz"
  checksum_archive "$archive_download"
  mv "$archive_download" "$SOURCE_ARCHIVE"
}

if ! command -v swift >/dev/null 2>&1; then
  container_runtime=""
  if command -v podman >/dev/null 2>&1; then
    container_runtime="podman"
  elif command -v docker >/dev/null 2>&1; then
    container_runtime="docker"
  fi

  if [[ -z "$container_runtime" ]]; then
    printf '%s\n' \
      'ERROR: Swift is not installed and neither Podman nor Docker is available.' \
      'Install Swift 6, Podman, or Docker; no Apple SDK or Mac is required.' >&2
    exit 2
  fi

  # The official Swift image deliberately omits download tools. Fetch and
  # verify the source archive on the host, then let the container build it.
  ensure_source_archive

  container_args=(
    run
    --rm
    --env HOME=/tmp/vv-home
    --env USER="$(id -un)"
    --env LOGNAME="$(id -un)"
    --user "$(id -u):$(id -g)"
    --volume "$REPO_ROOT:/workspace"
    --workdir /workspace
  )
  # Foundation asks the system user database for the current name while
  # generating PBX metadata. Preserve the host UID/GID and make that identity
  # resolvable inside the container.
  if [[ -r /etc/passwd && -r /etc/group ]]; then
    container_args+=(
      --volume /etc/passwd:/etc/passwd:ro
      --volume /etc/group:/etc/group:ro
    )
  fi
  if [[ "$container_runtime" == "podman" ]]; then
    container_args+=(--userns keep-id --security-opt label=disable)
  fi

  script_args=()
  if [[ "$MODE" == "check" ]]; then
    script_args+=(--check)
  fi
  printf 'Swift is unavailable; running with %s and the pinned Swift image.\n' \
    "$container_runtime"
  exec "$container_runtime" "${container_args[@]}" \
    "$SWIFT_CONTAINER_IMAGE" \
    scripts/regenerate-xcode-project.sh "${script_args[@]}"
fi

for required in git tar; do
  if ! command -v "$required" >/dev/null 2>&1; then
    printf 'ERROR: required tool not found: %s\n' "$required" >&2
    exit 2
  fi
done

installed_xcodegen=""
if command -v xcodegen >/dev/null 2>&1; then
  installed_version="$(xcodegen --version | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  if [[ "$installed_version" == "$XCODEGEN_VERSION" ]]; then
    installed_xcodegen="$(command -v xcodegen)"
  fi
fi

if [[ -n "$installed_xcodegen" ]]; then
  XCODEGEN_BIN="$installed_xcodegen"
elif [[ -x "$PINNED_XCODEGEN" && -f "$PINNED_XCODEGEN_COMPLETE" ]]; then
  XCODEGEN_BIN="$PINNED_XCODEGEN"
else
  printf 'Bootstrapping XcodeGen %s from its checksummed source release...\n' \
    "$XCODEGEN_VERSION"
  ensure_source_archive
  mkdir -p "$XCODEGEN_SOURCE"
  tar xzf "$SOURCE_ARCHIVE" -C "$XCODEGEN_SOURCE" --strip-components=1
  (
    cd "$XCODEGEN_SOURCE"
    swift build \
      --configuration release \
      --product xcodegen
  )
  # Linux SwiftPM records the resource bundle's build path in the executable.
  # Keep the complete source/build tree at this stable ignored path.
  touch "$PINNED_XCODEGEN_COMPLETE"
  XCODEGEN_BIN="$PINNED_XCODEGEN"
fi

# Linux XcodeGen cannot copy the workspace bundle across the container overlay
# boundary. Keep the comparison and backup in the repo's ignored build tree,
# which is also visible inside Podman or Docker.
mkdir -p "$REPO_ROOT/.build/tmp"
generation_dir="$(mktemp -d "$REPO_ROOT/.build/tmp/vv-xcode-project.XXXXXX")"
generated_root="$generation_dir/output"
generated_project="$generated_root/MasonsBudget.xcodeproj"
backup_project="$generation_dir/committed-MasonsBudget.xcodeproj"
generation_active=0
mkdir -p "$generated_root"

restore_committed_project() {
  if [[ "$generation_active" -eq 1 ]]; then
    if [[ -e "$COMMITTED_PROJECT" ]]; then
      mv "$COMMITTED_PROJECT" "$generation_dir/abandoned-MasonsBudget.xcodeproj"
    fi
    if [[ -e "$backup_project" ]]; then
      mv "$backup_project" "$COMMITTED_PROJECT"
    fi
  fi
  rm -rf "$generation_dir"
}
trap restore_committed_project EXIT

# Generate at project.yml's real location so XcodeGen computes the same relative
# PBX paths as normal local and CI generation. Move the committed bundle aside
# only for the duration of generation, with the EXIT trap restoring it after
# failures or interruptions.
if [[ -e "$COMMITTED_PROJECT" ]]; then
  mv "$COMMITTED_PROJECT" "$backup_project"
fi
generation_active=1
if ! "$XCODEGEN_BIN" generate --spec "$SPEC_PATH" --quiet; then
  printf 'ERROR: XcodeGen failed; the committed project was restored.\n' >&2
  exit 1
fi
mv "$COMMITTED_PROJECT" "$generated_project"
if [[ -e "$backup_project" ]]; then
  mv "$backup_project" "$COMMITTED_PROJECT"
fi
generation_active=0

if [[ ! -f "$generated_project/project.pbxproj" ]]; then
  printf 'ERROR: XcodeGen did not produce %s.\n' \
    "$generated_project/project.pbxproj" >&2
  exit 1
fi

if [[ -d "$COMMITTED_PROJECT" ]] &&
  diff --recursive --brief "$COMMITTED_PROJECT" "$generated_project" >/dev/null; then
  printf 'PASS: MasonsBudget.xcodeproj matches project.yml.\n'
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  if [[ -d "$COMMITTED_PROJECT" ]]; then
    diff --recursive --brief "$COMMITTED_PROJECT" "$generated_project" || true
  else
    printf 'Only in generated output: MasonsBudget.xcodeproj\n'
  fi
  printf '%s\n' \
    'FAIL: MasonsBudget.xcodeproj is stale.' \
    'Fix it on Linux or macOS with:' \
    '  scripts/regenerate-xcode-project.sh' \
    'Then commit the resulting MasonsBudget/MasonsBudget.xcodeproj changes.'
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '%s\n' \
      '::error title=Committed Xcode project is stale::Run scripts/regenerate-xcode-project.sh on Linux or macOS, then commit MasonsBudget/MasonsBudget.xcodeproj.'
  fi
  exit 1
fi

backup_project="$generation_dir/previous-MasonsBudget.xcodeproj"
if [[ -e "$COMMITTED_PROJECT" ]]; then
  mv "$COMMITTED_PROJECT" "$backup_project"
fi
if ! mv "$generated_project" "$COMMITTED_PROJECT"; then
  if [[ -e "$backup_project" ]]; then
    mv "$backup_project" "$COMMITTED_PROJECT"
  fi
  printf 'ERROR: could not replace %s.\n' "$COMMITTED_PROJECT" >&2
  exit 1
fi

printf 'Regenerated MasonsBudget.xcodeproj with XcodeGen %s.\n' \
  "$XCODEGEN_VERSION"
git -C "$REPO_ROOT" status --short -- MasonsBudget/MasonsBudget.xcodeproj
