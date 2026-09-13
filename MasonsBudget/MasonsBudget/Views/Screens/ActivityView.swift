import SwiftData
import SwiftUI

struct ActivityView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State private var filter: TxFilter = .all
    @State private var searchText = ""

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
        case legacyIncome = "Legacy income"
        case spends = "Spends"
        case lightning = "Bolt"
        case onChain = "Chain"

        var rail: PaymentRailPresentation? {
            switch self {
            case .lightning: .bolt
            case .onChain: .chain
            default: nil
            }
        }
    }

    private var filtered: [Transaction] {
        let visible = allTransactions.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
        // Rails are a filter over the stored wire, not a display concern.
        // Each rail matches its active Bitcoin-native wires plus the retired
        // wire it succeeds: Lightning takes zeus_lightning and the historical
        // "lightning" rows; On-chain takes zeus_on_chain, the historical
        // "on-chain" rows, and nil-card rows (TransactionDetailView no longer
        // stamps a default onto nil rows when editing, but existing ones keep
        // appearing here — bucket semantics are a filter concern, not a write
        // one). River and Strike live in no rail; All and Spends cover them,
        // matching Android.
        let scoped: [Transaction] = switch filter {
        case .all: visible
        case .income: []
        case .legacyIncome: visible.filter(\.isIncome)
        case .spends: visible.filter(\.isSpend)
        case .lightning: visible.filter { TransactionSourceCatalog.activityRail(forCard: $0.card) == .lightning }
        case .onChain: visible.filter { TransactionSourceCatalog.activityRail(forCard: $0.card) == .onChain }
        }

        return scoped.filter { SearchMatcher.matches(transaction: $0, query: searchText) }
    }

    private static let shortDateFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df
    }()

    private var grouped: [(String, [Transaction])] {
        let cal = Calendar.current
        var map: [String: [Transaction]] = [:]
        for tx in filtered {
            let key: String
            if cal.isDateInToday(tx.date) { key = "Today" }
            else if cal.isDateInYesterday(tx.date) { key = "Yesterday" }
            else {
                key = Self.shortDateFormatter.string(from: tx.date)
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
                        eyebrow: "Bolt + Chain",
                    )
                    Spacer()
                }

                filterPills
                    .padding(.bottom, AppLayout.cardSpacing)

                if filter == .income {
                    incomeRows
                } else {
                    transactionGroups
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .searchable(text: $searchText, prompt: "Search activity")
    }

    private var incomeRows: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = canonicalFinancials.income.value {
                let rows = summary.rows.filter {
                    activeMember.canSee(dataOwnedBy: $0.owner) &&
                        (searchText.isEmpty || "\($0.source) \($0.note ?? "") \($0.date)".localizedCaseInsensitiveContains(searchText))
                }
                if rows.isEmpty {
                    Text(searchText.isEmpty ? "No income entries yet" : "No matching income")
                        .ledgerType(.rowPrimary)
                }
                ForEach(rows, id: \.incomeId) { row in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.source).ledgerType(.rowPrimary)
                            Text(row.date).ledgerType(.rowMeta)
                            if let note = row.note { Text(note).ledgerType(.rowMeta) }
                        }
                        Spacer()
                        Text(AppFormatter.formatCurrency(Decimal(row.amountCents) / 100))
                            .ledgerType(.rowFigure)
                    }
                    .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
                }
            } else {
                Text("Income is unavailable. Refresh to try again.").ledgerType(.rowMeta)
            }
        }
        .foregroundStyle(theme.text)
        .padding(.horizontal, AppLayout.sectionPadding)
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

    @ViewBuilder
    private var transactionGroups: some View {
        let isSearching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        LazyVStack(spacing: AppLayout.cardSpacing) {
            if grouped.isEmpty {
                Text(isSearching ? "No matching transactions" : "No transactions yet")
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
            } else {
                ForEach(grouped, id: \.0) { day, txs in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(day.uppercased())
                            .ledgerType(.sectionLabel)
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
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        if let rail = PaymentRailPresentation.forCard(tx.card) {
                            Image(systemName: rail.icon)
                                .font(AppFont.icon(size: 10, weight: .regular))
                                .foregroundStyle(theme.accent)
                            Text(rail.rawValue)
                                .ledgerType(.chip)
                                .foregroundStyle(theme.textMuted)
                        } else {
                            Image(systemName: PaymentMethod.icon(forWire: tx.card))
                                .font(AppFont.icon(size: 10, weight: .regular))
                                .foregroundStyle(theme.textMuted)
                            Text(PaymentMethod.label(forWire: tx.card))
                                .ledgerType(.rowMeta)
                                .foregroundStyle(theme.textMuted)
                        }
                    }
                }

                Spacer()

                AmountView(sats: tx.displaySatsValue(btcPrice: btcPrice), unit: unit, role: .rowFigure, showSign: true, accent: isIncome, btcPrice: btcPrice)
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
