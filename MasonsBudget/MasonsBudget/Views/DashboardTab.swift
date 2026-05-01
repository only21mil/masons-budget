import SwiftUI
import SwiftData

struct DashboardTab: View {
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var transactions: [Transaction]
    @Query private var categories: [BudgetCategory]
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @State private var showVoiceCapture = false
    @State private var showAddTransaction = false
    @Binding var selectedTab: AppTab

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    init(selectedTab: Binding<AppTab>) {
        self._selectedTab = selectedTab
    }

    private var myTransactions: [Transaction] {
        transactions.filter { $0.owner == currentMember }
    }

    private var currentMonthTransactions: [Transaction] {
        let cal = Calendar.current
        let now = Date()
        return myTransactions.filter {
            cal.isDate($0.date, equalTo: now, toGranularity: .month)
        }
    }

    private var myBtcAccounts: [BTCAccount] {
        btcAccounts.filter { $0.owner == currentMember }
    }

    private var myHoldingAccounts: [HoldingAccount] {
        holdingAccounts.filter { $0.owner == currentMember }
    }

    private var netWorth: Decimal {
        let holdingsTotal = myHoldingAccounts.reduce(Decimal(0)) { $0 + $1.totalValue }
        let btcValue = myBtcAccounts.reduce(Decimal(0)) { $0 + $1.usdValue(liveBTCPrice: liveBTCPrice) }
        return holdingsTotal + btcValue
    }

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
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
                    syncStatusBanner

                    StatCard(
                        title: "Net Worth",
                        value: formatCurrency(netWorth),
                        subtitle: netWorthSubtitle,
                        icon: "chart.line.uptrend.xyaxis",
                        style: .hero
                    )

                    HStack(spacing: AppTheme.cardSpacing) {
                        QuickActionButton(
                            title: "Add\nTransaction",
                            icon: "plus",
                            color: AppTheme.accentColor
                        ) { showAddTransaction = true }
                        QuickActionButton(
                            title: "View\nSpending",
                            icon: "list.bullet",
                            color: AppTheme.secondaryAccent
                        ) { selectedTab = .spending }
                    }

                    budgetOverview

                    StatCard(
                        title: "Bitcoin Stack",
                        value: formatBtc(totalBtc),
                        subtitle: myBtcAccounts.isEmpty ? "Waiting for MC2 sync" : "\(myBtcAccounts.count) accounts",
                        icon: "bitcoinsign.circle"
                    )

                    if !categories.isEmpty {
                        budgetCategoryBars
                    }
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Dashboard")
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
            #endif
            .sheet(isPresented: $showAddTransaction) {
                AddTransactionView { amount, merchant, category, card, note in
                    handleManualSave(amount: amount, merchant: merchant, category: category, card: card, note: note)
                }
            }
        }
    }

    private func handleManualSave(amount: Decimal, merchant: String, category: String, card: String?, note: String?) {
        let id = "manual-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(6))"
        let tx = Transaction(
            id: id,
            date: Date(),
            merchant: merchant,
            amount: amount,
            category: category,
            card: card,
            note: note,
            owner: currentMember,
            createdBy: "manual",
            createdAt: Date()
        )
        modelContext.insert(tx)
        try? modelContext.save()
    }

    private func handleVoiceSave(_ parsed: ParsedTransaction) {
        guard let amount = parsed.amount,
              let merchant = parsed.merchant else { return }

        let date = parsed.date ?? Date()
        let category = parsed.category ?? "Other"
        let card = parsed.card
        let note = parsed.note

        let id = "voice-\(Int(date.timeIntervalSince1970))-\(UUID().uuidString.prefix(6))"
        let tx = Transaction(
            id: id,
            date: date,
            merchant: merchant,
            amount: amount,
            category: category,
            card: card,
            note: note,
            owner: currentMember,
            createdBy: "voice",
            createdAt: Date()
        )
        modelContext.insert(tx)
        try? modelContext.save()
    }

    private var syncStatusBanner: some View {
        Group {
            if snapshots.isEmpty && myBtcAccounts.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(AppTheme.accentColor)
                    Text("Connect MC2 to sync your data")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.tertiaryText)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AppTheme.warmGlow)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(AppTheme.accentColor.opacity(0.2), lineWidth: 1)
                )
            }
        }
    }

    private var budgetOverview: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(latestSnapshot?.monthKey ?? "Budget")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    Text(formatCurrency(latestSnapshot?.monthlyGross ?? 0))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppTheme.primaryText)
                }
                Spacer()
                if totalBudgeted > 0 {
                    budgetRing
                }
            }
            if !categories.isEmpty {
                HStack(spacing: 4) {
                    Text("\(categories.count) categories")
                    Text("·")
                    Text("\(formatCurrency(totalSpent)) spent")
                }
                .font(.caption2)
                .foregroundStyle(AppTheme.tertiaryText)
            }
        }
        .glassCard()
    }

    private var budgetRing: some View {
        let pct = totalBudgeted > 0 ? Double(truncating: (totalSpent / totalBudgeted) as NSNumber) : 0
        return ZStack {
            Circle()
                .stroke(AppTheme.background, lineWidth: 5)
            Circle()
                .trim(from: 0, to: min(pct, 1.0))
                .stroke(
                    pct > 1.0 ? AppTheme.negative : AppTheme.accentColor,
                    style: StrokeStyle(lineWidth: 5, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            Text("\(Int(pct * 100))%")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(width: 44, height: 44)
    }

    private var budgetCategoryBars: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Top Categories", icon: "chart.bar.fill")
            ForEach(categories.sorted(by: { $0.monthlyBudget > $1.monthlyBudget }).prefix(4), id: \.name) { cat in
                let spent = currentMonthTransactions.filter { $0.category == cat.name }.reduce(Decimal(0)) { $0 + $1.amount }
                let pct = cat.monthlyBudget > 0 ? spent / cat.monthlyBudget : 0
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text("\(cat.icon) \(cat.name)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AppTheme.primaryText)
                        Spacer()
                        Text(formatCurrency(spent))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(pct > 1.0 ? AppTheme.negative : AppTheme.primaryText)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(AppTheme.background)
                                .frame(height: 6)
                            RoundedRectangle(cornerRadius: 4)
                                .fill(
                                    pct > 1.0
                                    ? LinearGradient(colors: [AppTheme.negative, AppTheme.negative.opacity(0.7)], startPoint: .leading, endPoint: .trailing)
                                    : LinearGradient(colors: [AppTheme.accentColor, AppTheme.accentColor.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
                                )
                                .frame(width: max(0, min(geo.size.width, CGFloat(truncating: pct as NSNumber) * geo.size.width)), height: 6)
                        }
                    }
                    .frame(height: 6)
                }
            }
        }
        .glassCard()
    }

}

#Preview {
    DashboardTab(selectedTab: .constant(.dashboard))
}
