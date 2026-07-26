# Linux Apple-Build Boundary Reduction

A Linux machine cannot become a native Xcode host: Apple SDK app builds,
simulator runs, signing, archive/export, and TestFlight all belong on macOS with
Xcode. The practical goal is to catch as much as possible on Linux before macOS
is asked to compile.

Releases themselves run in GitHub Actions on a `macos-latest` runner — see
`.github/workflows/deploy.yml`. This document covers the checks that can happen
before that point, on any machine.

## Linux preflight

Run from the repo root:

```bash
scripts/vv-swift-check.sh
```

The preflight is Linux-safe. It runs no `xcodebuild`, simulator, signing,
archive, upload, or app-target test commands. It checks:

- required Swift tooling on PATH
- `git diff --check`
- temp-directory XcodeGen generation from `MasonsBudget/project.yml`
- SourceKit-backed SwiftLint over app and test paths
- SwiftFormat lint over app and test paths
- stdin Swift typecheck smoke
- serialized SwiftPM Linux tests when `Package.swift` is present
- `Package.resolved` mutation guard before/after SwiftPM work
- gitleaks scan over tracked plus unignored working-tree files copied into a
  temporary directory

Use `--quick` for a shorter pass while iterating.

## SwiftPM and SourceKit-LSP Hygiene

The repo pins the Swift toolchain with `.swift-version`.

Use the helper when SourceKit-LSP diagnostics, hover, or indexing feel stale:

```bash
scripts/vv-swift-lsp-reset.sh status
scripts/vv-swift-lsp-reset.sh prime
```

`prime` serializes a pure SwiftPM build with `flock`, which refreshes the
Linux package/index surface without touching any Apple SDK target.

Use `reset` only when the LSP/index state is clearly stale:

```bash
scripts/vv-swift-lsp-reset.sh reset
```

SwiftPM dependency resolution should not run concurrently against the same
working tree or cache. The preflight uses a repo-local lock file and fails if any
non-`.build` `Package.resolved` file changes during the run.

## Remote Mac Bridge

A Linux machine can orchestrate a Mac build host without pretending Linux can
run Xcode. There is no default host or path — nothing lives at a fixed location,
so both must be supplied:

```bash
VV_MAC_HOST=victor@my-mac VV_MAC_REPO=~/checkouts/masons-budget \
  scripts/vv-remote-build.sh status
```

Prefer the GitHub Actions release workflow where it applies; this bridge is for
iterating against a Mac you already have in front of you.

Read-only/non-build actions:

- `status`: Mac, Xcode, repo, and XcodeGen readback
- `preflight`: Mac-side `xcodegen generate` and `git diff --check`

Build actions refuse to run unless invoked with an explicit approval note:

```bash
VV_MAC_HOST=victor@my-mac VV_MAC_REPO=~/checkouts/masons-budget \
  scripts/vv-remote-build.sh --approved \
  --approval-note "Victor approved iOS build for <issue> on YYYY-MM-DD" \
  ios-build
```

Supported build actions are `ios-build`, `ios-test`, and `mac-build`. Release
archive/export/upload/TestFlight remains governed by the full release-flow
approval process.

## SwiftPM Extraction

Linux can compile and test pure Swift packages. The best long-term boundary
reduction is to move platform-neutral logic behind a Swift Package target and
keep SwiftUI/SwiftData/Xcode-specific wiring in the app target.

The first package surface is now the root `Package.swift`:

- product: `VogelVaultCore`
- current source: existing `MasonsBudget/MasonsBudget/Services/VoiceParser.swift`
- current tests: `Tests/VogelVaultCoreTests`
- command: `swift test --package-path .` (runs on Linux)

Recommended next candidates:

- `RecurringDetector`: extraction requires replacing `Transaction` model input
  with a simple value type such as `RecurringDetectionTransaction`.
- `SearchMatcher`: the string normalization/matching core is pure Foundation,
  but current transaction/todo overloads depend on app models. Extract the core
  functions first and keep model adapters in the app target.
- MC2 DTO parsing/mapping helpers: extract only DTO/value-shaping pieces that do
  not import SwiftData or SwiftUI.

Avoid extracting:

- SwiftUI views
- SwiftData `@Model` classes
- services that depend on Apple platform APIs, Keychain, LocalAuthentication,
  app lifecycle, or Convex runtime wiring

The first package should target Linux and macOS, run with `swift test` on Linux,
and be imported back into the app from XcodeGen once the Mac build path is
approved.

Note the shared cross-client contract in `shared/domain` is a separate thing:
it is the TypeScript/Kotlin mirror of `SharedEnums.swift` for the Linux and
Android clients. `VogelVaultCore` is the Swift-side extraction. Both trace back
to the same Swift source of truth.
