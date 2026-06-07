import SwiftData
import SwiftUI

struct ActivityView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State private var filter: TxFilter = .all
    @State private var searchText = ""
    @State private var showCSVImport = false

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    enum TxFilter: String, CaseIterable {
        case all = "All"
        case income = "Income"
        case spends = "Spends"
        case lightning = "Lightning"
        case onChain = "On-chain"
    }

    private var filtered: [Transaction] {
        let visible = allTransactions.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
        let scoped: [Transaction] = switch filter {
        case .all: visible
        case .income: visible.filter(\.isIncome)
        case .spends: visible.filter(\.isSpend)
        case .lightning: visible.filter { $0.card == "lightning" }
        case .onChain: visible.filter { $0.card == "on-chain" || $0.card == nil }
        }

        return scoped.filter { SearchMatcher.matches(transaction: $0, query: searchText) }
    }

    private var grouped: [(String, [Transaction])] {
        let cal = Calendar.current
        var map: [String: [Transaction]] = [:]
        for tx in filtered {
            let key: String
            if cal.isDateInToday(tx.date) { key = "Today" }
            else if cal.isDateInYesterday(tx.date) { key = "Yesterday" }
            else {
                let df = DateFormatter()
                df.dateFormat = "MMM d"
                key = df.string(from: tx.date)
            }
            map[key, default: []].append(tx)
        }
        let sortedKeys = map.keys.sorted { k1, k2 in
            if k1 == "Today" { return true }
            if k2 == "Today" { return false }
            if k1 == "Yesterday" { return true }
            if k2 == "Yesterday" { return false }
            return k1 > k2
        }
        return sortedKeys.map { ($0, map[$0]!) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    ScreenHeader(
                        title: "Activity",
                        eyebrow: "Lightning + On-chain",
                    )
                    Spacer()
                    Button {
                        showCSVImport = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "square.and.arrow.down")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Import")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(theme.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(theme.accentSoft)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, AppLayout.sectionPadding)
                    .padding(.top, 16)
                }

                filterPills
                    .padding(.bottom, AppLayout.cardSpacing)

                transactionGroups
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .searchable(text: $searchText, prompt: "Search activity")
        .sheet(isPresented: $showCSVImport) {
            CSVImportView()
        }
    }

    // MARK: - Filter Pills

    private var filterPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(TxFilter.allCases, id: \.self) { f in
                    PillButton(label: f.rawValue, isActive: filter == f, accent: true) {
                        filter = f
                    }
                }
            }
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    // MARK: - Transaction Groups

    private var transactionGroups: some View {
        let isSearching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        LazyVStack(spacing: AppLayout.cardSpacing) {
            if grouped.isEmpty {
                Text(isSearching ? "No matching transactions" : "No transactions yet")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.textFaint)
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
            } else {
                ForEach(grouped, id: \.0) { day, txs in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(day.uppercased())
                            .font(.system(size: 11, weight: .bold))
                            .tracking(0.66)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(txs.enumerated()), id: \.element.id) { idx, tx in
                                txRow(tx: tx)
                                if idx < txs.count - 1 {
                                    Hairline(indent: 60)
                                }
                            }
                        }
                        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    }
                }
            }
        }
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private func txRow(tx: Transaction) -> some View {
        let isIncome = tx.isIncome
        return NavigationLink {
            TransactionDetailView(transaction: tx)
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(isIncome ? theme.accentSoft2 : theme.surface2)
                    .frame(width: 36, height: 36)
                    .overlay(
                        Group {
                            if isIncome {
                                BtcGlyphView(size: 18, color: theme.accent)
                            } else {
                                CatGlyphView(kind: glyphFor(tx.category), size: 16, color: colorFor(tx.category))
                            }
                        },
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(tx.merchant)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Image(systemName: tx.card == "lightning" ? "bolt.fill" : "link")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.textFaint)
                        Text(tx.card ?? "On-chain")
                            .font(.system(size: 11))
                            .foregroundStyle(theme.textFaint)
                    }
                }

                Spacer()

                AmountView(sats: tx.displaySatsValue(btcPrice: btcPrice), unit: unit, size: 14, weight: .bold, showSign: true, accent: isIncome, btcPrice: btcPrice)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }

    private func glyphFor(_ category: String) -> String {
        let map: [String: String] = [
            "Housing": "home", "Groceries": "fork", "Dining": "fork",
            "Transport": "plane", "Health": "heart", "Utilities": "bolt",
            "Shopping": "gift", "Entertainment": "bolt", "Bitcoin": "vault",
        ]
        return map[category] ?? "wrench"
    }

    private func colorFor(_ category: String) -> Color {
        let map: [String: Color] = [
            "Housing": theme.plum, "Groceries": theme.success,
            "Dining": theme.warn, "Transport": theme.info,
            "Health": theme.danger, "Entertainment": theme.info,
            "Bitcoin": theme.accent,
        ]
        return map[category] ?? theme.textMuted
    }
}
