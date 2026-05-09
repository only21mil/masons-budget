import AppIntents

/// Surfaces Vogel Vault AppIntents in the system Shortcuts app and to "Hey Siri"
/// without the user having to wire anything up manually.
struct VogelVaultShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTransactionIntent(),
            phrases: [
                "Add transaction to \(.applicationName)",
                "Log expense in \(.applicationName)",
                "Log a \(.applicationName) expense",
                "New \(.applicationName) transaction"
            ],
            shortTitle: "Add Transaction",
            systemImageName: "creditcard.fill"
        )
    }

    static var shortcutTileColor: ShortcutTileColor = .orange
}
