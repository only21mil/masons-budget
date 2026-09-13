import SwiftData
import SwiftUI

struct NetWorthView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage(MarketQuoteService.cacheKey) private var quoteCache = Data()
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var holdingAccounts: [HoldingAccount]
    @Query(sort: \NetWorthSnapshot.date, order: .reverse) private var snapshots: [NetWorthSnapshot]

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? 0
    }

    private var canonicalBTC: CanonicalBTCBalance? {
        guard let balance = canonicalFinancials.btcBalance.value,
              activeMember.sharesNetWorth(with: balance.owner) else { return nil }
        return balance
    }

    private var myRetirementAccounts: [HoldingAccount] {
        holdingAccounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var vooPrice: Decimal? {
        StockPriceService.vooPrice
    }

    private var ibitPrice: Decimal? {
        StockPriceService.ibitPrice
    }

    private var totalBtc: Decimal {
        guard let canonicalBTC else { return 0 }
        return decimalMinorUnits(canonicalBTC.totalSats, scale: 8)
    }

    private var totalRetirementUsd: Decimal {
        myRetirementAccounts.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
    }

    private var totalRetirementSats: Decimal {
        guard btcPrice > 0 else { return 0 }
        return (totalRetirementUsd / btcPrice) * 100_000_000
    }

    private var totalSats: Decimal {
        (totalBtc * 100_000_000) + totalRetirementSats
    }

    private var coldBtc: Decimal {
        guard let canonicalBTC else { return 0 }
        return decimalMinorUnits(canonicalBTC.selfCustodySats, scale: 8)
    }

    private var hotBtc: Decimal {
        totalBtc - coldBtc
    }

    private var totalBtcUsd: Decimal {
        totalBtc * btcPrice
    }

    private var coldSubtitle: String {
        let labels = canonicalBTC?.accounts.filter { $0.custody == .selfCustody }.map(\.label) ?? []
        return labels.isEmpty ? "Self-custody" : labels.prefix(2).joined(separator: " · ")
    }

    private var hotSubtitle: String {
        let labels = canonicalBTC?.accounts.filter { $0.custody == .exchange }.map(\.label) ?? []
        return labels.isEmpty ? "Exchange" : labels.prefix(2).joined(separator: " · ")
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            ScrollView {
                VStack(spacing: 0) {
                    ScreenHeader(title: "Net Worth", eyebrow: "Recorded history")

                    quoteStatus
                        .padding(.horizontal, AppLayout.sectionPadding)
                        .padding(.bottom, 12)

                    if canonicalBTC != nil, btcPrice > 0 {
                        totalCard
                            .padding(.horizontal, AppLayout.sectionPadding)
                            .padding(.bottom, AppLayout.cardSpacing)

                        timelineSection
                            .padding(.bottom, AppLayout.cardSpacing)

                        holdingsSection
                    } else {
                        RequiredFinancialSourceView(
                            title: "Net Worth",
                            message: "A Bitcoin balance and an available Bitcoin price are needed to calculate net worth.",
                        )
                        .padding(.horizontal, AppLayout.sectionPadding)
                    }

                    if !myRetirementAccounts.isEmpty, btcPrice > 0 {
                        retirementSection
                            .padding(.top, AppLayout.cardSpacing)
                    }
                }
                .padding(.bottom, 100)
            }
            .background(theme.bg)
        }
    }

    // MARK: - Total Card with Bar Chart

    private var totalCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Total")
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)

            AmountView(sats: totalSats, unit: unit, role: .heroNumeral, btcPrice: btcPrice)

            HStack(spacing: 8) {
                if let change = NetWorthHistory.change(timelineData) {
                    let positive = change >= 0
                    Image(systemName: positive ? AppIcon.arrowUp : "arrow.down.right")
                        .font(AppFont.icon(size: 11, weight: .semibold))
                        .foregroundStyle(positive ? theme.success : theme.danger)
                    Text("\(positive ? "+" : "")\(AppFormatter.formatCurrency(change))")
                        .ledgerType(.rowFigure)
                        .foregroundStyle(positive ? theme.success : theme.danger)
                }
                Text(NetWorthHistory.spanLabel(timelineData))
                    .ledgerType(.kpiSub)
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.top, 2)

            Text("Bitcoin value at each observation")
                .ledgerType(.rowMeta)
                .foregroundStyle(theme.textMuted)
                .padding(.top, 12)
            barChart
                .padding(.top, 18)

            monthLabels
                .padding(.top, 4)
        }
        .glassCard(padding: 18, radius: 22)
    }

    private var monthlyBtcStackUsd: [Decimal] { timelineData.map(\.btc) }

    private var monthlyBtcValues: [CGFloat] {
        monthlyBtcStackUsd.map { CGFloat(NSDecimalNumber(decimal: $0).doubleValue) }
    }

    private var quoteStatus: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(alignment: .leading, spacing: 3) {
                ForEach(MarketQuote.Symbol.allCases, id: \.rawValue) { symbol in
                    Text(MarketQuoteService.label(symbol, now: context.date))
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                }
                Text("Holdings use their last saved value when a stock price is unavailable.")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }
        }
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
                            Text(AppFormatter.formatCurrency(monthlyBtcStackUsd[idx]))
                                .ledgerType(.rowMeta)
                                .foregroundStyle(theme.accent)
                                .offset(y: -18)
                        }
                    }
            }
        }
        .frame(height: 80)
    }

    private var monthLabels: some View {
        let df = DateFormatter()
        df.dateFormat = "MMM"
        let labels = timelineData.map { df.string(from: $0.date) }
        return HStack(spacing: 4) {
            ForEach(Array(labels.enumerated()), id: \.offset) { idx, label in
                Text(labels.count < 7 || idx % 2 == 1 ? label : "")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Timeline Chart

    private var timelineData: [NetWorthHistoryPoint] {
        let captured = snapshots
            .filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
            .map { NetWorthHistoryPoint(date: $0.date, total: $0.totalValue, btc: $0.btcValue, holdings: $0.holdingsValue) }
        return NetWorthHistory.recentMonths(
            snapshots: captured,
            current: NetWorthHistoryPoint(date: Date(), total: totalBtcUsd + totalRetirementUsd,
                                          btc: totalBtcUsd, holdings: totalRetirementUsd),
        )
    }

    private var timelineMinimum: Decimal { timelineData.flatMap { [$0.total, $0.btc] }.min() ?? 0 }
    private var timelineMaximum: Decimal { timelineData.flatMap { [$0.total, $0.btc] }.max() ?? 0 }

    private var timelineSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TIMELINE")
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(alignment: .leading, spacing: 12) {
                Text(AppFormatter.formatCurrency(timelineMaximum))
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
                timelineChart
                    .frame(height: 160)
                    .accessibilityLabel("Net worth history")
                    .accessibilityValue("\(NetWorthHistory.spanLabel(timelineData)). \(timelineData.count) observed months. Minimum \(AppFormatter.formatCurrency(timelineMinimum)); maximum \(AppFormatter.formatCurrency(timelineMaximum)).")
                Text(AppFormatter.formatCurrency(timelineMinimum))
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
                timelineLegend
            }
            .glassCard()
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var timelineChart: some View {
        let data = timelineData
        return Canvas { context, size in
            guard !data.isEmpty else { return }
            let totals = data.map { NSDecimalNumber(decimal: $0.total).doubleValue }
            let btcVals = data.map { NSDecimalNumber(decimal: $0.btc).doubleValue }

            let maxVal = NSDecimalNumber(decimal: timelineMaximum).doubleValue
            let minVal = NSDecimalNumber(decimal: timelineMinimum).doubleValue
            let range = max(maxVal - minVal, 1)

            func pointFor(_ val: Double, at index: Int) -> CGPoint {
                let duration = data[data.count - 1].date.timeIntervalSince(data[0].date)
                let elapsed = data[index].date.timeIntervalSince(data[0].date)
                let x = duration > 0 ? size.width * CGFloat(elapsed / duration) : size.width / 2
                let y = size.height - ((CGFloat(val) - CGFloat(minVal)) / CGFloat(range)) * size.height * 0.85 - size.height * 0.075
                return CGPoint(x: x, y: y)
            }

            var btcPath = Path()
            var btcFill = Path()
            for (i, val) in btcVals.enumerated() {
                let pt = pointFor(val, at: i)
                if i == 0 { btcPath.move(to: pt); btcFill.move(to: pt) }
                else { btcPath.addLine(to: pt); btcFill.addLine(to: pt) }
            }
            btcFill.addLine(to: CGPoint(x: size.width, y: size.height))
            btcFill.addLine(to: CGPoint(x: 0, y: size.height))
            btcFill.closeSubpath()
            context.fill(btcFill, with: .color(theme.accent.opacity(0.15)))

            var totalPath = Path()
            for (i, val) in totals.enumerated() {
                let pt = pointFor(val, at: i)
                if i == 0 { totalPath.move(to: pt) }
                else { totalPath.addLine(to: pt) }
            }

            context.stroke(btcPath, with: .color(theme.accent.opacity(0.6)), lineWidth: 1.5)
            context.stroke(totalPath, with: .color(theme.accent), lineWidth: 2.5)

            let lastPt = pointFor(totals.last ?? 0, at: data.count - 1)
            context.fill(Path(ellipseIn: CGRect(x: lastPt.x - 4, y: lastPt.y - 4, width: 8, height: 8)), with: .color(theme.accent))
        }
    }

    private var timelineLegend: some View {
        HStack(spacing: 16) {
            legendItem(color: theme.accent, label: "Total")
            legendItem(color: theme.accent.opacity(0.5), label: "Bitcoin")
            Spacer()
            let data = timelineData
            if data.count >= 2, let first = data.first, let last = data.last, first.total > 0 {
                let change = last.total - first.total
                let pct = (change / first.total) * 100
                let positive = change >= 0
                Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: pct).intValue)% · \(NetWorthHistory.spanLabel(data))")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(positive ? theme.success : theme.danger)
            }
        }
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2)
                .fill(color)
                .frame(width: 12, height: 3)
            Text(label)
                .ledgerType(.rowMeta)
                .foregroundStyle(theme.textMuted)
        }
    }

    // MARK: - BTC Holdings

    private var holdingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("BITCOIN")
                .ledgerType(.sectionLabel)
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
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            AmountView(sats: btc * 100_000_000, unit: unit, role: .rowFigure, btcPrice: btcPrice)
        }
        .padding(14)
    }

    // MARK: - Retirement

    private var retirementSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("RETIREMENT")
                .ledgerType(.sectionLabel)
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
        let sats: Decimal = btcPrice > 0 ? (value / btcPrice) * 100_000_000 : 0
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(theme.plum.opacity(0.8))
                .frame(width: 6, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(account.name.uppercased())
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(account.provider)
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            AmountView(sats: sats, unit: unit, role: .rowFigure, btcPrice: btcPrice)
        }
        .padding(14)
    }
}
