#!/usr/bin/env bash
# Runs only inside buzz_macos_build_boundary.py on the MBP.
set -euo pipefail
: "${SOURCE_SHA:?}" "${VERSION:?}" "${ARCH:?}" "${BUZZ_UPDATER_PUBLIC_KEY:?}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
[[ "$ARCH" == aarch64 || "$ARCH" == x86_64 ]]
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
TARGET="$ARCH-apple-darwin"
export TARGET
# Use the same system Git TLS path that fetched the isolated source successfully.
export CARGO_NET_GIT_FETCH_WITH_CLI=true
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
BUILD_ARGS=(--verbose --no-sign --target "$TARGET" --bundles app)
if [[ "$ARCH" == aarch64 ]]; then
  BUILD_ARGS+=(--features mesh-llm)
  cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml
  MESH_ROOT=$(cargo metadata --locked --features mesh-llm --format-version 1 --manifest-path desktop/src-tauri/Cargo.toml | python3 -c '
import json, os, re, sys
from pathlib import Path
packages = [p for p in json.load(sys.stdin)["packages"] if p["name"] == "mesh-llm-sdk"]
if len(packages) != 1:
    sys.exit("mesh checkout must resolve uniquely")
package = packages[0]
if not re.fullmatch(r"git\+https://github\.com/Mesh-LLM/mesh-llm\.git(?:\?[^#]+)?#[0-9a-f]{40}", package.get("source") or ""):
    sys.exit("mesh SDK must come from the locked Mesh-LLM Git dependency")
manifest = Path(package["manifest_path"])
# The pinned dependency is a workspace: Cargo reports the SDK crate manifest,
# while its llama preparation/build scripts belong to the repository root.
if not manifest.is_absolute() or manifest.parts[-3:] != ("crates", "mesh-llm-sdk", "Cargo.toml"):
    sys.exit("unsupported mesh SDK manifest layout")
root = manifest.parents[2].resolve()
required = [root / "crates/mesh-llm-sdk/Cargo.toml", root / "Cargo.toml",
            root / "scripts/prepare-llama.sh", root / "scripts/build-llama.sh"]
if any(not path.is_file() or path.resolve() != path for path in required):
    sys.exit("mesh workspace requires regular manifests and scripts at the supported paths")
if any(not os.access(path, os.X_OK) for path in required[2:]):
    sys.exit("mesh workspace build scripts must be executable")
print(root)
')
  export LLAMA_STAGE_BACKEND=metal
  export LLAMA_STAGE_BUILD_DIR="$GITHUB_WORKSPACE/buzz/.cache/mesh-llama/build-stage-abi-metal"
  export SKIPPY_LLAMA_AUTO_BUILD=0
  "$MESH_ROOT/scripts/prepare-llama.sh" pinned
  "$MESH_ROOT/scripts/build-llama.sh" -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15
fi
(cd desktop && pnpm tauri build "${BUILD_ARGS[@]}" --config src-tauri/tauri.release.conf.json)
