import SwiftData
import SwiftUI

struct CategoryDetailView: View {
    @Environment(\.theme) private var theme
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Bindable var category: BudgetCategory
    @Query(sort: \Transaction.date, order: .reverse) private var transactions: [Transaction]

    let selectedMonth: Date
    @State private var monthlyBudget: String
    /// Cause-specific feedback for the budget write. Nothing reported the outcome
    /// of this save at all before: a rejected budget looked identical to a saved one.
    @StateObject private var writeFeedback = WriteFeedbackStore()
    @StateObject private var deletion = CategoryDeletionStore()
    @State private var showDeleteConfirmation = false

    init(category: BudgetCategory, selectedMonth: Date) {
        self.category = category
        self.selectedMonth = selectedMonth
        _monthlyBudget = State(initialValue: NSDecimalNumber(decimal: category.monthlyBudget).stringValue)
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var categoryTransactions: [Transaction] {
        Self.transactions(
            transactions,
            visibleTo: activeMember,
            category: category.name,
            selectedMonth: selectedMonth,
        )
    }

    private var canDelete: Bool {
        activeMember != .maddox &&
            Calendar.current.isDate(selectedMonth, equalTo: Date(), toGranularity: .month)
    }

    static func transactions(
        _ transactions: [Transaction],
        visibleTo member: FamilyMember,
        category: String,
        selectedMonth: Date,
        calendar: Calendar = .current,
    ) -> [Transaction] {
        transactions.filter {
            member.sharesNetWorth(with: $0.ownerMember) &&
                $0.category == category &&
                calendar.isDate($0.date, equalTo: selectedMonth, toGranularity: .month)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: category.name, eyebrow: "Budget category")

                VStack(spacing: 0) {
                    HStack {
                        Text("Monthly limit")
                            .ledgerType(.rowPrimary)
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                        TextField("Limit", text: $monthlyBudget)
                            .ledgerType(.rowFigure)
                            .foregroundStyle(theme.text)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 140)
                    }
                    .padding(14)

                    if let message = writeFeedback.message {
                        HStack {
                            Text(message)
                                .ledgerType(.body)
                                .foregroundStyle(theme.danger)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 12)
                    }

                    Hairline()

                    HStack {
                        Text("Transactions")
                            .ledgerType(.rowPrimary)
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                        Text("\(categoryTransactions.count)")
                            .ledgerType(.rowFigure)
                            .foregroundStyle(theme.text)
                    }
                    .padding(14)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    ForEach(Array(categoryTransactions.prefix(20).enumerated()), id: \.element.id) { idx, tx in
                        NavigationLink {
                            TransactionDetailView(transaction: tx)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tx.merchant)
                                        .ledgerType(.rowPrimary)
                                        .foregroundStyle(theme.text)
                                    Text(formatDate(tx.date))
                                        .ledgerType(.rowMeta)
                                        .foregroundStyle(theme.textMuted)
                                }
                                Spacer()
                                AmountView(
                                    sats: tx.displaySatsValue(btcPrice: btcPrice),
                                    unit: unit,
                                    role: .rowFigure,
                                    showSign: true,
                                    accent: tx.isIncome,
                                    btcPrice: btcPrice,
                                )
                            }
                            .padding(14)
                        }
                        .buttonStyle(.plain)

                        if idx < min(categoryTransactions.count, 20) - 1 {
                            Hairline(indent: 14)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                if canDelete {
                    VStack(alignment: .leading, spacing: 10) {
                        if let message = deletion.message {
                            Text(message)
                                .ledgerType(.body)
                                .foregroundStyle(theme.danger)
                        }
                        Button(role: .destructive) {
                            showDeleteConfirmation = true
                        } label: {
                            HStack {
                                Image(systemName: "trash")
                                Text(deletion.isDeleting ? "DELETING" : "DELETE CATEGORY")
                                    .ledgerType(.rowFigure)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                        }
                        .buttonStyle(.bordered)
                        .disabled(deletion.isDeleting)
                    }
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle(category.name)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(writeFeedback.isSaving ? "Saving…" : "Save") { save() }
                        .ledgerType(.button)
                        .foregroundStyle(theme.accent)
                        .disabled(writeFeedback.isSaving)
                }
            }
            .alert("Delete \(category.name)?", isPresented: $showDeleteConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { deleteCategory() }
            } message: {
                Text("This deletes the current canonical budget category after its server revision is verified.")
            }
            .onChange(of: deletion.accepted) { _, accepted in
                guard accepted else { return }
                modelContext.delete(category)
                do {
                    try modelContext.save()
                    dismiss()
                } catch {
                    deletion.failLocal(error)
                }
            }
    }

