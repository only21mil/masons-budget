import SwiftData
import SwiftUI

struct TransactionDetailView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Bindable var transaction: Transaction

    @State private var merchant: String
    @State private var category: String
    @State private var amountUsd: String
    /// Selected payment-source wire, or nil when the row carries no method.
    @State private var method: String?
    @State private var note: String
    @State private var date: Date
    @State private var showingDeleteConfirmation = false

    init(transaction: Transaction) {
        _categories = Query(
            filter: Self.categoryPredicate(for: transaction.ownerMember),
            sort: \BudgetCategory.sortOrder,
        )
        self.transaction = transaction
        _merchant = State(initialValue: transaction.merchant)
        _category = State(initialValue: transaction.category)
        _amountUsd = State(initialValue: NSDecimalNumber(decimal: transaction.amount).stringValue)
        // Seed from the stored card when it exists, unknown/retired wires
        // included — they round-trip as a synthetic picker option. No stamping
        // of a default onto rows that never had a method.
        _method = State(initialValue: transaction.card)
        _note = State(initialValue: transaction.note ?? "")
        _date = State(initialValue: transaction.date)
    }

    static func categoryPredicate(for owner: FamilyMember) -> Predicate<BudgetCategory> {
        let ownerRaw = owner.rawValue
        if owner.isAdult {
            let victorRaw = FamilyMember.victor.rawValue
            let rachelRaw = FamilyMember.rachel.rawValue
            return #Predicate { $0.owner == victorRaw || $0.owner == rachelRaw }
        }
        return #Predicate { $0.owner == ownerRaw }
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
                                    .font(AppFont.labelLarge)
                                    .foregroundStyle(category.isEmpty ? theme.textMuted : theme.text)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(AppFont.smallRegular)
                                    .foregroundStyle(theme.textMuted)
                            }
                        }
                    }
                    Hairline()
                    editRow("USD") {
                        TextField("Amount", text: $amountUsd)
                    }
                    Hairline()
                    editRow("Method") {
                        // Catalogue-driven picker. A retired or unknown wire
                        // already on the row is re-inserted as a synthetic
                        // option (via including:) so it displays and
                        // round-trips unchanged unless the user explicitly
                        // picks a new option.
                        Menu {
                            ForEach(methodOptions) { option in
                                Button {
                                    method = option.wire
                                } label: {
                                    Label(option.label, systemImage: PaymentMethod.icon(forWire: option.wire))
                                }
                            }
                            Button {
                                method = nil
                            } label: {
                                Label("None", systemImage: "minus.circle")
                            }
                        } label: {
                            HStack {
                                Text(methodLabel)
                                    .font(AppFont.labelLarge)
                                    .foregroundStyle(method == nil ? theme.textMuted : theme.text)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(AppFont.smallRegular)
                                    .foregroundStyle(theme.textMuted)
                            }
                        }
                    }
                    Hairline()
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                        .font(AppFont.labelLarge)
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
                    showingDeleteConfirmation = true
                } label: {
                    Text("Delete Transaction")
                        .font(AppFont.labelLargeStrong)
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
                        .font(AppFont.bodyBold)
                        .foregroundStyle(theme.accent)
                }
            }
            .confirmationDialog(
                "Delete \(transaction.merchant)?",
                isPresented: $showingDeleteConfirmation,
                titleVisibility: .visible,
            ) {
                Button("Delete \(deleteAmountLabel)", role: .destructive) {
                    deleteTransaction()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes the transaction and syncs the delete.")
            }
    }

    private var deleteAmountLabel: String {
        let amount = transaction.amount < 0 ? -transaction.amount : transaction.amount
        return AppFormatter.formatCurrency(amount)
    }

    // MARK: - Method Picker

    private var activityType: TransactionActivityType {
        transaction.isIncome ? .income : .spend
    }

    private var methodOptions: [TransactionSourceOption] {
        // The detail screen has no sats entry, so Bitcoin-native wires are
        // offered only when the stored row already carries one (see
        // editableSources). Re-sourcing a row is a separate feature, not a
        // thing this screen does.
        TransactionSourceCatalog.editableSources(
            for: activityType,
            storedCard: transaction.card,
            selected: method
        )
    }

    private var methodLabel: String {
        guard let method else { return "None" }
        return methodOptions.first { $0.wire == method }?.label ?? method
    }

    private func editRow(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(AppFont.labelRegular)
                .foregroundStyle(theme.textMuted)
                .frame(width: 78, alignment: .leading)
            content()
                .font(AppFont.labelLarge)
                .foregroundStyle(theme.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func deleteTransaction() {
        let owner = transaction.ownerMember
        let id = transaction.id
        let baseUpdatedAtMs = transaction.updatedAtMs
        modelContext.delete(transaction)
        guard LocalMutationSave.perform(operation: "Delete transaction", in: modelContext, rollbackMutation: {
            modelContext.insert(transaction)
        }, remoteWrite: {
            AppWriteSyncService.deleteTransaction(
                id: id,
                owner: owner,
                baseUpdatedAtMs: baseUpdatedAtMs
            )
        }) else {
            return
        }
        dismiss()
    }

    private func save() {
        let cleanAmount = amountUsd
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let amount = Decimal(string: cleanAmount) else { return }
        let previousMerchant = transaction.merchant
        let previousCategory = transaction.category
        let previousAmount = transaction.amount
        let previousCard = transaction.card
        let previousNote = transaction.note
        let previousDate = transaction.date
        let previousOwner = transaction.owner

        transaction.merchant = merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? transaction.merchant : merchant
        transaction.category = category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Other" : category
        transaction.amount = amount
        // No longer unconditional: it used to stamp retired values onto
        // untagged rows on every save. Only a real selection writes, and a
        // cleared selection (None) writes nil so the row becomes untagged.
        if let method {
            if methodOptions.contains(where: { $0.wire == method }) {
                transaction.card = method
            }
        } else {
            transaction.card = nil
        }
        transaction.note = note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : note
        transaction.date = date
        transaction.ownerMember = transaction.ownerMember.ledgerOwner
        guard LocalMutationSave.perform(operation: "Transaction", in: modelContext, rollbackMutation: {
            transaction.merchant = previousMerchant
            transaction.category = previousCategory
            transaction.amount = previousAmount
            transaction.card = previousCard
            transaction.note = previousNote
            transaction.date = previousDate
            transaction.owner = previousOwner
        }, remoteWrite: {
            AppWriteSyncService.pushTransaction(transaction, owner: transaction.ownerMember)
        }) else {
            return
        }
        dismiss()
    }
}
