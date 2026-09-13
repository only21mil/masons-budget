import SwiftData
import SwiftUI

struct TransactionDetailView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @ScaledMetric(relativeTo: .body) private var labelWidth = 78.0
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
    @State private var isSaving = false
    @State private var writeMessage: String?

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
        BudgetCategory.predicate(for: owner)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Transaction", eyebrow: transaction.createdBy.uppercased())
                if let writeMessage {
                    Text(writeMessage).foregroundStyle(theme.warn).padding(.horizontal, ledgerTokens.metrics.screenGutter)
                }

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
                                    .ledgerType(.rowPrimary)
                                    .foregroundStyle(category.isEmpty ? theme.textMuted : theme.text)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(AppFont.icon(size: 11, weight: .regular))
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
                                    .ledgerType(.rowPrimary)
                                    .foregroundStyle(method == nil ? theme.textMuted : theme.text)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(AppFont.icon(size: 11, weight: .regular))
                                    .foregroundStyle(theme.textMuted)
                            }
                        }
                    }
                    Hairline()
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.text)
                        .padding(.horizontal, 14)
                        .padding(.vertical, ledgerTokens.metrics.rowVerticalPadding)
                    Hairline()
                    editRow("Note") {
                        TextField("Optional", text: $note)
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                Button(role: .destructive) {
                    showingDeleteConfirmation = true
                } label: {
                    Text("Delete Transaction")
                        .ledgerType(.button)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.danger)
                .background(theme.dangerSoft)
                .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusSmall))
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
                        .ledgerType(.button)
                        .foregroundStyle(theme.accent)
                }
            }
            .disabled(isSaving)
            .interactiveDismissDisabled(isSaving)
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
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.textMuted)
                .frame(width: labelWidth, alignment: .leading)
            content()
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, ledgerTokens.metrics.rowVerticalPadding)
    }

    private func deleteTransaction() {
        guard !isSaving else { return }
        isSaving = true
        writeMessage = nil
        AppWriteSyncService.deleteTransaction(transaction, owner: transaction.ownerMember) { result in
            isSaving = false
            guard result.isOk else {
                writeMessage = result.userMessage(operation: "Delete transaction")
                return
            }
            modelContext.delete(transaction)
            do {
                try modelContext.save()
                dismiss()
            } catch {
                writeMessage = "Deleted online. Refresh to update this device."
            }
        }
    }

    private func save() {
        let cleanAmount = amountUsd
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Write-path parse: pinned POSIX locale so dot-decimal entry can't
        // inflate in comma-decimal device regions.
        guard let amount = Decimal(string: cleanAmount, locale: Locale(identifier: "en_US_POSIX")) else { return }
        guard !isSaving else { return }
        // Keep the persisted row unchanged while the edited draft is pending.
        let candidate = Transaction(
            id: transaction.id, date: date,
            merchant: merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? transaction.merchant : merchant,
            amount: amount, category: category.isEmpty ? "Other" : category,
            amountSats: transaction.amountSats, enteredInBitcoin: transaction.enteredInBitcoin,
            card: method, bitcoinAccountKey: transaction.bitcoinAccountKey,
            note: note.isEmpty ? nil : note, owner: transaction.ownerMember.ledgerOwner,
            createdBy: transaction.createdBy, createdAt: transaction.createdAt,
            sourceFile: transaction.sourceFile, updatedAtMs: transaction.updatedAtMs,
        )
        isSaving = true
        writeMessage = nil
        TransactionDetailWriteFlow.save(transaction, candidate: candidate) { result in
            isSaving = false
            guard result.isOk else {
                writeMessage = result.userMessage(operation: "Transaction")
                return
            }
            do {
                try modelContext.save()
                dismiss()
            } catch {
                writeMessage = "Saved online. Refresh to update this device."
            }
        }
    }
}

/// The persisted row changes only after the remote draft has been accepted.
@MainActor
enum TransactionDetailWriteFlow {
    typealias Writer = @MainActor (Transaction, @escaping @MainActor @Sendable (ConvexWriteResult) -> Void) -> Void

    static func save(
        _ transaction: Transaction,
        candidate: Transaction,
        writer: Writer? = nil,
        onResult: @escaping @MainActor @Sendable (ConvexWriteResult) -> Void,
    ) {
        let complete: @MainActor @Sendable (ConvexWriteResult) -> Void = { result in
            if result.isOk {
                transaction.merchant = candidate.merchant
                transaction.category = candidate.category
                transaction.amount = candidate.amount
                transaction.card = candidate.card
                transaction.note = candidate.note
                transaction.date = candidate.date
                transaction.owner = candidate.owner
                transaction.updatedAtMs = candidate.updatedAtMs
            }
            onResult(result)
        }
        if let writer { writer(candidate, complete) }
        else { AppWriteSyncService.pushTransaction(candidate, owner: candidate.ownerMember, onResult: complete) }
    }
}
