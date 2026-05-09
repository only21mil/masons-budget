import SwiftUI
import SwiftData

struct MoneyTab: View {
    private let title: String
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var btcBuys: [BTCBuy]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query private var transactions: [Transaction]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @AppStorage(BTCPriceService.sourceKey) private var liveBTCPriceSource: String = ""
    @AppStorage(StockPriceService.vooPriceKey) private var liveVOOPriceUSD: Double = 0
    @AppStorage(StockPriceService.ibitPriceKey) private var liveIBITPriceUSD: Double = 0
    @AppStorage("btc_display_unit") private var btcDisplayUnitRaw: String = BitcoinDisplayUnit.btc.rawValue

    init(title: String = "Stack") {
        self.title = title
    }

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myBtcAccounts: [BTCAccount] {
        btcAccounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var myHoldingAccounts: [HoldingAccount] {
        holdingAccounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var recentPaychecks: [Transaction] {
        transactions
            .filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) && $0.category.lowercased() == "income" }
            .sorted { $0.date > $1.date }
    }

    private var myBtcBuys: [BTCBuy] {
        btcBuys.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember ?? .victor) }
    }

    private var totalBtc: Decimal {
        myBtcAccounts.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var totalHoldingsValue: Decimal {
        myHoldingAccounts.reduce(Decimal(0)) { $0 + $1.totalValue }
    }

    private var liveHoldingsValue: Decimal {
        myHoldingAccounts.reduce(Decimal(0)) { total, account in
            total + account.liveValue(vooPrice: liveVOOPrice, ibitPrice: liveIBITPrice)
        }
    }

    private var liveVOOPrice: Decimal? {
        liveVOOPriceUSD > 0 ? Decimal(liveVOOPriceUSD) : nil
    }

    private var liveIBITPrice: Decimal? {
        liveIBITPriceUSD > 0 ? Decimal(liveIBITPriceUSD) : nil
    }

    private var btcDisplayUnit: Binding<BitcoinDisplayUnit> {
        Binding(
            get: { BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc },
            set: { btcDisplayUnitRaw = $0.rawValue }
        )
    }

    private var estimatedBtcUsd: Decimal {
        myBtcAccounts.reduce(Decimal(0)) { $0 + $1.usdValue(liveBTCPrice: liveBTCPrice) }
    }

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
    }

    private var latestSnapshot: MonthlyBudgetSnapshot? {
        snapshots.sorted { $0.lastUpdated > $1.lastUpdated }.first
    }

    private var mtdIncome: Decimal {
        latestSnapshot?.mtdIncome ?? 0
    }

    private var ytdIncome: Decimal {
        latestSnapshot?.ytdIncome ?? 0
    }

    private var monthlySpending: Decimal {
        let cal = Calendar.current
        let referenceDate = latestSnapshotMonthDate ?? Date()
        let thisMonth = transactions.filter {
            currentMember.canSee(dataOwnedBy: $0.ownerMember) &&
            cal.isDate($0.date, equalTo: referenceDate, toGranularity: .month) &&
            ($0.category.lowercased() != "income")
        }
        return thisMonth.reduce(Decimal(0)) { $0 + $1.amount }
    }

    private var ytdSpending: Decimal {
        let cal = Calendar.current
        let referenceDate = latestSnapshotMonthDate ?? Date()
        guard let year = cal.dateComponents([.year], from: referenceDate).year,
              let startOfYear = cal.date(from: DateComponents(year: year, month: 1, day: 1)),
              let startOfNextMonth = cal.dateInterval(of: .month, for: referenceDate)?.end else {
            return 0
        }

        let yearToSelectedMonth = transactions.filter {
            currentMember.canSee(dataOwnedBy: $0.ownerMember) &&
            $0.date >= startOfYear &&
            $0.date < startOfNextMonth &&
            ($0.category.lowercased() != "income")
        }
        return yearToSelectedMonth.reduce(Decimal(0)) { $0 + $1.amount }
    }

    private var latestSnapshotMonthDate: Date? {
        latestSnapshot.flatMap { parseMonthYear($0.monthKey) }
    }

    private var monthlySavingsRate: Double {
        guard mtdIncome > 0 else { return 0 }
        let saved = mtdIncome - monthlySpending
        return Double(truncating: (saved / mtdIncome) as NSNumber)
    }

    private var yearlySavingsRate: Double {
        guard ytdIncome > 0 else { return 0 }
        let saved = ytdIncome - ytdSpending
        return Double(truncating: (saved / ytdIncome) as NSNumber)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    SectionHeader(title: "Total Net Worth", icon: "chart.pie.fill")
                    StatCard(
                        title: "Estimated Total",
                        value: formatCurrency(liveHoldingsValue + estimatedBtcUsd),
                        subtitle: "BTC (\(bitcoinStackValue)) @ \(btcPriceLabel) + 401k/WAP (\(formatCurrency(totalHoldingsValue)))",
                        icon: "dollarsign.circle.fill"
                    )

                    BitcoinUnitPicker(unit: btcDisplayUnit)
                        .glassCard()

                    NetWorthHistoryChart()
                    AssetBreakdownChart()

                    if let snapshot = latestSnapshot {
                        SectionHeader(title: "Income", icon: "arrow.down.circle.fill")
                        incomeSection(snapshot)
                    }

                    SectionHeader(title: "Bitcoin", icon: "bitcoinsign.circle")
                    if myBtcAccounts.isEmpty {
                        emptyState(icon: "bitcoinsign.circle", message: "BTC account balances will appear here once MC2 sync is configured.")
                    } else {
                        ForEach(myBtcAccounts.sorted(by: { $0.btc > $1.btc }), id: \.key) { account in
                            NavigationLink(destination: BTCAccountDetailView(account: account)) {
                                btcAccountRow(account)
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    if !myBtcBuys.isEmpty {
                        SectionHeader(title: "Recent Buys", icon: "arrow.up.right")
                        ForEach(myBtcBuys.sorted(by: { $0.date > $1.date }).prefix(5), id: \.id) { buy in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(buy.source).font(.caption).foregroundStyle(AppTheme.primaryText)
                                    Text(buy.date.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(AppTheme.tertiaryText)
                                }
                                Spacer()
                                BitcoinAmountView(
                                    btc: buy.amountBTC,
                                    unit: BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc,
                                    liveBTCPrice: liveBTCPrice,
                                    font: .caption.weight(.semibold),
                                    color: AppTheme.accentColor
                                )
                            }
                            .glassCard()
                        }
                    }

                    SectionHeader(title: "Retirement & Brokerage", icon: "building.columns.fill")
                    if myHoldingAccounts.isEmpty {
                        emptyState(icon: "building.columns", message: "401k and WAP holdings will appear here once MC2 sync is configured.")
                    } else {
                        ForEach(myHoldingAccounts, id: \.name) { account in
                            holdingAccountCard(account)
                        }
                    }
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
            }
            .background(AppTheme.background)
            .navigationTitle(title)
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    private var bitcoinStackValue: String {
        switch BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc {
        case .btc:
            return formatBtc(totalBtc)
        case .sats:
            return "\(formatSats(totalBtc)) sats"
        case .usd:
            return formatCurrency(estimatedBtcUsd)
        }
    }

    private func incomeSection(_ snapshot: MonthlyBudgetSnapshot) -> some View {
        VStack(spacing: AppTheme.cardSpacing) {
            HStack(spacing: AppTheme.cardSpacing) {
                StatCard(
                    title: "MTD Income",
                    value: formatCurrency(mtdIncome),
                    subtitle: "Actual income logged",
                    icon: "calendar"
                )
                StatCard(
                    title: "MTD Savings",
                    value: "\(Int(monthlySavingsRate * 100))%",
                    subtitle: monthlySpending > 0 ? "\(formatCurrency(mtdIncome - monthlySpending)) saved" : "No spending yet",
                    icon: "chart.line.uptrend.xyaxis"
                )
            }
            HStack(spacing: AppTheme.cardSpacing) {
                StatCard(
                    title: "YTD Income",
                    value: formatCurrency(ytdIncome),
                    subtitle: "Actual income logged",
                    icon: "calendar.badge.clock"
                )
                StatCard(
                    title: "YTD Savings",
                    value: "\(Int(yearlySavingsRate * 100))%",
                    subtitle: "\(formatCurrency(ytdIncome - ytdSpending)) saved",
                    icon: "chart.bar.fill"
                )
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Income Plan")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

                incomeRow(label: "Projected Monthly", value: snapshot.monthlyGross)
                incomeRow(label: "Weekly Gross", value: snapshot.weeklyGross)
                incomeRow(label: "Strike (weekly)", value: snapshot.weeklyStrike)
                incomeRow(label: "River (weekly)", value: snapshot.weeklyRiver)

                Divider().overlay(Color.white.opacity(0.05))
                HStack {
                    Text("Weekly Total")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.primaryText)
                    Spacer()
                    Text(formatCurrency(snapshot.weeklyStrike + snapshot.weeklyRiver))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppTheme.accentColor)
                }
            }
            .glassCard()

            if let note = snapshot.strategyNote {
                HStack(spacing: 8) {
                    Image(systemName: "lightbulb.fill")
                        .foregroundStyle(AppTheme.warning)
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                        .lineLimit(4)
                }
                .glassCard()
            }

            if !recentPaychecks.isEmpty {
                paycheckHistory
            }
        }
    }

    private var paycheckHistory: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Recent Paychecks")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText)
                Spacer()
                Text("\(recentPaychecks.count) total")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
            }
            .padding(.horizontal, 4)

            ForEach(recentPaychecks.prefix(8), id: \.id) { paycheck in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(paycheck.merchant)
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.primaryText)
                        Text(paycheck.date.formatted(date: .abbreviated, time: .omitted))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                    Spacer()
                    Text(formatCurrency(paycheck.amount))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(AppTheme.positive)
                }
                .padding(.horizontal, 4)
            }
        }
        .glassCard()
    }

    private func incomeRow(label: String, value: Decimal) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
            Spacer()
            Text(formatCurrency(value))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.primaryText)
        }
        .padding(.horizontal, 4)
    }
    private func btcAccountRow(_ account: BTCAccount) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(account.label)
                    .font(.headline)
                    .foregroundStyle(AppTheme.primaryText)
                Text(account.custody == .selfCustody ? "Self-custody" : "Exchange")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                BitcoinAmountView(
                    btc: account.btc,
                    unit: BitcoinDisplayUnit(rawValue: btcDisplayUnitRaw) ?? .btc,
                    liveBTCPrice: liveBTCPrice,
                    font: .headline,
                    color: AppTheme.accentColor
                )
                Text(formatCurrency(account.usdValue(liveBTCPrice: liveBTCPrice)))
                    .font(.caption2)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(AppTheme.tertiaryText)
        }
        .glassCard()
    }

    private var btcPriceLabel: String {
        guard let liveBTCPrice else { return "snapshot" }
        let source = liveBTCPriceSource.isEmpty ? "live" : liveBTCPriceSource
        return "\(formatCurrency(liveBTCPrice)) \(source)"
    }

    private func holdingAccountCard(_ account: HoldingAccount) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(account.provider)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                Text(formatCurrency(account.liveValue(vooPrice: liveVOOPrice, ibitPrice: liveIBITPrice)))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(AppTheme.positive)
            }
            if !account.holdings.isEmpty {
                Divider().overlay(Color.white.opacity(0.05))
                ForEach(account.holdings, id: \.name) { holding in
                    HStack {
                        Text(holding.ticker ?? holding.name)
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                        Spacer()
                        Text(formatCurrency(holding.value))
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                        Text("\(String(format: "%.1f", Double(truncating: holding.gainPct as NSNumber)))%")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(holding.gainPct >= 0 ? AppTheme.positive : AppTheme.negative)
                            .frame(width: 50, alignment: .trailing)
                    }
                }
            }
        }
        .glassCard()
    }

    private func parseMonthYear(_ raw: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "MMMM yyyy"
        return formatter.date(from: raw)
    }

    private func emptyState(icon: String, message: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(AppTheme.tertiaryText)
            Text(message)
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

#Preview {
    MoneyTab()
}
