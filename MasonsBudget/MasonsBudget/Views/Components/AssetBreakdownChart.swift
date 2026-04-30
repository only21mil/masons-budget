import SwiftUI
import SwiftData
import Charts

struct AssetBreakdownChart: View {
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]

    private var btcTotal: Decimal {
        btcAccounts.reduce(Decimal(0)) { $0 + $1.btc } * AppTheme.assumedBTCPrice
    }

    private var holdingsTotal: Decimal {
        holdingAccounts.reduce(Decimal(0)) { $0 + $1.totalValue }
    }

    private var segments: [(String, Decimal, Color)] {
        var items: [(String, Decimal, Color)] = []
        for account in btcAccounts.sorted(by: { $0.btc > $1.btc }) {
            let value = account.btc * AppTheme.assumedBTCPrice
            if value > 0 {
                items.append((account.label, value, AppTheme.accentColor))
            }
        }
        for account in holdingAccounts.sorted(by: { $0.totalValue > $1.totalValue }) {
            if account.totalValue > 0 {
                items.append((account.provider, account.totalValue, AppTheme.secondaryAccent))
            }
        }
        return items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Asset Breakdown", icon: "chart.pie.fill")

            if segments.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "chart.pie")
                        .font(.title3)
                        .foregroundStyle(AppTheme.tertiaryText)
                    Text("Asset breakdown will appear after syncing from MC2.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
            } else {
                Chart(segments, id: \.0) { item in
                    SectorMark(
                        angle: .value("Value", item.1),
                        innerRadius: .ratio(0.55),
                        angularInset: 1
                    )
                    .foregroundStyle(item.2)
                }
                .frame(height: 200)

                VStack(spacing: 8) {
                    ForEach(segments, id: \.0) { name, value, color in
                        HStack {
                            Circle()
                                .fill(color)
                                .frame(width: 10, height: 10)
                            Text(name)
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                            Spacer()
                            Text(formatCurrency(value))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AppTheme.primaryText)
                            Text("\(pctString(value))%")
                                .font(.caption)
                                .foregroundStyle(AppTheme.tertiaryText)
                                .frame(width: 40, alignment: .trailing)
                        }
                    }
                }
            }
        }
        .glassCard()
    }

    private var totalValue: Decimal {
        segments.reduce(Decimal(0)) { $0 + $1.1 }
    }

    private func pctString(_ value: Decimal) -> String {
        guard totalValue > 0 else { return "0" }
        let pct = Double(truncating: (value / totalValue * 100) as NSNumber)
        return String(format: "%.0f", pct)
    }
}
