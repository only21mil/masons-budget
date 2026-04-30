#!/usr/bin/env bash
#
# Move ~/Workspace MC2/mission-control to iCloud Drive, symlink old path back.
#
# Pre-flight:
#   1. Stop any running MC2 background processes (archimedes, voice-cache, heartbeat workers).
#   2. Confirm iCloud Drive is signed in and has space.
#   3. Make a backup of mission-control before running this script.
#
# Run with:  bash scripts/move-mc2-to-icloud.sh
#
# Idempotent: if mission-control is already a symlink to iCloud, this is a no-op.

set -euo pipefail

OLD_PATH="$HOME/Workspace MC2/mission-control"
ICLOUD_BASE="$HOME/Library/Mobile Documents/com~apple~CloudDocs/MC2"
NEW_PATH="$ICLOUD_BASE/mission-control"
BACKUP_DIR="$HOME/Workspace MC2/.backups/mission-control-$(date +%Y%m%d-%H%M%S)"

echo "==> Checking preconditions"

if [[ ! -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]]; then
  echo "ERROR: iCloud Drive does not appear to be set up at the standard path."
  echo "Open Finder → Sidebar → iCloud Drive once to initialize, then re-run."
  exit 1
fi

if [[ -L "$OLD_PATH" ]]; then
  current_target="$(readlink "$OLD_PATH")"
  if [[ "$current_target" == "$NEW_PATH" ]]; then
    echo "Already symlinked correctly. Nothing to do."
    exit 0
  fi
  echo "ERROR: $OLD_PATH is already a symlink, but points to $current_target instead of $NEW_PATH."
  echo "Resolve manually before re-running."
  exit 1
fi

if [[ ! -d "$OLD_PATH" ]]; then
  echo "ERROR: $OLD_PATH does not exist or is not a directory."
  exit 1
fi

if [[ -e "$NEW_PATH" ]]; then
  echo "ERROR: $NEW_PATH already exists. Refusing to overwrite."
  echo "If this is from a prior failed run, inspect and remove $NEW_PATH manually."
  exit 1
fi

echo "==> Creating safety backup at $BACKUP_DIR"
mkdir -p "$(dirname "$BACKUP_DIR")"
cp -R "$OLD_PATH" "$BACKUP_DIR"
echo "Backup created. To restore: rm -rf '$OLD_PATH' && mv '$BACKUP_DIR' '$OLD_PATH'"

echo "==> Ensuring iCloud Drive base directory exists"
mkdir -p "$ICLOUD_BASE"

echo "==> Moving $OLD_PATH → $NEW_PATH"
mv "$OLD_PATH" "$NEW_PATH"

echo "==> Creating symlink at $OLD_PATH → $NEW_PATH"
ln -s "$NEW_PATH" "$OLD_PATH"

echo "==> Verifying"
if [[ ! -L "$OLD_PATH" ]]; then
  echo "ERROR: Symlink not created."
  exit 1
fi

# Spot check that a known file is readable through the symlink
if [[ -f "$OLD_PATH/balances.json" ]]; then
  echo "OK: balances.json readable via symlink path."
else
  echo "WARN: balances.json not found through symlink. Investigate."
fi

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1. Open Finder → iCloud Drive → MC2 → mission-control. Confirm files are listed."
echo "  2. Wait a few minutes for the initial upload to finish (icon shows cloud→checkmark)."
echo "  3. Restart any MC2 background processes you stopped."
echo "  4. Verify any tooling that writes mission-control still works (run a known job)."
echo ""
echo "Rollback (if needed):"
echo "  rm '$OLD_PATH'"
echo "  mv '$NEW_PATH' '$OLD_PATH'"
