import SwiftUI
import SwiftData

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @State private var amountText = ""
    @State private var merchant = ""
    @State private var category = ""
    @State private var card = "Strike"
    @State private var note = ""

    private let cards = ["Strike", "River", ""]

    var onSave: (Decimal, String, String, String?, String?) -> Void

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
                        guard let amount = Decimal(string: amountText), !merchant.isEmpty else { return }
                        let cat = category.isEmpty ? (categories.first?.name ?? "Other") : category
                        onSave(amount, merchant, cat, card.isEmpty ? nil : card, note.isEmpty ? nil : note)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(amountText.isEmpty || merchant.isEmpty)
                }
            }
            .onAppear {
                if category.isEmpty {
                    category = categories.first?.name ?? "Other"
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
