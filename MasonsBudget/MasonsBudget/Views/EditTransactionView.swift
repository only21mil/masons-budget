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
    @State private var card: String = ""
    @State private var note: String = ""

    private let commonPaymentSources = [
        "Aven",
        "River",
        "River Bill Pay",
        "River (BTC)",
        "Strike",
        "Strike (BTC)",
        "Cash App",
        "SoFi"
    ]

    private var paymentSources: [String] {
        var sources = commonPaymentSources
        if !card.isEmpty && !sources.contains(card) {
            sources.insert(card, at: 0)
        }
        return sources
    }

    var body: some View {
        NavigationStack {
            Form {
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
                    TextField("Custom source", text: $card)
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
        note = transaction.note ?? ""
    }

    private func saveChanges() {
        guard let amount = Decimal(string: amountText) else { return }
        transaction.amount = amount
        transaction.merchant = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
        transaction.date = date
        transaction.category = category.isEmpty ? (categories.first?.name ?? "Other") : category
        let trimmedCard = card.trimmingCharacters(in: .whitespacesAndNewlines)
        transaction.card = trimmedCard.isEmpty ? nil : trimmedCard
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        transaction.note = trimmedNote.isEmpty ? nil : trimmedNote
        onSave(transaction)
        dismiss()
    }
}
