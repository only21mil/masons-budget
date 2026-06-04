import SwiftUI
import SwiftData

struct CategoryDetailView: View {
    @Environment(\.theme) private var theme
    @Environment(\.modelContext) private var modelContext
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Bindable var category: BudgetCategory
    let selectedMonth: Date
    @Query(sort: \Transaction.date, order: .reverse) private var transactions: [Transaction]

    @State private var monthlyBudget: String

    init(category: BudgetCategory, selectedMonth: Date = Date()) {
        self.category = category
        self.selectedMonth = selectedMonth
        _monthlyBudget = State(initialValue: NSDecimalNumber(decimal: category.monthlyBudget).stringValue)
    }

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var categoryTransactions: [Transaction] {
        let calendar = Calendar.current
        return transactions.filter {
            activeMember.sharesNetWorth(with: $0.ownerMember) &&
            $0.category == category.name &&
            calendar.isDate($0.date, equalTo: selectedMonth, toGranularity: .month)
        }
    }

    private var selectedMonthLabel: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: selectedMonth)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: category.name, eyebrow: selectedMonthLabel)

                VStack(spacing: 0) {
                    HStack {
                        Text("Monthly limit")
                            .font(.system(size: 13))
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                        TextField("Limit", text: $monthlyBudget)
                            .font(.system(size: 15, weight: .bold, design: .monospaced))
                            .foregroundStyle(theme.text)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 140)
                    }
                    .padding(14)

                    Hairline()

                    HStack {
                        Text("Transactions")
                            .font(.system(size: 13))
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                        Text("\(categoryTransactions.count)")
                            .font(.system(size: 15, weight: .bold, design: .monospaced))
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
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(theme.text)
                                    Text(formatDate(tx.date))
                                        .font(.system(size: 11))
                                        .foregroundStyle(theme.textFaint)
                                }
                                Spacer()
                                AmountView(
                                    sats: tx.displaySatsValue(btcPrice: btcPrice),
                                    unit: unit,
                                    size: 13,
                                    weight: .bold,
                                    showSign: true,
                                    accent: tx.isIncome,
                                    btcPrice: btcPrice
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
                Button("Save") { save() }
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(theme.accent)
            }
        }
    }

    private func save() {
        let clean = monthlyBudget
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let value = Decimal(string: clean), value >= 0 {
            category.monthlyBudget = value
            try? modelContext.save()
            AppWriteSyncService.pushBudgetCategoryUpdate(category)
        }
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
