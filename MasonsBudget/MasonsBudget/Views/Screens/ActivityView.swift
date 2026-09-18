import SwiftData
import SwiftUI

struct ActivityView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.modelContext) private var modelContext
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State var todayOnly = false
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @State private var recategorizing: Transaction?
    @State private var deleting: Transaction?
    @State private var mutationInFlight = false
    @State private var writeMessage: String?
    @State private var showWriteError = false

    @AppStorage(ConvexSyncService.versionsMemberKey) private var syncedMember = ""
    @AppStorage(ConvexSyncService.lastSyncKey) private var lastSync = 0.0

    @State private var showingAdd = false
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

        return scoped.filter { (!todayOnly || Calendar.current.isDateInToday($0.date)) && SearchMatcher.matches(transaction: $0, query: searchText) }
    }

    private var grouped: [(Date, [Transaction])] {
        let grouped = Dictionary(grouping: filtered) { Calendar.current.startOfDay(for: $0.date) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        List {
            ScreenHeader(title: "Activity", eyebrow: todayOnly ? "Today" : "Bolt + Chain")
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            filterPills.listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            if filter == .income { incomeRows }
            else { transactionGroups }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .searchable(text: $searchText, prompt: "Search activity")
        .modifier(LedgerListRefresh())
        .sheet(isPresented: $showingAdd) {
            AddTransactionView(initialType: filter == .income ? .income : .spend)
        }
        .confirmationDialog("Choose category", isPresented: Binding(
            get: { recategorizing != nil }, set: { if !$0 { recategorizing = nil } }
        ), titleVisibility: .visible) {
            if let transaction = recategorizing {
                ForEach(categories.filter { transaction.ownerMember.sharesNetWorth(with: $0.ownerMember) && !$0.isIncome }, id: \.name) { category in
                    Button(category.displayName) { recategorize(transaction, category: category.displayName) }
                }
            }
        }
        .confirmationDialog("Delete transaction?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }
        ), titleVisibility: .visible) {
            if let transaction = deleting {
                Button("Delete", role: .destructive) { delete(transaction) }
            }
        }
        .alert("Activity", isPresented: $showWriteError) { Button("OK", role: .cancel) {} } message: {
            Text(writeMessage ?? "The change could not be saved.")
        }
    }

    private var incomeRows: some View {
        Group {
            if let summary = canonicalFinancials.income.value {
                let rows = summary.rows.filter {
                    activeMember.canSee(dataOwnedBy: $0.owner) &&
                        ActivityDateScope.includesIncomeDate($0.date, todayOnly: todayOnly, now: Date()) &&
                        (searchText.isEmpty || "\($0.source) \($0.note ?? "") \($0.date)".localizedCaseInsensitiveContains(searchText))
                }
                if rows.isEmpty {
                    Text(searchText.isEmpty ? "No income entries yet" : "No matching income")
                        .ledgerType(.rowPrimary)
                    if searchText.isEmpty && !todayOnly {
                        Button("Add income") { showingAdd = true }
                    } else {
                        Button("Clear filters") { searchText = ""; todayOnly = false }
                    }
                }
                ForEach(rows, id: \.incomeId) { row in
                    NavigationLink { IncomeActivityDetail(row: row) } label: {
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
                    }
                    .listRowBackground(theme.surface)
                }
            } else {
                Text("Income is unavailable. Refresh to try again.").ledgerType(.rowMeta)
                LedgerRefreshButton()
            }
        }
        .foregroundStyle(theme.text)
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
            .padding(.horizontal, ledgerTokens.metrics.screenGutter)
        }
    }

    // MARK: - Transaction Groups

    @ViewBuilder
    private var transactionGroups: some View {
        if grouped.isEmpty {
            let sourceLoaded = syncedMember == activeMember.rawValue && UserDefaults.standard.dictionary(forKey: ConvexSyncService.dataVersionsKey)?[activeMember.transactionsDataFileName] != nil
            let hasFilters = !searchText.isEmpty || filter != .all || todayOnly
            Text(!sourceLoaded ? "Activity unavailable" : hasFilters ? "No matching transactions" : "No transactions yet").ledgerType(.rowPrimary)
            if !sourceLoaded {
                LedgerRefreshButton()
            } else if hasFilters {
                Button("Clear filters") { searchText = ""; filter = .all; todayOnly = false }
            } else {
                Button("Add transaction") { showingAdd = true }
                    .accessibilityIdentifier("activity.empty.add")
            }
        } else {
            ForEach(grouped, id: \.0) { day, rows in
                Section {
                    ForEach(rows) { tx in
                        txRow(tx: tx)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(theme.surface)
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                if !tx.isIncome {
                                    Button("Category", systemImage: "tag") { recategorizing = tx }
                                        .tint(theme.accentFill)
                                        .disabled(mutationInFlight)
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = tx }
                                    .disabled(mutationInFlight)
                            }
                            .contextMenu {
                                if !tx.isIncome { Button("Change category") { recategorizing = tx }.disabled(mutationInFlight) }
                                Button("Delete", role: .destructive) { deleting = tx }.disabled(mutationInFlight)
                            }
                    }
                } header: {
                    Text(day.formatted(.dateTime.year().month().day()))
                        .ledgerType(.sectionLabel)
                }
            }
        }
    }

    private func recategorize(_ transaction: Transaction, category: String) {
        guard !mutationInFlight else { return }
        mutationInFlight = true
        let candidate = Transaction(
            id: transaction.id, date: transaction.date, merchant: transaction.merchant,
            amount: transaction.amount, category: category, amountSats: transaction.amountSats,
            enteredInBitcoin: transaction.enteredInBitcoin, card: transaction.card,
            bitcoinAccountKey: transaction.bitcoinAccountKey, note: transaction.note,
            owner: transaction.ownerMember.ledgerOwner, createdBy: transaction.createdBy,
            createdAt: transaction.createdAt, sourceFile: transaction.sourceFile, updatedAtMs: transaction.updatedAtMs
        )
        TransactionDetailWriteFlow.save(transaction, candidate: candidate) { result in
            finishMutation(result, operation: "Change category")
        }
    }

    private func delete(_ transaction: Transaction) {
        guard !mutationInFlight else { return }
        mutationInFlight = true
        AppWriteSyncService.deleteTransaction(transaction, owner: transaction.ownerMember) { result in
            if result.isOk { modelContext.delete(transaction) }
            finishMutation(result, operation: "Delete transaction")
        }
    }

    private func finishMutation(_ result: ConvexWriteResult, operation: String) {
        mutationInFlight = false
        if !result.isOk {
            writeMessage = result.userMessage(operation: operation)
            showWriteError = true
            return
        }
        do { try modelContext.save() }
        catch { writeMessage = "Saved online. Refresh to update this device."; showWriteError = true }
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

/// Income dates are calendar dates, not UTC instants. Match the local ledger day.
enum ActivityDateScope {
    static func includesIncomeDate(_ date: String, todayOnly: Bool, now: Date, calendar: Calendar = .current) -> Bool {
        guard todayOnly else { return true }
        return date == LegacyTransactionDTO.dateString(from: now, timeZone: calendar.timeZone)
    }
}
