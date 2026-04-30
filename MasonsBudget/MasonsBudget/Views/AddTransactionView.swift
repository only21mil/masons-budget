import SwiftUI

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var amountText = ""
    @State private var merchant = ""
    @State private var category = "Groceries"
    @State private var card = "Aven"
    @State private var note = ""

    var onSave: (Decimal, String, String, String?, String?) -> Void

    private let categories = [
        "Bills & Utilities", "Dining & Drinks", "Auto & Transport",
        "Shopping", "Groceries", "Health & Wellness", "Medical", "Pets",
    ]

    private let cards = ["Aven", "Strike", "River", ""]

    var body: some View {
        NavigationStack {
            Form {
                Section("Amount") {
                    TextField("0.00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .font(.title2.monospaced())
                        .foregroundStyle(AppTheme.accentColor)
                }

                Section("Details") {
                    TextField("Merchant", text: $merchant)
                    Picker("Category", selection: $category) {
                        ForEach(categories, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Card", selection: $card) {
                        Text("None").tag("")
                        ForEach(cards.filter { !$0.isEmpty }, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("Note (optional)", text: $note)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Add Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let amount = Decimal(string: amountText), !merchant.isEmpty else { return }
                        onSave(amount, merchant, category, card.isEmpty ? nil : card, note.isEmpty ? nil : note)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(amountText.isEmpty || merchant.isEmpty)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
