// swift-tools-version: 5.9

import PackageDescription

// The core target existed to compile and test VoiceParser on Linux ("cheapest
// signal first" in CI's swift.yml). Voice entry is removed and with it the only
// source the target carried, so the target and its test suite are gone too.
// The placeholder target keeps `swift test` a fast green no-op for CI's SwiftPM
// job and any local run; drop the job and this manifest when CI is next touched.
let package = Package(
    name: "VogelVaultCore",
    platforms: [
        .macOS(.v14),
    ],
    targets: [
        .target(
            name: "VogelVaultCorePlaceholder",
            path: "PackagePlaceholder"
        ),
        .testTarget(
            name: "VogelVaultCoreTests",
            dependencies: ["VogelVaultCorePlaceholder"],
            path: "Tests/VogelVaultCoreTests"
        ),
    ]
)
