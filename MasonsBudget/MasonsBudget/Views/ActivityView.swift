import SwiftUI
import SwiftData

struct ActivityView: View {
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var filter: TxFilter = .all
    @State private var transactionToEdit: Transaction?
    @Environment(\.modelContext) private var modelContext
    private let syncClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myTransactions: [Transaction] {
        allTransactions.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var filteredTransactions: [Transaction] {
        switch filter {
        case .all: return myTransactions
        case .income: return myTransactions.filter { $0.category.lowercased().contains("income") }
        case .spends: return myTransactions.filter { !$0.category.lowercased().contains("income") }
        }
    }

    private var groupedByDay: [(key: String, transactions: [Transaction])] {
        let cal = Calendar.current
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE, MMM d"
        var groups: [(key: String, transactions: [Transaction])] = []
        var currentDay: DateComponents?
        var currentGroup: [Transaction] = []
        var currentKey = ""

        for tx in filteredTransactions {
            let day = cal.dateComponents([.year, .month, .day], from: tx.date)
            if day != currentDay {
                if !currentGroup.isEmpty {
                    groups.append((key: currentKey, transactions: currentGroup))
                }
                currentDay = day
                currentKey = fmt.string(from: tx.date)
                currentGroup = [tx]
            } else {
                currentGroup.append(tx)
            }
        }
        if !currentGroup.isEmpty {
            groups.append((key: currentKey, transactions: currentGroup))
        }
        return groups
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                screenHeader
                filterPills

                ForEach(groupedByDay, id: \.key) { group in
                    dayGroup(day: group.key, transactions: group.transactions)
                }

                if filteredTransactions.isEmpty {
                    Text("No transactions found")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.tertiaryText)
                        .frame(maxWidth: .infinity)
                        .glassCard()
                }
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
            .padding(.bottom, 100)
        }
        .background(AppTheme.background)
        .navigationTitle("Activity")
        #if os(iOS)
        .toolbarColorScheme(.dark, for: .navigationBar)
        #endif
        .sheet(isPresented: Binding(
            get: { transactionToEdit != nil },
            set: { if !$0 { transactionToEdit = nil } }
        )) {
            if let tx = transactionToEdit {
                EditTransactionView(transaction: tx) { savedTransaction in
                    do {
                        try modelContext.save()
                        let fileName = savedTransaction.ownerMember == .mason ? "mason-transactions" : "transactions"
                        let dto = MC2Transaction(appTransaction: savedTransaction)
                        Task { try? await syncClient.appendTransaction(dto, to: fileName) }
                    } catch {}
                    transactionToEdit = nil
                }
            }
        }
    }

    // MARK: - Header

    private var screenHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ALL TRANSACTIONS")
                .font(AppTheme.eyebrowFont)
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)
            Text("Activity")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Filter

    private var filterPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(TxFilter.allCases, id: \.self) { f in
                    Button {
                        withAnimation(AppTheme.entryAnimation) { filter = f }
                    } label: {
                        Text(f.label)
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(filter == f ? AppTheme.accentColor : Color.clear)
                            .foregroundStyle(filter == f ? .white : AppTheme.secondaryText)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Day Group

    private func dayGroup(day: String, transactions: [Transaction]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(day.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(AppTheme.secondaryText)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(transactions.enumerated()), id: \.element.id) { index, tx in
                    Button {
                        transactionToEdit = tx
                    } label: {
                        HStack(spacing: 12) {
                            Text(String(tx.merchant.prefix(1)).uppercased())
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundStyle(AppTheme.accentColor)
                                .frame(width: 36, height: 36)
                                .background(AppTheme.accentSoft)
                                .clipShape(RoundedRectangle(cornerRadius: 10))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(tx.merchant)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(AppTheme.primaryText)
                                    .lineLimit(1)
                                HStack(spacing: 5) {
                                    Text(tx.category)
                                    if let card = tx.card {
                                        Text("·")
                                        Text(card)
                                    }
                                }
                                .font(.system(size: 11))
                                .foregroundStyle(AppTheme.tertiaryText)
                            }

                            Spacer()

                            Text(formatCurrency(tx.amount))
                                .font(AppTheme.monoData)
                                .foregroundStyle(AppTheme.primaryText)
                        }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                    }
                    .buttonStyle(.plain)

                    if index < transactions.count - 1 {
                        Divider()
                            .background(AppTheme.cardBorder)
                            .padding(.leading, 62)
                    }
                }
            }
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
            )
        }
    }
}

private enum TxFilter: CaseIterable {
    case all, income, spends

    var label: String {
        switch self {
        case .all: "All"
        case .income: "Income"
        case .spends: "Spends"
        }
    }
}
