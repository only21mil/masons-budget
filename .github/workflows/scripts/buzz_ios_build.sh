#!/usr/bin/env bash
# Public inputs only, under the installed dedicated-UID build supervisor.
set -euo pipefail
: "${SOURCE_SHA:?}" "${VERSION:?}" "${BUILD_NUMBER:?}"
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]{0,8}$ ]]
test ! -e mobile/ios/Flutter/AppOverrides.xcconfig
cat > mobile/ios/Flutter/AppOverrides.xcconfig <<'CONFIG'
BUNDLE_IDENTIFIER = com.sats21m.buzz
APP_DISPLAY_NAME = Buzz
BUZZ_DEVELOPMENT_TEAM = 384ZGKG4GB
BUZZ_APP_GROUP_IDENTIFIER = group.com.sats21m.buzz
BUZZ_KEYCHAIN_ACCESS_GROUP = com.sats21m.buzz
BUZZ_IOS_PUSH_ENVIRONMENT = production
BUZZ_APP_ATTEST_ENVIRONMENT = production
CONFIG
# Flutter's initial xcrun xcodebuild -list does not forward build settings.
# Its manifest compiler inherits our outer sandbox; avoid an unsupported nested
# sandbox without granting cfprefsd or changing global Xcode preferences.
mkdir "$HOME/xcode-tools"
cat > "$HOME/xcode-tools/xcrun" <<'XCRUN'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == xcodebuild ]]; then
  shift
  exec /usr/bin/xcrun xcodebuild -IDEPackageSupportDisableManifestSandbox=YES "$@"
fi
exec /usr/bin/xcrun "$@"
XCRUN
chmod 700 "$HOME/xcode-tools/xcrun"
export PATH="$HOME/xcode-tools:$PATH"
cd mobile
flutter pub get --enforce-lockfile
flutter build ios --release --no-codesign --no-pub \
  --build-name "$VERSION" --build-number "$BUILD_NUMBER"
