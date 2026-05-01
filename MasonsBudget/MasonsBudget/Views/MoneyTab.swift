import SwiftUI
import SwiftData

struct MoneyTab: View {
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var btcBuys: [BTCBuy]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query private var transactions: [Transaction]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myBtcAccounts: [BTCAccount] {
        btcAccounts.filter { $0.owner == currentMember }
    }

    private var myHoldingAccounts: [HoldingAccount] {
        holdingAccounts.filter { $0.owner == currentMember }
    }

    private var recentPaychecks: [Transaction] {
        transactions
            .filter { $0.owner == currentMember && $0.category.lowercased() == "income" }
            .sorted { $0.date > $1.date }
    }

    private var totalBtc: Decimal {
        myBtcAccounts.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var totalHoldingsValue: Decimal {
        myHoldingAccounts.reduce(Decimal(0)) { $0 + $1.totalValue }
    }

    private var estimatedBtcUsd: Decimal { totalBtc * AppTheme.assumedBTCPrice }

    private var latestSnapshot: MonthlyBudgetSnapshot? {
        snapshots.sorted { $0.monthKey > $1.monthKey }.first
    }

    private var monthlyGross: Decimal {
        latestSnapshot?.monthlyGross ?? 0
    }

    private var yearlyProjected: Decimal {
        monthlyGross * 12
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    SectionHeader(title: "Total Net Worth", icon: "chart.pie.fill")
                    StatCard(
                        title: "Estimated Total",
                        value: formatCurrency(totalHoldingsValue + estimatedBtcUsd),
                        subtitle: "BTC (\(formatBtc(totalBtc))) + 401k/WAP (\(formatCurrency(totalHoldingsValue)))",
                        icon: "dollarsign.circle.fill"
                    )

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
                            btcAccountRow(account)
                        }
                    }

                    if !btcBuys.isEmpty {
                        SectionHeader(title: "Recent Buys", icon: "arrow.up.right")
                        ForEach(btcBuys.sorted(by: { $0.date > $1.date }).prefix(5), id: \.id) { buy in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(buy.source).font(.caption).foregroundStyle(AppTheme.primaryText)
                                    Text(buy.date.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(AppTheme.tertiaryText)
                                }
                                Spacer()
                                Text(formatBtc(buy.amountBTC)).font(.caption).foregroundStyle(AppTheme.accentColor)
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
            .navigationTitle("Money")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    private func incomeSection(_ snapshot: MonthlyBudgetSnapshot) -> some View {
        VStack(spacing: AppTheme.cardSpacing) {
            HStack(spacing: AppTheme.cardSpacing) {
                StatCard(
                    title: "Monthly Gross",
                    value: formatCurrency(snapshot.monthlyGross),
                    subtitle: snapshot.payFrequency.capitalized,
                    icon: "calendar"
                )
                StatCard(
                    title: "Yearly Projected",
                    value: formatCurrency(yearlyProjected),
                    subtitle: "12 × monthly",
                    icon: "chart.bar.fill"
                )
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Weekly Breakdown")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText)
                    .padding(.horizontal, 4)

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
        VStack(alignment: .leading, spacing: 6) {
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
                    Text(formatBtc(account.btc))
                        .font(.headline)
                        .foregroundStyle(AppTheme.accentColor)
                    Text(formatCurrency(account.btc * AppTheme.assumedBTCPrice))
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            }
        }
        .glassCard()
    }

    private func holdingAccountCard(_ account: HoldingAccount) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(account.provider)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                Text(formatCurrency(account.totalValue))
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
