import SwiftUI
import SwiftData

struct EditTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]

    let transaction: Transaction
    var onSave: (Transaction) -> Void

    @State private var amountText: String = ""
    @State private var merchant: String = ""
    @State private var date: Date = .now
    @State private var category: String = ""
    @State private var activityType: TransactionActivityType = .spend
    @State private var card: String = ""
    @State private var customSource: String = ""
    @State private var note: String = ""

    private var paymentSources: [String] {
        TransactionSourceCatalog.sources(for: activityType, including: card)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Type") {
                    Picker("Type", selection: $activityType) {
                        ForEach(TransactionActivityType.allCases) { type in
                            Text(type.title).tag(type)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Amount") {
                    TextField("0.00", text: $amountText)
                        #if os(iOS)
                        .keyboardType(.decimalPad)
                        #endif
                        .font(.title2.monospaced())
                        .foregroundStyle(AppTheme.accentColor)
                }

                Section("Details") {
                    TextField("Merchant", text: $merchant)
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Picker("Category", selection: $category) {
                        if categories.isEmpty {
                            Text("Other").tag("Other")
                        }
                        ForEach(categories, id: \.name) { cat in
                            Label {
                                Text(cat.name)
                            } icon: {
                                Text(cat.icon)
                            }
                            .tag(cat.name)
                        }
                        if !category.isEmpty && !categories.contains(where: { $0.name == category }) {
                            Text(category).tag(category)
                        }
                    }
                    TextField("Note (optional)", text: $note, axis: .vertical)
                }

                Section("Payment Source") {
                    Picker("Source", selection: $card) {
                        Text("None").tag("")
                        ForEach(paymentSources, id: \.self) { source in
                            Text(source).tag(source)
                        }
                    }
                    TextField("Custom source", text: $customSource)
                    #if os(iOS)
                        .textInputAutocapitalization(.words)
                    #endif
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Edit Transaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveChanges()
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSave)
                }
            }
            .onAppear(perform: loadTransaction)
            .onChange(of: activityType) { _, newType in
                if !TransactionSourceCatalog.sources(for: newType).contains(card) {
                    card = TransactionSourceCatalog.defaultSource(for: newType)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var canSave: Bool {
        Decimal(string: amountText) != nil && !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func loadTransaction() {
        amountText = NSDecimalNumber(decimal: transaction.amount).stringValue
        merchant = transaction.merchant
        date = transaction.date
        category = transaction.category.isEmpty ? (categories.first?.name ?? "Other") : transaction.category
        card = transaction.card ?? ""
        activityType = inferredActivityType(source: card, note: transaction.note)
        note = transaction.note ?? ""
    }

    private func saveChanges() {
        guard let amount = Decimal(string: amountText) else { return }
        transaction.amount = amount
        transaction.merchant = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
        transaction.date = date
        transaction.category = category.isEmpty ? (categories.first?.name ?? "Other") : category
        let custom = customSource.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCard = custom.isEmpty ? card.trimmingCharacters(in: .whitespacesAndNewlines) : custom
        transaction.card = trimmedCard.isEmpty ? nil : trimmedCard
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        transaction.note = noteWithActivity(trimmedNote)
        onSave(transaction)
        dismiss()
    }

    private func inferredActivityType(source: String, note: String?) -> TransactionActivityType {
        let combined = "\(source) \(note ?? "")".lowercased()
        if combined.contains("bill pay") { return .btcBillPay }
        if combined.contains("btc buy") || combined.contains("(btc)") { return .btcBuy }
        if combined.contains("income") { return .income }
        if combined.contains("transfer") || combined.contains("coldcard") { return .transfer }
        return .spend
    }

    private func noteWithActivity(_ rawNote: String) -> String? {
        let cleanedNote = rawNote.removingActivityPrefix()
        guard activityType != .spend else {
            return cleanedNote.isEmpty ? nil : cleanedNote
        }

        let activityNote = "Activity: \(activityType.noteLabel)"
        return cleanedNote.isEmpty ? activityNote : "\(activityNote) · \(cleanedNote)"
    }
}

private extension String {
    func removingActivityPrefix() -> String {
        let pattern = #"^Activity:\s*[^·\n]+(?:\s*·\s*)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let range = NSRange(startIndex..<endIndex, in: self)
        let stripped = regex.stringByReplacingMatches(in: self, options: [], range: range, withTemplate: "")
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
