import SwiftData
import SwiftUI

struct BTCBuysView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BTCBuy.date, order: .reverse) private var allBuys: [BTCBuy]

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var visibleBuys: [BTCBuy] {
        allBuys.filter { buy in
            guard let owner = buy.ownerMember else { return false }
            guard activeMember.sharesNetWorth(with: owner) else { return false }
            return buy.amountBTC > 0 && buy.usd > 0
        }
    }

    private var totalBtc: Decimal {
        visibleBuys.reduce(Decimal(0)) { $0 + $1.amountBTC }
    }

    private var totalUsd: Decimal {
        visibleBuys.reduce(Decimal(0)) { $0 + $1.usd }
    }

    private var grouped: [(String, [BTCBuy])] {
        AppFormatter.groupedByMonth(visibleBuys, by: \.date)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                #if os(iOS)
                    Color.clear
                        .frame(height: AppLayout.cardSpacing)
                #else
                    ScreenHeader(title: "Bitcoin Buys", eyebrow: "DCA Log")
                #endif

                summaryCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                ForEach(grouped, id: \.0) { month, buys in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(month.uppercased())
                            .ledgerType(.sectionLabel)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(buys.enumerated()), id: \.element.id) { idx, buy in
                                buyRow(buy)
                                if idx < buys.count - 1 {
                                    Hairline(indent: 56)
                                }
                            }
                        }
                        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    }
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)
                }
            }
            .padding(.bottom, 160)
        }
        .background(theme.bg)
        .navigationTitle("Bitcoin Buys")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        #endif
    }

    private var summaryCard: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("TOTAL BOUGHT")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(.white.opacity(0.7))
                AmountView(sats: totalBtc * 100_000_000, unit: unit, role: .kpiValue, color: .white, btcPrice: btcPrice)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("TOTAL INVESTED")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(.white.opacity(0.7))
                AmountView(sats: btcPrice > 0 ? (totalUsd / btcPrice) * 100_000_000 : 0, unit: unit, role: .kpiValue, color: .white, btcPrice: btcPrice)
            }
        }
        .padding(20)
        .background(
            LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing),
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func buyRow(_ buy: BTCBuy) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    BtcGlyphView(size: 18, color: theme.accent),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(buy.source)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(buy.date.formatted(.dateTime.month(.abbreviated).day()))
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                AmountView(sats: buy.amountBTC * 100_000_000, unit: unit, role: .rowFigure, btcPrice: btcPrice)
                Text("@ \(AppFormatter.formatCurrency(buy.priceUSD))")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .padding(14)
    }
}
