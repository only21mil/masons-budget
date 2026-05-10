import SwiftUI
import SwiftData

struct NetWorthView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var accounts: [BTCAccount]
    @Query(sort: \NetWorthSnapshot.date, order: .reverse) private var snapshots: [NetWorthSnapshot]

    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var visibleAccounts: [BTCAccount] {
        accounts.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var totalBtc: Decimal { visibleAccounts.reduce(Decimal(0)) { $0 + $1.btc } }
    private var totalSats: Decimal { totalBtc * 100_000_000 }

    private var coldBtc: Decimal {
        visibleAccounts.filter { $0.custody == .selfCustody }.reduce(Decimal(0)) { $0 + $1.btc }
    }
    private var hotBtc: Decimal { totalBtc - coldBtc }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Net Worth", eyebrow: "12-month view")

                totalCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                holdingsSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Total Card with Bar Chart

    private var totalCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Total")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.textMuted)

            AmountView(sats: totalSats, unit: unit, size: 32, weight: .bold, btcPrice: btcPrice)

            HStack(spacing: 8) {
                Image(systemName: AppIcon.arrowUp)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.success)
                Text("+0.81 BTC")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.success)
                Text("past year")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(theme.textFaint)
            }
            .padding(.top, 2)

            barChart
                .padding(.top, 18)

            monthLabels
                .padding(.top, 4)
        }
        .glassCard(padding: 18, radius: 22)
    }

    private var barChart: some View {
        let data: [CGFloat] = [3.4, 3.5, 3.5, 3.6, 3.7, 3.8, 3.85, 3.9, 4.0, 4.1, 4.15, 4.22]
        let maxVal = data.max() ?? 1
        let minVal = (data.min() ?? 0) * 0.92

        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(data.enumerated()), id: \.offset) { idx, val in
                let isLast = idx == data.count - 1
                let height = maxVal > minVal ? (val - minVal) / (maxVal - minVal) : 0.5

                RoundedRectangle(cornerRadius: 3)
                    .fill(isLast ? theme.accent : theme.accentSoft2)
                    .frame(height: max(6, 80 * height))
                    .overlay(alignment: .top) {
                        if isLast {
                            Text(String(format: "%.2f", val))
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(theme.accent)
                                .offset(y: -18)
                        }
                    }
            }
        }
        .frame(height: 80)
    }

    private var monthLabels: some View {
        let labels = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"]
        return HStack(spacing: 4) {
            ForEach(Array(labels.enumerated()), id: \.offset) { idx, label in
                Text(idx % 2 == 1 ? label : "")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.textFaint)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Holdings

    private var holdingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HOLDINGS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                NavigationLink {
                    BTCAccountDetailView(title: "Cold Storage", custody: .selfCustody)
                } label: {
                    holdingRow(title: "Cold Storage", subtitle: "Coldcard Q · Multisig", btc: coldBtc, opacity: 1.0)
                }
                .buttonStyle(.plain)
                Hairline(indent: 32)
                NavigationLink {
                    BTCAccountDetailView(title: "Spending Wallets", custody: .exchange)
                } label: {
                    holdingRow(title: "Lightning", subtitle: "Phoenix · Self-custody", btc: hotBtc, opacity: 0.5)
                }
                .buttonStyle(.plain)
            }
            .glassCard(padding: 0, radius: 18)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func holdingRow(title: String, subtitle: String, btc: Decimal, opacity: Double) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(theme.accent.opacity(opacity))
                .frame(width: 6, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            AmountView(sats: btc * 100_000_000, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
        }
        .padding(14)
    }
}
