import SwiftUI
import SwiftData

struct BTCBillPayView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BTCBillPay.date, order: .reverse) private var allBillPays: [BTCBillPay]

    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var visibleBillPays: [BTCBillPay] {
        allBillPays.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var totalUsd: Decimal { visibleBillPays.reduce(Decimal(0)) { $0 + $1.amountUSD } }
    private var totalBtcSpent: Decimal { visibleBillPays.reduce(Decimal(0)) { $0 + $1.btcSpent } }

    private var grouped: [(String, [BTCBillPay])] {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        var map: [String: [BTCBillPay]] = [:]
        for bp in visibleBillPays {
            let key = df.string(from: bp.date)
            map[key, default: []].append(bp)
        }
        let sorted = map.keys.sorted { k1, k2 in
            let d1 = map[k1]?.first?.date ?? .distantPast
            let d2 = map[k2]?.first?.date ?? .distantPast
            return d1 > d2
        }
        return sorted.compactMap { key in
            guard let pays = map[key], !pays.isEmpty else { return nil }
            return (key, pays)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Bill Pay", eyebrow: "Pay Bills in Bitcoin")

                summaryCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                ForEach(grouped, id: \.0) { month, billPays in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(month.uppercased())
                            .font(.system(size: 11, weight: .bold))
                            .tracking(0.66)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(billPays.enumerated()), id: \.element.id) { idx, bp in
                                billPayRow(bp)
                                if idx < billPays.count - 1 {
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
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Bill Pay")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private var summaryCard: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("BILLS PAID")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.66)
                    .foregroundStyle(.white.opacity(0.7))
                Text(AppFormatter.formatCurrency(totalUsd))
                    .font(.system(size: 22, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("BTC SPENT")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.66)
                    .foregroundStyle(.white.opacity(0.7))
                Text(AppFormatter.formatBtc(totalBtcSpent) + " BTC")
                    .font(.system(size: 22, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
            }
        }
        .padding(20)
        .background(
            LinearGradient(colors: [theme.plum, theme.plum.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func billPayRow(_ bp: BTCBillPay) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.surface2)
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: iconFor(bp.category))
                        .font(.system(size: 16))
                        .foregroundStyle(theme.plum)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(bp.merchant)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Text("\(bp.date.formatted(.dateTime.month(.abbreviated).day())) · \(bp.platform)")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(AppFormatter.formatCurrency(bp.amountUSD))
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.text)
                Text(AppFormatter.formatBtc(bp.btcSpent) + " BTC")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .padding(14)
    }

    private func iconFor(_ category: String) -> String {
        switch category.lowercased() {
        case let c where c.contains("mortgage") || c.contains("housing"): return "house.fill"
        case let c where c.contains("insurance"): return "shield.fill"
        case let c where c.contains("credit"): return "creditcard.fill"
        case let c where c.contains("auto") || c.contains("car"): return "car.fill"
        case let c where c.contains("util"): return "bolt.fill"
        default: return "banknote.fill"
        }
    }
}
