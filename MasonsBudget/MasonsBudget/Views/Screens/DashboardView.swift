import SwiftData
import SwiftUI

struct DashboardView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var categories: [BudgetCategory]
    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query(sort: \NetWorthSnapshot.date) private var netWorthSnapshots: [NetWorthSnapshot]

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private func percent(_ numerator: Decimal, of denominator: Decimal) -> Int {
        guard denominator > 0 else { return 0 }
        let value = NSDecimalNumber(decimal: (numerator / denominator) * Decimal(100)).doubleValue
        return Int(value.rounded())
    }

    private var myCategories: [BudgetCategory] {
        categories.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var canonicalBTC: CanonicalBTCBalance? {
        canonicalFinancials.btcBalance.value
    }

    private var myRetirementAccounts: [HoldingAccount] {
        holdingAccounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var totalBtc: Decimal {
        guard let canonicalBTC else { return 0 }
        return decimalMinorUnits(canonicalBTC.totalSats, scale: 8)
    }

    private var vooPrice: Decimal? {
        StockPriceService.vooPrice
    }

    private var ibitPrice: Decimal? {
        StockPriceService.ibitPrice
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

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        return allTodos.filter { todo in
            !todo.isDone &&
                activeMember.canSee(dataOwnedBy: todo.ownerMember) &&
                (todo.dueDate.map { cal.isDateInToday($0) } ?? false)
        }
    }

    private var recentTransactions: [Transaction] {
        allTransactions
            .filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
            .prefix(4)
            .map(\.self)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if canonicalBTC != nil {
                    heroBalance
                    statRow
                } else {
                    RequiredFinancialSourceView(
                        title: "Net Worth",
                        message: "The required Bitcoin balance document is empty or unavailable.",
                    )
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)
                }
                incomingSection
                    .padding(.bottom, AppLayout.cardSpacing)
                incomeCard
                spendingCard
                todaySection
                recentSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Hero Balance

    private var incomingSection: some View {
        IncomingEventsSection(
            activeMember: activeMember,
            unit: unit,
            holdingAccounts: holdingAccounts,
            btcPrice: btcPrice,
        )
    }

    private var heroBalance: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("NET WORTH")
                .font(AppFont.sectionHeaderMedium)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.accent)

            AmountView(sats: totalSats, unit: unit, size: 42, weight: .bold, btcPrice: btcPrice)

            HStack(spacing: 8) {
                let isPositive = !change30dFormatted.hasPrefix("-")
                HStack(spacing: 4) {
                    Image(systemName: isPositive ? AppIcon.arrowUp : "arrow.down.right")
                        .font(AppFont.labelSmall)
                        .foregroundStyle(isPositive ? theme.success : theme.danger)
                    Text("\(isPositive ? "+" : "")\(change30dFormatted)%")
                        .font(AppFont.labelLarge)
                        .foregroundStyle(isPositive ? theme.success : theme.danger)
                }
                Text("past 30 days")
                    .font(AppFont.labelLarge)
                    .foregroundStyle(theme.textMuted)

                Spacer()

                athPill
            }

            sparklineChart
                .padding(.top, 10)
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.vertical, 8)
    }

    private var athPill: some View {
        let athValue = mySnapshots.map(\.totalValue).max() ?? totalBtc * btcPrice
        let currentValue = totalBtc * btcPrice + totalRetirementUsd
        let drawdown: Decimal = athValue > 0 ? ((athValue - currentValue) / athValue) * 100 : 0
        let athSats: Decimal = btcPrice > 0 ? (athValue / btcPrice) * 100_000_000 : 0
        return HStack(spacing: 5) {
            Text("ATH")
                .font(AppFont.monoMicroStrong)
            AmountView(sats: athSats, unit: unit, size: 11, weight: .bold, accent: true, btcPrice: btcPrice)
            if drawdown > 1 {
                Text("· -\(NSDecimalNumber(decimal: drawdown).doubleValue, specifier: "%.1f")%")
                    .font(AppFont.sectionHeaderMedium)
                    .opacity(0.7)
            }
        }
        .foregroundStyle(theme.accent)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(theme.accentSoft)
        .clipShape(Capsule())
    }

    private var mySnapshots: [NetWorthSnapshot] {
        netWorthSnapshots.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var change30dFormatted: String {
        guard let latest = mySnapshots.last else { return "0.0" }
        let cutoff = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        let baseline = mySnapshots.last(where: { $0.date <= cutoff }) ?? mySnapshots.first
        guard let base = baseline, base.totalValue > 0, base.date != latest.date else { return "0.0" }
        let pctChange = ((latest.totalValue - base.totalValue) / base.totalValue) * 100
        let value = NSDecimalNumber(decimal: pctChange).doubleValue
        return String(format: "%.1f", value)
    }

    private var sparklineData: [CGFloat] {
        let recent = mySnapshots.suffix(30)
        let currentVal = CGFloat(NSDecimalNumber(decimal: totalBtc * btcPrice + totalRetirementUsd).doubleValue)
        guard !recent.isEmpty else { return [currentVal, currentVal] }
        var points = recent.map { CGFloat(NSDecimalNumber(decimal: $0.totalValue).doubleValue) }
        if points.count < 3 { points.append(currentVal) }
        return points
    }

    private var sparklineChart: some View {
        let data = sparklineData
        let maxVal = data.max() ?? 1
        let minVal = data.min() ?? 0
        let range = maxVal - minVal

        return Canvas { context, size in
            guard range > 0, data.count > 1 else { return }
            let w = size.width
            let h = size.height

            var path = Path()
            var fillPath = Path()

            for (i, val) in data.enumerated() {
                let x = w * CGFloat(i) / CGFloat(data.count - 1)
                let y = h - ((val - minVal) / range) * h * 0.8 - h * 0.1
                if i == 0 {
                    path.move(to: CGPoint(x: x, y: y))
                    fillPath.move(to: CGPoint(x: x, y: y))
                } else {
                    path.addLine(to: CGPoint(x: x, y: y))
                    fillPath.addLine(to: CGPoint(x: x, y: y))
                }
            }

            fillPath.addLine(to: CGPoint(x: w, y: h))
            fillPath.addLine(to: CGPoint(x: 0, y: h))
            fillPath.closeSubpath()

            context.fill(fillPath, with: .linearGradient(
                Gradient(colors: [theme.accent.opacity(0.3), theme.accent.opacity(0)]),
                startPoint: .zero,
                endPoint: CGPoint(x: 0, y: h),
            ))
            context.stroke(path, with: .color(theme.accent), lineWidth: 1.6)

            if let lastVal = data.last {
                let lastX = w
                let lastY = h - ((lastVal - minVal) / range) * h * 0.8 - h * 0.1
                context.fill(Circle().path(in: CGRect(x: lastX - 3, y: lastY - 3, width: 6, height: 6)), with: .color(theme.accent))
            }
        }
        .frame(height: 56)
    }

    // MARK: - Stat Row

    private var statRow: some View {
        HStack(spacing: AppLayout.gridSpacing) {
            statCard(
                title: "Cold Storage",
                icon: AppIcon.vault,
                iconColor: theme.plum,
                iconBg: theme.plumSoft,
                btc: coldBtc,
                subtitle: coldPct + " of stack · " + coldLabel,
            )
            statCard(
                title: "Spending Wallet",
                icon: AppIcon.bolt,
                iconColor: theme.info,
                iconBg: theme.infoSoft,
                btc: hotBtc,
                subtitle: hotLabel,
            )
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private var coldPct: String {
        guard totalBtc > 0 else { return "0%" }
        return "\(percent(coldBtc, of: totalBtc))%"
    }

    private var coldLabel: String {
        let labels = canonicalBTC?.accounts.filter { $0.custody == .selfCustody }.map(\.label) ?? []
        return labels.first ?? "self-custody"
    }

    private var hotLabel: String {
        let labels = canonicalBTC?.accounts.filter { $0.custody == .exchange }.map(\.label) ?? []
        return labels.isEmpty ? "Lightning" : labels.prefix(2).joined(separator: " · ")
    }

    private func statCard(title: String, icon: String, iconColor: Color, iconBg: Color, btc: Decimal, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(iconBg)
                    .frame(width: 18, height: 18)
                    .overlay(
                        Image(systemName: icon)
                            .font(AppFont.small)
                            .foregroundStyle(iconColor),
                    )
                Text(title.uppercased())
                    .font(AppFont.sectionHeader)
                    .tracking(AppFont.sectionTracking)
                    .foregroundStyle(iconColor)
            }

            AmountView(sats: btc * 100_000_000, unit: unit, size: 20, weight: .bold, btcPrice: btcPrice)

            Text(subtitle)
                .font(AppFont.smallRegular)
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
    }

    // MARK: - Income & Savings Card

    private var ytdSpending: Decimal {
        let cal = Calendar.current
        let now = Date()
        let startOfYear = cal.date(from: cal.dateComponents([.year], from: now)) ?? now
        return allTransactions
            .filter { tx in
                activeMember.sharesNetWorth(with: tx.ownerMember) &&
                    tx.isSpend &&
                    tx.date >= startOfYear
            }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    @ViewBuilder
    private var incomeCard: some View {
        let now = Date()
        let calendar = Calendar.current
        let monthKey = canonicalMonthKey(for: now)
        let year = calendar.component(.year, from: now)
        if let summary = canonicalFinancials.income.value,
           let mtdCents = summary.cents(forMonth: monthKey),
           let ytdCents = summary.cents(forYear: year)
        {
            let mtdIncome = decimalMinorUnits(mtdCents, scale: 2)
            let ytdIncome = decimalMinorUnits(ytdCents, scale: 2)
            let mtdSpend = monthlySpending
            let ytdSpend = ytdSpending
            let mtdSaved = mtdIncome - mtdSpend
            let ytdSaved = ytdIncome - ytdSpend
            let mtdRate = percent(mtdSaved, of: mtdIncome)
            let ytdRate = percent(ytdSaved, of: ytdIncome)

            HStack(spacing: 0) {
                incomeCell(label: "INCOME MTD", amount: mtdIncome, saved: mtdSaved, rate: mtdRate)
                Rectangle()
                    .fill(theme.border)
                    .frame(width: 1)
                    .padding(.vertical, 12)
                incomeCell(label: "INCOME YTD", amount: ytdIncome, saved: ytdSaved, rate: ytdRate)
            }
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusLarge, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AppLayout.radiusLarge, style: .continuous).stroke(theme.border, lineWidth: 1))
            .padding(.horizontal, AppLayout.sectionPadding)
            .padding(.bottom, AppLayout.cardSpacing)
        } else {
            RequiredFinancialSourceView(
                title: "Income",
                message: "The required income ledger is empty or unavailable.",
            )
            .padding(.horizontal, AppLayout.sectionPadding)
            .padding(.bottom, AppLayout.cardSpacing)
        }
    }

    private func incomeCell(label: String, amount: Decimal, saved: Decimal, rate: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(AppFont.microStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)

            Text(AppFormatter.formatCurrency(amount))
                .font(AppFont.titleNumberMono)
                .foregroundStyle(theme.text)

            HStack(spacing: 6) {
                Text("\(rate)%")
                    .font(AppFont.monoSmallStrong)
                    .foregroundStyle(rate >= 30 ? theme.accent : theme.textMuted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(rate >= 30 ? theme.accentSoft2 : theme.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("saved \(AppFormatter.formatCurrency(saved))")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }

    private func canonicalMonthKey(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter.string(from: date)
    }

    // MARK: - Monthly Spending Card

    private var monthlySpending: Decimal {
        let cal = Calendar.current
        let now = Date()
        return allTransactions
            .filter { tx in
                activeMember.sharesNetWorth(with: tx.ownerMember) &&
                    tx.isSpend &&
                    cal.isDate(tx.date, equalTo: now, toGranularity: .month)
            }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private var spendingCard: some View {
        let spent = monthlySpending
        let limit = myCategories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
        let pct = percent(spent, of: limit)

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(monthName + " SPENDING")
                        .font(AppFont.sectionHeaderMedium)
                        .tracking(AppFont.sectionTracking)
                        .foregroundStyle(theme.textMuted)
                    Text("\(pct)% of monthly limit")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                }
                Spacer()
                Text(AppFormatter.formatCurrency(spent))
                    .font(AppFont.mediumNumberMono)
                    .foregroundStyle(theme.text)
            }

            spendingBar(spent: spent, limit: limit)

            categoryLegend
        }
        .glassCard()
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private var monthName: String {
        let df = DateFormatter()
        df.dateFormat = "MMM"
        return df.string(from: Date()).uppercased()
    }

    private func spendingBar(spent _: Decimal, limit: Decimal) -> some View {
        let categoryColors: [Color] = [theme.accent, theme.plum, theme.info, theme.success, theme.warn]
        let totalLimit = limit > 0 ? limit : 1
        return GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(Array(myCategories.prefix(5).enumerated()), id: \.offset) { idx, cat in
                    let fraction = cat.monthlyBudget / totalLimit
                    Rectangle()
                        .fill(categoryColors[idx % categoryColors.count].opacity(0.85))
                        .frame(width: geo.size.width * CGFloat(NSDecimalNumber(decimal: fraction).doubleValue))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .background(
                RoundedRectangle(cornerRadius: 6).fill(theme.surface2),
            )
        }
        .frame(height: 10)
    }

    private var categoryLegend: some View {
        let categoryColors: [Color] = [theme.accent, theme.plum, theme.info, theme.success, theme.warn]
        let cats = Array(myCategories.prefix(4))
        return HStack(spacing: 12) {
            ForEach(Array(cats.enumerated()), id: \.offset) { idx, cat in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(categoryColors[idx % categoryColors.count])
                        .frame(width: 7, height: 7)
                    Text(cat.name)
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.textMuted)
                }
            }
            if myCategories.count > 4 {
                Text("+\(myCategories.count - 4) more")
                    .font(AppFont.labelSmallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
    }

    // MARK: - Today Todos Preview

    private var todaySection: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Today")
                    .font(AppFont.labelStrong)
                    .foregroundStyle(theme.text)
                Spacer()
                Text("\(todayTodos.count) tasks")
                    .font(AppFont.labelSmall)
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                if todayTodos.isEmpty {
                    Text("No tasks due today")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    ForEach(Array(todayTodos.prefix(4).enumerated()), id: \.element.id) { idx, todo in
                        TaskRowView(todo: todo)
                        if idx < min(todayTodos.count, 4) - 1 {
                            Hairline(indent: 46)
                        }
                    }
                }
            }
            .glassCard(padding: 0)
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    // MARK: - Recent Activity

    private var recentSection: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Recent activity")
                    .font(AppFont.labelStrong)
                    .foregroundStyle(theme.text)
                Spacer()
                NavigationLink {
                    ActivityView()
                } label: {
                    Text("See all")
                        .font(AppFont.labelSmall)
                        .foregroundStyle(theme.accent)
                }
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                if recentTransactions.isEmpty {
                    Text("No transactions yet")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    ForEach(Array(recentTransactions.enumerated()), id: \.element.id) { idx, tx in
                        transactionRow(tx: tx)
                        if idx < recentTransactions.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
            }
            .glassCard(padding: 0)
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private func transactionRow(tx: Transaction) -> some View {
        let isIncome = tx.isIncome
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(isIncome ? theme.accentSoft2 : theme.surface2)
                .frame(width: 34, height: 34)
                .overlay(
                    Group {
                        if isIncome {
                            BtcGlyphView(size: 18, color: theme.accent)
                        } else {
                            CatGlyphView(kind: glyphForCategory(tx.category), size: 16, color: colorForCategory(tx.category))
                        }
                    },
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(tx.merchant)
                    .font(AppFont.labelLarge)
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Image(systemName: tx.card == "lightning" ? "bolt.fill" : "link")
                        .font(AppFont.micro)
                        .foregroundStyle(theme.textMuted)
                    Text(relativeDateString(tx.date))
                        .font(AppFont.smallRegular)
                        .foregroundStyle(theme.textMuted)
                }
            }

            Spacer()

            AmountView(
                sats: tx.displaySatsValue(btcPrice: btcPrice),
                unit: unit,
                size: 14,
                weight: .semibold,
                showSign: true,
                accent: isIncome,
                btcPrice: btcPrice,
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: - Helpers

    private func glyphForCategory(_ category: String) -> String {
        let map: [String: String] = [
            "Housing": "home", "Groceries": "fork", "Dining": "fork",
            "Transport": "plane", "Health": "heart", "Utilities": "bolt",
            "Shopping": "gift", "Entertainment": "bolt", "Bitcoin": "vault",
        ]
        return map[category] ?? "wrench"
    }

    private func colorForCategory(_ category: String) -> Color {
        let map: [String: Color] = [
            "Housing": theme.plum, "Groceries": theme.success,
            "Dining": theme.warn, "Transport": theme.info,
            "Health": theme.danger, "Bitcoin": theme.accent,
        ]
        return map[category] ?? theme.textMuted
    }

    private func relativeDateString(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: date, to: Date()).day ?? 0
        if days < 7 { return "\(days)d ago" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }
}
