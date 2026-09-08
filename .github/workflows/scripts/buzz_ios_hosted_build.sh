#!/usr/bin/env bash
# Public unsigned build only. Signing runs on a different disposable VM.
set -euo pipefail
: "${SOURCE_SHA:?}" "${VERSION:?}" "${BUILD_NUMBER:?}" "${GITHUB_WORKSPACE:?}"
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$(uname -m)" = arm64
test "$(/usr/bin/xcodebuild -version)" = $'Xcode 26.3\nBuild version 17C529'
controller="$GITHUB_WORKSPACE/controller/.github/workflows/scripts"
cd "$GITHUB_WORKSPACE"
mkdir buzz
cd buzz
git init --quiet
git remote add origin https://github.com/only21mil/buzz.git
git -c credential.helper= fetch --depth 1 origin "$SOURCE_SHA"
git checkout --quiet --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
# shellcheck disable=SC1091
source bin/activate-hermit
test "$(readlink bin/flutter)" = .flutter-3.41.7.pkg
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
cd mobile
flutter pub get --enforce-lockfile
flutter build ios --release --no-codesign --no-pub \
  --build-name "$VERSION" --build-number "$BUILD_NUMBER"
cd ..
/usr/bin/python3 -I "$controller/buzz_ios_release.py" pack \
  --app mobile/build/ios/iphoneos/Buzz.app --output "$GITHUB_WORKSPACE/unsigned" \
  --source "$SOURCE_SHA" --version "$VERSION" --build-number "$BUILD_NUMBER"
