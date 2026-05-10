import SwiftUI
import SwiftData

struct NetWorthView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var accounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query(sort: \NetWorthSnapshot.date, order: .reverse) private var snapshots: [NetWorthSnapshot]

    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var myAccounts: [BTCAccount] {
        accounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var myRetirementAccounts: [HoldingAccount] {
        holdingAccounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var vooPrice: Decimal? { StockPriceService.vooPrice }
    private var ibitPrice: Decimal? { StockPriceService.ibitPrice }

    private var totalBtc: Decimal { myAccounts.reduce(Decimal(0)) { $0 + $1.btc } }
    private var totalRetirementUsd: Decimal {
        myRetirementAccounts.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
    }
    private var totalRetirementSats: Decimal {
        guard btcPrice > 0 else { return 0 }
        return (totalRetirementUsd / btcPrice) * 100_000_000
    }
    private var totalSats: Decimal { (totalBtc * 100_000_000) + totalRetirementSats }

    private var coldBtc: Decimal {
        myAccounts.filter { $0.custody == .selfCustody }.reduce(Decimal(0)) { $0 + $1.btc }
    }
    private var hotBtc: Decimal { totalBtc - coldBtc }

    private var coldSubtitle: String {
        let labels = myAccounts.filter { $0.custody == .selfCustody }.map(\.label)
        return labels.isEmpty ? "Self-custody" : labels.prefix(2).joined(separator: " · ")
    }

    private var hotSubtitle: String {
        let labels = myAccounts.filter { $0.custody == .exchange }.map(\.label)
        return labels.isEmpty ? "Exchange" : labels.prefix(2).joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Net Worth", eyebrow: "12-month view")

                totalCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                holdingsSection

                if !myRetirementAccounts.isEmpty {
                    retirementSection
                        .padding(.top, AppLayout.cardSpacing)
                }
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
                let change = yearlyBtcChange
                let positive = change >= 0
                Image(systemName: positive ? AppIcon.arrowUp : "arrow.down.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(positive ? theme.success : theme.danger)
                Text("\(positive ? "+" : "")\(AppFormatter.formatBtc(change)) BTC")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(positive ? theme.success : theme.danger)
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

    private var monthlyBtcValues: [CGFloat] {
        let mySnaps = snapshots.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
        let cal = Calendar.current
        let now = Date()
        var values: [CGFloat] = []
        for offset in stride(from: -11, through: 0, by: 1) {
            guard let monthDate = cal.date(byAdding: .month, value: offset, to: now) else { continue }
            let snap = mySnaps.first(where: { cal.isDate($0.date, equalTo: monthDate, toGranularity: .month) })
            if let s = snap {
                values.append(CGFloat(NSDecimalNumber(decimal: s.btcValue / btcPrice).doubleValue))
            } else if offset == 0 {
                values.append(CGFloat(NSDecimalNumber(decimal: totalBtc).doubleValue))
            } else {
                values.append(values.last ?? 0)
            }
        }
        return values.isEmpty ? [CGFloat(NSDecimalNumber(decimal: totalBtc).doubleValue)] : values
    }

    private var yearlyBtcChange: Decimal {
        let values = monthlyBtcValues
        guard let first = values.first, first > 0, let last = values.last else { return 0 }
        return Decimal(Double(last - first))
    }

    private var barChart: some View {
        let data = monthlyBtcValues
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
        let cal = Calendar.current
        let now = Date()
        let df = DateFormatter()
        df.dateFormat = "MMM"
        let labels: [String] = (0..<12).map { offset in
            let d = cal.date(byAdding: .month, value: offset - 11, to: now) ?? now
            return df.string(from: d)
        }
        return HStack(spacing: 4) {
            ForEach(Array(labels.enumerated()), id: \.offset) { idx, label in
                Text(idx % 2 == 1 ? label : "")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.textFaint)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - BTC Holdings

    private var holdingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("BITCOIN")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                NavigationLink {
                    BTCAccountDetailView(title: "Cold Storage", custody: .selfCustody)
                } label: {
                    holdingRow(title: "Cold Storage", subtitle: coldSubtitle, btc: coldBtc, opacity: 1.0)
                }
                .buttonStyle(.plain)
                Hairline(indent: 32)
                NavigationLink {
                    BTCAccountDetailView(title: "Spending Wallets", custody: .exchange)
                } label: {
                    holdingRow(title: "Spending", subtitle: hotSubtitle, btc: hotBtc, opacity: 0.5)
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

    // MARK: - Retirement

    private var retirementSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("RETIREMENT")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(myRetirementAccounts.enumerated()), id: \.element.name) { idx, acct in
                    retirementRow(account: acct)
                    if idx < myRetirementAccounts.count - 1 {
                        Hairline(indent: 32)
                    }
                }
            }
            .glassCard(padding: 0, radius: 18)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func retirementRow(account: HoldingAccount) -> some View {
        let value = account.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice)
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(theme.plum.opacity(0.8))
                .frame(width: 6, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(account.name.uppercased())
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                Text(account.provider)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            Text(AppFormatter.formatCurrency(value))
                .font(.system(size: 14, weight: .bold, design: .monospaced))
                .foregroundStyle(theme.text)
        }
        .padding(14)
    }
}
