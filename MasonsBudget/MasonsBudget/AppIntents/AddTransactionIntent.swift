import AppIntents
import Foundation
import SwiftData

/// "Hey Siri, log $X at Y" → write a transaction into the active profile's data
/// and round-trip through Convex/MC2 the same way an in-app entry would.
struct AddTransactionIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Transaction"
    static var description = IntentDescription(
        "Log a new transaction in The Vogel Vault using the currently selected profile.",
        categoryName: "Money"
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Amount", description: "Dollar amount of the transaction.")
    var amount: Double

    @Parameter(title: "Merchant", description: "Where the money was spent (e.g. Costco).")
    var merchant: String

    @Parameter(title: "Category", description: "Budget category, e.g. Groceries. Defaults to Uncategorized.")
    var category: String?

    @Parameter(title: "Payment Source", description: "Card or account used (e.g. SoFi Card).")
    var source: String?

    @Parameter(title: "Note")
    var note: String?

    @Dependency var modelContainer: ModelContainer

    static var parameterSummary: some ParameterSummary {
        Summary("Log \(\.$amount) at \(\.$merchant)") {
            \.$category
            \.$source
            \.$note
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let owner = try TransactionRecorder.activeProfile()
        let recorder = TransactionRecorder(modelContext: modelContainer.mainContext)
        let amountDecimal = Decimal(amount)
        let resolvedCategory = (category?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "Uncategorized"
        let trimmedSource = source?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)

        try recorder.record(
            amount: amountDecimal,
            merchant: merchant,
            category: resolvedCategory,
            card: (trimmedSource?.isEmpty ?? true) ? nil : trimmedSource,
            note: (trimmedNote?.isEmpty ?? true) ? nil : trimmedNote,
            owner: owner,
            source: .siri
        )

        return .result(dialog: "Logged \(formatCurrency(amountDecimal)) at \(merchant) for \(owner.displayName).")
    }
}