    private func save() {
        let clean = monthlyBudget
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Write-path parse: pinned POSIX locale so dot-decimal entry can't
        // inflate in comma-decimal device regions.
        guard let value = Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX")), value >= 0 else {
            writeFeedback.reject("Enter a monthly limit of zero or more")
            return
        }
        let previousBudget = category.monthlyBudget
        category.monthlyBudget = value
        writeFeedback.begin()
        LocalMutationSave.perform(
            operation: "Budget",
            in: modelContext,
            onFailure: { [writeFeedback] failure in
                writeFeedback.failLocal(failure, operation: "Budget")
            },
            rollbackMutation: {
                category.monthlyBudget = previousBudget
            },
        ) {
            AppWriteSyncService.pushBudgetCategoryUpdate(category) { [writeFeedback] result in
                writeFeedback.finish(result, operation: "Budget")
            }
        }
    }

    private func deleteCategory() {
        deletion.begin()
        let viewer = activeMember
        let categoryName = category.name
        Task {
            do {
                let client = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
                let document = try await ConvexRowReader(client: client).budget(viewer: viewer)
                let intent = try document.categoryDeletionIntent(
                    viewer: viewer,
                    trustedCurrentMonth: Self.monthKey(for: Date()),
                    categoryName: categoryName
                )
                AppWriteSyncService.deleteBudgetCategory(intent) { result in
                    deletion.finish(result)
                }
            } catch {
                // Server-derived text must never reach the UI (ConvexWriteResult
                // docs); classify to an authored message with a fixed fallback.
                let result = ConvexWriteResult.classify(error)
                deletion.reject(
                    result.userMessage(operation: "Delete budget category")
                        ?? "The category could not be deleted. Try again after the next sync.",
                )
            }
        }
    }

    // Cached: DateFormatter construction per call was the avoidable cost here.
    // Default calendar is UTC Gregorian so "current month" matches Android,
    // Linux, and server trustedCurrentMonth() (ISO slice) around month edges.
    private static var cachedMonthKeyFormatter: (calendar: Calendar, formatter: DateFormatter)?

    static var utcMonthCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    static func monthKey(for date: Date, calendar: Calendar = utcMonthCalendar) -> String {
        let formatter: DateFormatter
        if let cached = cachedMonthKeyFormatter, cached.calendar == calendar {
            formatter = cached.formatter
        } else {
            formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "yyyy-MM"
            cachedMonthKeyFormatter = (calendar, formatter)
        }
        return formatter.string(from: date)
    }

    private static let mediumDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private func formatDate(_ date: Date) -> String {
        Self.mediumDateFormatter.string(from: date)
    }
}

@MainActor
final class CategoryDeletionStore: ObservableObject {
    @Published private(set) var isDeleting = false
    @Published private(set) var message: String?
    @Published private(set) var accepted = false

    func begin() {
        isDeleting = true
        message = nil
        accepted = false
    }

    func finish(_ result: ConvexWriteResult) {
        isDeleting = false
        accepted = result.isOk
        message = result.userMessage(operation: "Delete category")
    }

    func reject(_ text: String) {
        isDeleting = false
        accepted = false
        message = text
    }

    func failLocal(_ error: Error) {
        isDeleting = false
        accepted = false
        message = "Category deleted remotely, but the local copy could not be removed: \(error.localizedDescription)"
    }
}
