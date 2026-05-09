import SwiftUI
import SwiftData

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Query private var transactions: [Transaction]
    @State private var amountText = ""
    @State private var merchant = ""
    @State private var category = ""
    @State private var activityType: TransactionActivityType = .spend
    @State private var card = TransactionSourceCatalog.defaultSource(for: .spend)
    @State private var customSource = ""
    @State private var note = ""
    @State private var pendingSave: (Decimal, String, String, String?, String?)?
    @State private var showDuplicateWarning = false

    var onSave: (Decimal, String, String, String?, String?) -> Void

    private var sourceOptions: [String] {
        TransactionSourceCatalog.sources(for: activityType, including: card)
    }

    private var selectedSource: String? {
        let source = customSource.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? card
            : customSource.trimmingCharacters(in: .whitespacesAndNewlines)
        return source.isEmpty ? nil : source
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
                    #if os(iOS)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                    #endif
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
                    Picker("Source", selection: $card) {
                        Text("None").tag("")
                        ForEach(sourceOptions, id: \.self) { source in
                            Text(source).tag(source)
                        }
                    }
                    TextField("Custom source", text: $customSource)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
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
                        prepareSave()
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
            .onChange(of: activityType) { _, newType in
                card = TransactionSourceCatalog.defaultSource(for: newType)
                customSource = ""
            }
            .alert("Possible Duplicate", isPresented: $showDuplicateWarning) {
                Button("Save Anyway") { commitPendingSave() }
                Button("Review", role: .cancel) { pendingSave = nil }
            } message: {
                Text("A transaction with the same merchant, amount, date, and source already exists.")
            }
        }
        .preferredColorScheme(.dark)
    }

    private func prepareSave() {
        guard let amount = Decimal(string: amountText),
              !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let cat = category.isEmpty ? (categories.first?.name ?? "Other") : category
        let finalNote = noteWithActivity(note.trimmingCharacters(in: .whitespacesAndNewlines))
        let payload = (
            amount,
            merchant.trimmingCharacters(in: .whitespacesAndNewlines),
            cat,
            selectedSource,
            finalNote
        )

        if isDuplicate(amount: amount, merchant: payload.1, source: payload.3) {
            pendingSave = payload
            showDuplicateWarning = true
        } else {
            pendingSave = payload
            commitPendingSave()
        }
    }

    private func commitPendingSave() {
        guard let pendingSave else { return }
        onSave(pendingSave.0, pendingSave.1, pendingSave.2, pendingSave.3, pendingSave.4)
        self.pendingSave = nil
        dismiss()
    }

    private func isDuplicate(amount: Decimal, merchant: String, source: String?) -> Bool {
        let calendar = Calendar.current
        return transactions.contains { tx in
            calendar.isDateInToday(tx.date)
                && tx.amount == amount
                && tx.merchant.caseInsensitiveCompare(merchant) == .orderedSame
                && (tx.card ?? "") == (source ?? "")
        }
    }

    private func noteWithActivity(_ rawNote: String) -> String? {
        guard activityType != .spend else {
            return rawNote.isEmpty ? nil : rawNote
        }
        let activityNote = "Activity: \(activityType.noteLabel)"
        return rawNote.isEmpty ? activityNote : "\(activityNote) · \(rawNote)"
    }
}
