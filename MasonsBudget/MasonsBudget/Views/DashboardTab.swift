import SwiftUI
import SwiftData
import os

struct DashboardTab: View {
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @AppStorage(StockPriceService.vooPriceKey) private var liveVOOPriceUSD: Double = 0
    @AppStorage(StockPriceService.ibitPriceKey) private var liveIBITPriceUSD: Double = 0
    @State private var showVoiceCapture = false
    @State private var showAddTransaction = false
    @Binding var selectedTab: AppTab
    private let syncClient = ConvexClient(deploymentURL: ConvexConfig.deploymentURL)
    private let log = Logger(subsystem: "com.sats21m.masonsbudget", category: "Dashboard")

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    init(selectedTab: Binding<AppTab>) {
        self._selectedTab = selectedTab
    }

    private var myTransactions: [Transaction] {
        transactions.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var currentMonthTransactions: [Transaction] {
        let cal = Calendar.current
        let now = Date()
        return myTransactions.filter {
            cal.isDate($0.date, equalTo: now, toGranularity: .month)
        }
    }

    private var myBtcAccounts: [BTCAccount] {
        btcAccounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var myHoldingAccounts: [HoldingAccount] {
        holdingAccounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var netWorth: Decimal {
        let holdingsTotal = myHoldingAccounts.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: liveVOOPrice, ibitPrice: liveIBITPrice) }
        let btcValue = myBtcAccounts.reduce(Decimal(0)) { $0 + $1.usdValue(liveBTCPrice: liveBTCPrice) }
        return holdingsTotal + btcValue
    }

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
    }

    private var liveVOOPrice: Decimal? {
        liveVOOPriceUSD > 0 ? Decimal(liveVOOPriceUSD) : nil
    }

    private var liveIBITPrice: Decimal? {
        liveIBITPriceUSD > 0 ? Decimal(liveIBITPriceUSD) : nil
    }

    private var latestSnapshot: MonthlyBudgetSnapshot? {
        snapshots.sorted { $0.lastUpdated > $1.lastUpdated }.first
    }

    private var totalSpent: Decimal {
        currentMonthTransactions.reduce(Decimal(0)) { $0 + $1.amount }
    }

