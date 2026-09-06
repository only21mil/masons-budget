#!/usr/bin/env bash
# Runs only on an ephemeral, secret-free GitHub-hosted Mac.
set -euo pipefail
: "${SOURCE_SHA:?}" "${VERSION:?}" "${ARCH:?}" "${BUZZ_UPDATER_PUBLIC_KEY:?}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
[[ "$ARCH" == aarch64 || "$ARCH" == x86_64 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
TARGET="$ARCH-apple-darwin"
export TARGET
python3 - <<'PY'
import json, os
from pathlib import Path
assert json.loads(Path('desktop/src-tauri/tauri.conf.json').read_text())['version'] == os.environ['VERSION'], 'source version differs'
PY
just desktop-install-ci
rustup target add "$TARGET"
(cd desktop && node scripts/build-release-config.mjs)
# Archive signing is isolated in the next job. Keep the real updater config,
# but defer createUpdaterArtifacts so this build never needs a private key.
python3 - <<'PY'
import json
from pathlib import Path
p = Path('desktop/src-tauri/tauri.release.conf.json')
c = json.loads(p.read_text())
c['bundle']['createUpdaterArtifacts'] = False
p.write_text(json.dumps(c, indent=2) + '\n')
PY
cargo build --locked --release --target "$TARGET" -p buzz-acp -p buzz-agent -p buzz-backend-kubernetes -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli
./scripts/bundle-sidecars.sh "$TARGET"
FEATURES=()
if [[ "$ARCH" == aarch64 ]]; then
  FEATURES=(--features mesh-llm)
  cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml
  MESH_ROOT=$(python3 - <<'PY'
import os, tomllib
from pathlib import Path
p = next(p for p in tomllib.loads(Path('Cargo.lock').read_text())['package'] if p['name'] == 'mesh-llm-sdk')
short = p['source'].rsplit('#', 1)[1][:7]
paths = list((Path(os.environ.get('CARGO_HOME', str(Path.home()/'.cargo')))/'git/checkouts').glob('*/'+short))
assert len(paths) == 1, 'mesh checkout must resolve uniquely'
print(paths[0])
PY
)
  export LLAMA_STAGE_BACKEND=metal
  export LLAMA_STAGE_BUILD_DIR="$GITHUB_WORKSPACE/buzz/.cache/mesh-llama/build-stage-abi-metal"
  export SKIPPY_LLAMA_AUTO_BUILD=0
  "$MESH_ROOT/scripts/prepare-llama.sh" pinned
  "$MESH_ROOT/scripts/build-llama.sh" -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15
fi
(cd desktop && pnpm tauri build --verbose --no-sign --target "$TARGET" --bundles app "${FEATURES[@]}" --config src-tauri/tauri.release.conf.json)
python3 ../controller/.github/workflows/scripts/buzz_macos_release.py pack \
  --app "desktop/src-tauri/target/$TARGET/release/bundle/macos/Buzz.app" \
  --output ../unsigned --source "$SOURCE_SHA" --version "$VERSION" --arch "$ARCH"
