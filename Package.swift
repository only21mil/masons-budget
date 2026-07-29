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
                "MC2DTOs.swift",
                "MC2Mapper.swift",
                "MC2Reader.swift",
                "MC2SyncService.swift",
                
                "SearchMatcher.swift",
                "StockPriceService.swift",
                "SyncStatusStore.swift",
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