    private var totalBtc: Decimal {
        myBtcAccounts.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var totalBudgeted: Decimal {
        categories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var netWorthSubtitle: String {
        let hasBtc = !myBtcAccounts.isEmpty
        let hasHoldings = !myHoldingAccounts.isEmpty
        switch (hasBtc, hasHoldings) {
        case (true, true):  return "BTC + 401k + WAP"
        case (true, false): return "BTC only"
        case (false, true): return "401k + WAP"
        case (false, false): return "Connect MC2 to see totals"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    heroBalance
                    storageStatRow
                    incomeCard
                    monthSpending
                    recentActivity
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 100)
            }
            .background(AppTheme.background)
            .navigationTitle("Home")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .overlay(alignment: .bottom) {
                MicFAB { showVoiceCapture = true }
            }
            .fullScreenCover(isPresented: $showVoiceCapture) {
                VoiceCaptureView(onSave: { parsed in
                    handleVoiceSave(parsed)
                })
            }
            .sheet(isPresented: $showAddTransaction) {
                AddTransactionView(onSave: { amount, merchant, category, card, note in
                    handleManualSave(amount: amount, merchant: merchant, category: category, card: card, note: note)
                })
            }
            #else
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showVoiceCapture = true } label: {
                        Label("Voice Input", systemImage: "mic.fill")
                    }
                }
            }
            .sheet(isPresented: $showVoiceCapture) {
                VoiceCaptureView(onSave: { parsed in
                    handleVoiceSave(parsed)
                })
                .frame(minWidth: 400, minHeight: 500)
            }
            .sheet(isPresented: $showAddTransaction) {
                AddTransactionView(onSave: { amount, merchant, category, card, note in
                    handleManualSave(amount: amount, merchant: merchant, category: category, card: card, note: note)
                })
            }
            #endif
        }
    }

    private func handleManualSave(amount: Decimal, merchant: String, category: String, card: String?, note: String?) {
        record(amount: amount, merchant: merchant, category: category, card: card, note: note, date: Date(), source: .manual)
    }

    private func handleVoiceSave(_ parsed: ParsedTransaction) {
        guard let amount = parsed.amount,
              let merchant = parsed.merchant else { return }

        let date = parsed.date ?? Date()
        let category = resolveCanonicalCategory(parsed.category) ?? categories.first?.name ?? "Uncategorized"
        record(amount: amount, merchant: merchant, category: category, card: parsed.card, note: parsed.note, date: date, source: .voice)
    }

    private func record(amount: Decimal, merchant: String, category: String, card: String?, note: String?, date: Date, source: TransactionRecorder.Source) {
        do {
            try TransactionRecorder(modelContext: modelContext, convex: syncClient).record(
                amount: amount,
                merchant: merchant,
                category: category,
                card: card,
                note: note,
                date: date,
                owner: currentMember,
                source: source
            )
        } catch {
            log.error("Failed to record transaction: \(error.localizedDescription)")
        }
    }

    private func resolveCanonicalCategory(_ parsedCategory: String?) -> String? {
        guard let parsedCategory, !parsedCategory.isEmpty else { return nil }
        if let exact = categories.first(where: { $0.name == parsedCategory })?.name {
            return exact
        }
        return categories.first(where: { $0.name.caseInsensitiveCompare(parsedCategory) == .orderedSame })?.name
    }

    // MARK: - Hero Balance

    private var heroBalance: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("NET WORTH")
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)

            Text(formatCurrency(netWorth))
                .font(AppTheme.heroNumber)
                .foregroundStyle(AppTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            HStack(spacing: 8) {
                Text(netWorthSubtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Storage Stat Row

    private var coldBtc: Decimal {
        myBtcAccounts.filter { $0.custody == .selfCustody }.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var hotBtc: Decimal {
        myBtcAccounts.filter { $0.custody == .exchange }.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var storageStatRow: some View {
        HStack(spacing: 10) {
            storageStatCard(
                label: "Cold Storage",
                icon: "building.columns.fill",
                iconColor: AppTheme.plum,
                iconBg: AppTheme.plumSoft,
                value: formatBtc(coldBtc),
                subtitle: totalBtc > 0
                    ? "\(Int(Double(truncating: (coldBtc / totalBtc) as NSNumber) * 100))% of stack"
                    : "self-custody"
            )
            storageStatCard(
                label: "Spending",
                icon: "bolt.fill",
                iconColor: AppTheme.info,
                iconBg: AppTheme.infoSoft,
                value: formatBtc(hotBtc),
                subtitle: "exchange"
            )
        }
    }

    private func storageStatCard(label: String, icon: String, iconColor: Color, iconBg: Color, value: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(iconColor)
                    .frame(width: 18, height: 18)
                    .background(iconBg)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(label.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.5)
                    .foregroundStyle(iconColor)
            }
            Text(value)
                .font(AppTheme.subNumber)
                .foregroundStyle(AppTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(subtitle)
                .font(.system(size: 11))
                .foregroundStyle(AppTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    // MARK: - Income Card

    private var incomeCard: some View {
        let snapshot = latestSnapshot
        let mtdIncome = snapshot?.mtdIncome ?? 0
        let ytdIncome = snapshot?.ytdIncome ?? 0
        let mtdSpent = totalSpent
        let mtdSaved = mtdIncome - mtdSpent
        let mtdRate = mtdIncome > 0 ? Int(Double(truncating: (mtdSaved / mtdIncome) as NSNumber) * 100) : 0

        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                incomeCell(label: "INCOME MTD", value: mtdIncome, saved: mtdSaved, rate: mtdRate)
                Rectangle()
                    .fill(AppTheme.cardBorder)
                    .frame(width: 1)
                    .padding(.vertical, 12)
                incomeCell(label: "INCOME YTD", value: ytdIncome, saved: nil, rate: nil)
            }
        }
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
        )
    }

    private func incomeCell(label: String, value: Decimal, saved: Decimal?, rate: Int?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .tracking(1)
                .foregroundStyle(AppTheme.secondaryText)
            Text(formatCurrency(value))
                .font(AppTheme.subNumber)
                .foregroundStyle(AppTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let saved, let rate {
                HStack(spacing: 6) {
                    Text("\(rate)%")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(rate >= 30 ? AppTheme.accentColor : AppTheme.secondaryText)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(rate >= 30 ? AppTheme.accentSoft2 : AppTheme.surface2)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    Text("saved \(formatCurrency(saved))")
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.tertiaryText)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }

    // MARK: - Month Spending

    private var monthSpending: some View {
        let pct = totalBudgeted > 0 ? Int(Double(truncating: (totalSpent / totalBudgeted) as NSNumber) * 100) : 0
        let monthName = Date().formatted(.dateTime.month(.wide))

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(monthName) SPENDING")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.5)
                        .foregroundStyle(AppTheme.secondaryText)
                    Text("\(pct)% of monthly limit")
                        .font(.system(size: 13))
                        .foregroundStyle(AppTheme.tertiaryText)
                }
                Spacer()
                Text(formatCurrency(totalSpent))
                    .font(.system(size: 18, weight: .bold, design: .monospaced))
                    .foregroundStyle(AppTheme.primaryText)
            }

            if totalBudgeted > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(AppTheme.surface2)
                            .frame(height: 10)
                        HStack(spacing: 1) {
                            ForEach(
                                categories
                                    .filter { !$0.isIncome }
                                    .sorted(by: { ($0.displayRank, -$0.monthlyBudget) < ($1.displayRank, -$1.monthlyBudget) }),
                                id: \.name
                            ) { cat in
                                let spent = currentMonthTransactions.filter { $0.category == cat.name }.reduce(Decimal(0)) { $0 + $1.amount }
                                let width = totalBudgeted > 0 ? CGFloat(truncating: (spent / totalBudgeted) as NSNumber) * geo.size.width : 0
                                if width > 0 {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(AppTheme.accentColor.opacity(0.85))
                                        .frame(width: max(2, width), height: 10)
                                }
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    }
                }
                .frame(height: 10)

                let topCats = categories
                    .filter { !$0.isIncome }
                    .sorted(by: { ($0.displayRank, -$0.monthlyBudget) < ($1.displayRank, -$1.monthlyBudget) })
                    .prefix(4)
                let remaining = max(0, categories.filter { !$0.isIncome }.count - 4)

                HStack(spacing: 12) {
                    ForEach(Array(topCats), id: \.name) { cat in
                        HStack(spacing: 4) {
                            Text(cat.icon)
                                .font(.system(size: 10))
                            Text(cat.name)
                                .font(.system(size: 12))
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                    if remaining > 0 {
                        Text("+\(remaining) more")
                            .font(.system(size: 12))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                }
            }
        }
        .glassCard()
    }

    // MARK: - Recent Activity

    private var recentTransactions: [Transaction] {
        myTransactions.sorted { $0.date > $1.date }.prefix(4).map { $0 }
    }

    private var recentActivity: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Recent activity")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                NavigationLink {
                    ActivityView()
                } label: {
                    Text("See all")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.accentColor)
                }
            }
            .padding(.horizontal, 4)

            if recentTransactions.isEmpty {
                Text("No transactions yet")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.tertiaryText)
                    .frame(maxWidth: .infinity)
                    .glassCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(recentTransactions.enumerated()), id: \.element.id) { index, tx in
                        HStack(spacing: 12) {
                            Text(String(tx.merchant.prefix(1)).uppercased())
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundStyle(AppTheme.accentColor)
                                .frame(width: 34, height: 34)
                                .background(AppTheme.accentSoft)
                                .clipShape(RoundedRectangle(cornerRadius: 10))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(tx.merchant)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(AppTheme.primaryText)
                                    .lineLimit(1)
                                Text("\(tx.category) · \(tx.date.formatted(date: .abbreviated, time: .omitted))")
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

                        if index < recentTransactions.count - 1 {
                            Divider()
                                .background(AppTheme.cardBorder)
                                .padding(.leading, 60)
                        }
                    }
                }
                .background(AppTheme.cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                )
            }
        }
    }

}

#Preview {
    DashboardTab(selectedTab: .constant(.home))
}
