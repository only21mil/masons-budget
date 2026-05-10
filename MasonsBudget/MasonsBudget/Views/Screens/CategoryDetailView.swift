import SwiftUI
import SwiftData

struct CategoryDetailView: View {
    @Environment(\.theme) private var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Bindable var category: BudgetCategory
    @Query(sort: \Transaction.date, order: .reverse) private var transactions: [Transaction]

    @State private var monthlyBudget: String

    init(category: BudgetCategory) {
        self.category = category
        _monthlyBudget = State(initialValue: NSDecimalNumber(decimal: category.monthlyBudget).stringValue)
    }

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var categoryTransactions: [Transaction] {
        transactions.filter {
            activeMember.canSee(dataOwnedBy: $0.ownerMember) && $0.category == category.name
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: category.name, eyebrow: "Budget category")

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
                                Text(AppFormatter.formatCurrency(tx.displayAmount))
                                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                                    .foregroundStyle(tx.isSpend ? theme.text : theme.success)
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
            .padding(.bottom, 28)
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
        }
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
