// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "VogelVaultCore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "VogelVaultCore",
            targets: ["VogelVaultCore"]
        ),
    ],
    targets: [
        .target(
            name: "VogelVaultCore",
            path: "MasonsBudget/MasonsBudget/Services",
            exclude: [
                "AppWriteSyncService.swift",
                "BTCPriceService.swift",
                "CSVImportService.swift",
                "ConvexClient.swift",
                "ConvexDataReader.swift",
                "ConvexSyncService.swift",
                "ConvexWriteResult.swift",
                "CredentialStore.swift",
                "LedgerMapper.swift",
                "LegacyBlobDTOs.swift",
                "MC2DTOs.swift",
                "SearchMatcher.swift",
                "StockPriceService.swift",
                "SyncStatusStore.swift",
                "TaskUndoStore.swift",
                "WriteFeedbackStore.swift",
            ],
            sources: [
                "VoiceParser.swift",
            ]
        ),
        .testTarget(
            name: "VogelVaultCoreTests",
            dependencies: ["VogelVaultCore"],
            path: "Tests/VogelVaultCoreTests"
        ),
    ]
)
