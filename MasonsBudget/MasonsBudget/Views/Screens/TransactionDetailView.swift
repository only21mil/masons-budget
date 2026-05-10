import SwiftUI
import SwiftData

struct TransactionDetailView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Bindable var transaction: Transaction

    @State private var merchant: String
    @State private var category: String
    @State private var amountUsd: String
    @State private var method: String
    @State private var note: String
    @State private var date: Date

    init(transaction: Transaction) {
        self.transaction = transaction
        _merchant = State(initialValue: transaction.merchant)
        _category = State(initialValue: transaction.category)
        _amountUsd = State(initialValue: NSDecimalNumber(decimal: transaction.amount).stringValue)
        _method = State(initialValue: transaction.card ?? "on-chain")
        _note = State(initialValue: transaction.note ?? "")
        _date = State(initialValue: transaction.date)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Transaction", eyebrow: transaction.createdBy.uppercased())

                VStack(spacing: 0) {
                    editRow("Merchant") {
                        TextField("Merchant", text: $merchant)
                    }
                    Hairline()
                    editRow("Category") {
                        Menu {
                            ForEach(categories, id: \.name) { cat in
                                Button(cat.name) { category = cat.name }
                            }
                        } label: {
                            HStack {
                                Text(category.isEmpty ? "Select" : category)
                                    .font(.system(size: 14))
                                    .foregroundStyle(category.isEmpty ? theme.textFaint : theme.text)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.textFaint)
                            }
                        }
                    }
                    Hairline()
                    editRow("USD") {
                        TextField("Amount", text: $amountUsd)
                    }
                    Hairline()
                    editRow("Method") {
                        Picker("Method", selection: $method) {
                            Text("Lightning").tag("lightning")
                            Text("On-chain").tag("on-chain")
                        }
                        .pickerStyle(.segmented)
                    }
                    Hairline()
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.text)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                    Hairline()
                    editRow("Note") {
                        TextField("Optional", text: $note)
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                Button(role: .destructive) {
                    let owner = transaction.ownerMember
                    AppWriteSyncService.deleteTransaction(transaction, owner: owner)
                    modelContext.delete(transaction)
                    try? modelContext.save()
                    dismiss()
                } label: {
                    Text("Delete Transaction")
                        .font(.system(size: 14, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.danger)
                .background(theme.dangerSoft)
                .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusSmall))
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Transaction")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(theme.accent)
            }
        }
    }

    private func editRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(theme.textMuted)
                .frame(width: 78, alignment: .leading)
            content()
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func save() {
        let cleanAmount = amountUsd
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let amount = Decimal(string: cleanAmount) else { return }

        transaction.merchant = merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? transaction.merchant : merchant
        transaction.category = category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Other" : category
        transaction.amount = amount
        transaction.card = method
        transaction.note = note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : note
        transaction.date = date
        try? modelContext.save()
        AppWriteSyncService.pushTransaction(transaction, owner: transaction.ownerMember)
        dismiss()
    }
}
