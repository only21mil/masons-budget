import SwiftUI
import SwiftData

struct MoneyTab: View {
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var btcBuys: [BTCBuy]

    private var totalBtc: Decimal {
        btcAccounts.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var totalHoldingsValue: Decimal {
        holdingAccounts.reduce(Decimal(0)) { $0 + $1.totalValue }
    }

    private var estimatedBtcUsd: Decimal { totalBtc * AppTheme.assumedBTCPrice }

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

                    SectionHeader(title: "Bitcoin", icon: "bitcoinsign.circle")
                    if btcAccounts.isEmpty {
                        emptyState(icon: "bitcoinsign.circle", message: "BTC account balances will appear here once MC2 sync is configured.")
                    } else {
                        ForEach(btcAccounts.sorted(by: { $0.btc > $1.btc }), id: \.key) { account in
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
                    if holdingAccounts.isEmpty {
                        emptyState(icon: "building.columns", message: "401k and WAP holdings will appear here once MC2 sync is configured.")
                    } else {
                        ForEach(holdingAccounts, id: \.name) { account in
                            holdingAccountCard(account)
                        }
                    }
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
            }
            .background(AppTheme.background)
            .navigationTitle("Money")
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
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
