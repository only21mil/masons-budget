import SwiftUI
import SwiftData

struct DashboardView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var accounts: [BTCAccount]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query private var categories: [BudgetCategory]
    @Query(sort: \TodoItem.dueDate) private var allTodos: [TodoItem]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private func percent(_ numerator: Decimal, of denominator: Decimal) -> Int {
        guard denominator > 0 else { return 0 }
        let value = NSDecimalNumber(decimal: (numerator / denominator) * Decimal(100)).doubleValue
        return Int(value.rounded())
    }

    private var visibleAccounts: [BTCAccount] {
        accounts.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var totalBtc: Decimal { visibleAccounts.reduce(Decimal(0)) { $0 + $1.btc } }
    private var totalSats: Decimal { totalBtc * 100_000_000 }

    private var coldBtc: Decimal {
        visibleAccounts.filter { $0.custody == .selfCustody }.reduce(Decimal(0)) { $0 + $1.btc }
    }
    private var hotBtc: Decimal { totalBtc - coldBtc }

    private var todayTodos: [TodoItem] {
        let cal = Calendar.current
        return allTodos.filter { todo in
            activeMember.canSee(dataOwnedBy: todo.ownerMember) &&
            (todo.dueDate.map { cal.isDateInToday($0) } ?? false)
        }
    }

    private var recentTransactions: [Transaction] {
        allTransactions
            .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
            .prefix(4)
            .map { $0 }
    }

    private var currentSnapshot: MonthlyBudgetSnapshot? {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        let key = df.string(from: Date())
        return snapshots.first(where: { $0.monthKey == key })
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                heroBalance
                statRow
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

    private var heroBalance: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("NET WORTH · 100% BITCOIN")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.88)
                .foregroundStyle(theme.accent)

            AmountView(sats: totalSats, unit: unit, size: 42, weight: .bold, btcPrice: btcPrice)

            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: AppIcon.arrowUp)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.success)
                    Text("+\(change30dFormatted)%")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.success)
                }
                Text("past 30 days")
                    .font(.system(size: 14))
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
        let athBtc = totalBtc
        let drawdown = athBtc > 0 ? Decimal(0) : Decimal(0)
        return HStack(spacing: 5) {
            Text("ATH")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
            Text(AppFormatter.formatBtc(athBtc))
                .font(.system(size: 11, weight: .bold, design: .monospaced))
            if drawdown > 0 {
                Text("· -\(NSDecimalNumber(decimal: drawdown).doubleValue, specifier: "%.1f")%")
                    .font(.system(size: 11, weight: .semibold))
                    .opacity(0.7)
            }
        }
        .foregroundStyle(theme.accent)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(theme.accentSoft)
        .clipShape(Capsule())
    }

    private var change30dFormatted: String {
        "3.2"
    }

    private var sparklineChart: some View {
        let data: [CGFloat] = [82, 78, 91, 88, 95, 102, 98, 110, 108, 115, 112, 118]
        let maxVal = data.max() ?? 1
        let minVal = data.min() ?? 0
        let range = maxVal - minVal

        return Canvas { context, size in
            guard range > 0 else { return }
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
                endPoint: CGPoint(x: 0, y: h)
            ))
            context.stroke(path, with: .color(theme.accent), lineWidth: 1.6)

            let lastX = w
            let lastY = h - ((data.last! - minVal) / range) * h * 0.8 - h * 0.1
            context.fill(Circle().path(in: CGRect(x: lastX - 3, y: lastY - 3, width: 6, height: 6)), with: .color(theme.accent))
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
                subtitle: coldPct + " of stack · multisig"
            )
            statCard(
                title: "Spending Wallet",
                icon: AppIcon.bolt,
                iconColor: theme.info,
                iconBg: theme.infoSoft,
                btc: hotBtc,
                subtitle: "Lightning · daily"
            )
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private var coldPct: String {
        guard totalBtc > 0 else { return "0%" }
        return "\(percent(coldBtc, of: totalBtc))%"
    }

    private func statCard(title: String, icon: String, iconColor: Color, iconBg: Color, btc: Decimal, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(iconBg)
                    .frame(width: 18, height: 18)
                    .overlay(
                        Image(systemName: icon)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(iconColor)
                    )
                Text(title.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.44)
                    .foregroundStyle(iconColor)
            }

            AmountView(sats: btc * 100_000_000, unit: unit, size: 20, weight: .bold, btcPrice: btcPrice)

            Text(subtitle)
                .font(.system(size: 11))
                .foregroundStyle(theme.textFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
    }

    // MARK: - Income & Savings Card

    private var incomeCard: some View {
        let mtdIncome = currentSnapshot?.mtdIncome ?? 0
        let ytdIncome = currentSnapshot?.ytdIncome ?? 0
        let mtdSpend = monthlySpending
        let ytdSpend = ytdIncome * Decimal(0.65)
        let mtdSaved = mtdIncome - mtdSpend
        let ytdSaved = ytdIncome - ytdSpend
        let mtdRate = percent(mtdIncome - mtdSpend, of: mtdIncome)
        let ytdRate = percent(ytdIncome - ytdSpend, of: ytdIncome)

        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                incomeCell(label: "INCOME MTD", amount: mtdIncome, saved: mtdSaved, rate: mtdRate)
                Rectangle()
                    .fill(theme.border)
                    .frame(width: 1)
                    .padding(.vertical, 12)
                incomeCell(label: "INCOME YTD", amount: ytdIncome, saved: ytdSaved, rate: ytdRate)
            }

            Hairline(indent: 0)

            incomeChart
                .padding(14)
        }
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusLarge, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AppLayout.radiusLarge, style: .continuous).stroke(theme.border, lineWidth: 1))
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private func incomeCell(label: String, amount: Decimal, saved: Decimal, rate: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(theme.textMuted)

            Text(AppFormatter.formatCurrency(amount))
                .font(.system(size: 22, weight: .bold, design: .monospaced))
                .tracking(-0.44)
                .foregroundStyle(theme.text)

            HStack(spacing: 6) {
                Text("\(rate)%")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(rate >= 30 ? theme.accent : theme.textMuted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(rate >= 30 ? theme.accentSoft2 : theme.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("saved \(AppFormatter.formatCurrency(saved))")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }

    private var incomeChart: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("INCOME · SPEND · SAVINGS %")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                HStack(spacing: 10) {
                    legendDot(color: theme.accent, label: "Income")
                    legendDot(color: theme.borderStrong, label: "Spend")
                    HStack(spacing: 4) {
                        Rectangle().fill(theme.success).frame(width: 10, height: 2)
                        Text("Save %")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.textFaint)
                    }
                }
            }

            Canvas { context, size in
                let months = 6
                let barWidth = size.width / CGFloat(months) * 0.32
                let maxAmt: CGFloat = 8000

                for i in 0..<months {
                    let slot = size.width / CGFloat(months)
                    let cx = CGFloat(i) * slot + slot / 2
                    let incH = CGFloat(5000 + i * 300) / maxAmt * size.height * 0.86
                    let spdH = CGFloat(3500 + i * 200) / maxAmt * size.height * 0.86

                    let incRect = CGRect(x: cx - barWidth - 0.4, y: size.height - incH, width: barWidth, height: incH)
                    let spdRect = CGRect(x: cx + 0.4, y: size.height - spdH, width: barWidth, height: spdH)

                    context.fill(RoundedRectangle(cornerRadius: 1).path(in: incRect), with: .color(theme.accent.opacity(i == months - 1 ? 1 : 0.4)))
                    context.fill(RoundedRectangle(cornerRadius: 1).path(in: spdRect), with: .color(theme.borderStrong))
                }
            }
            .frame(height: 64)
        }
    }

    private func legendDot(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(theme.textFaint)
        }
    }

    // MARK: - Monthly Spending Card

    private var monthlySpending: Decimal {
        let cal = Calendar.current
        let now = Date()
        return allTransactions
            .filter { tx in
                activeMember.canSee(dataOwnedBy: tx.ownerMember) &&
                tx.isSpend &&
                cal.isDate(tx.date, equalTo: now, toGranularity: .month)
            }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private var monthlySpendingSats: Decimal {
        let cal = Calendar.current
        let now = Date()
        return allTransactions
            .filter { tx in
                activeMember.canSee(dataOwnedBy: tx.ownerMember) &&
                tx.isSpend &&
                cal.isDate(tx.date, equalTo: now, toGranularity: .month)
            }
            .reduce(Decimal(0)) { $0 + $1.spendSatsValue(btcPrice: btcPrice) }
    }

    private var spendingCard: some View {
        let spent = monthlySpending
        let spentSats = monthlySpendingSats
        let limit = categories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
        let pct = percent(spent, of: limit)

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(monthName + " SPENDING")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.44)
                        .foregroundStyle(theme.textMuted)
                    Text("\(pct)% of monthly limit")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.textFaint)
                }
                Spacer()
                AmountView(sats: spentSats, unit: unit, size: 18, weight: .bold, btcPrice: btcPrice)
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

    private func spendingBar(spent: Decimal, limit: Decimal) -> some View {
        let categoryColors: [Color] = [theme.accent, theme.plum, theme.info, theme.success, theme.warn]
        let totalLimit = limit > 0 ? limit : 1
        return GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(Array(categories.prefix(5).enumerated()), id: \.offset) { idx, cat in
                    let fraction = cat.monthlyBudget / totalLimit
                    Rectangle()
                        .fill(categoryColors[idx % categoryColors.count].opacity(0.85))
                        .frame(width: geo.size.width * CGFloat(NSDecimalNumber(decimal: fraction).doubleValue))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .background(
                RoundedRectangle(cornerRadius: 6).fill(theme.surface2)
            )
        }
        .frame(height: 10)
    }

    private var categoryLegend: some View {
        let categoryColors: [Color] = [theme.accent, theme.plum, theme.info, theme.success, theme.warn]
        let cats = Array(categories.prefix(4))
        return HStack(spacing: 12) {
            ForEach(Array(cats.enumerated()), id: \.offset) { idx, cat in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(categoryColors[idx % categoryColors.count])
                        .frame(width: 7, height: 7)
                    Text(cat.name)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.textMuted)
                }
            }
            if categories.count > 4 {
                Text("+\(categories.count - 4) more")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textFaint)
            }
        }
    }

    // MARK: - Today Todos Preview

    private var todaySection: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Today")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(theme.text)
                Spacer()
                Text("\(todayTodos.filter { !$0.isDone }.count) tasks")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(todayTodos.prefix(4).enumerated()), id: \.element.id) { idx, todo in
                    todoRow(todo: todo)
                    if idx < min(todayTodos.count, 4) - 1 {
                        Hairline(indent: 46)
                    }
                }
            }
            .glassCard(padding: 0)
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private func todoRow(todo: TodoItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: todo.isDone ? AppIcon.checkDone : AppIcon.checkOpen)
                .font(.system(size: 20))
                .foregroundStyle(todo.isDone ? theme.accent : theme.borderStrong)

            Text(todo.title)
                .font(.system(size: 14))
                .foregroundStyle(todo.isDone ? theme.textFaint : theme.text)
                .strikethrough(todo.isDone)
                .lineLimit(1)

            Spacer()

            if todo.isFlagged {
                Image(systemName: AppIcon.flagFilled)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.accent)
            }

            if let project = todo.project {
                Text(project)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: - Recent Activity

    private var recentSection: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Recent activity")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(theme.text)
                Spacer()
                Text("See all")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(recentTransactions.enumerated()), id: \.element.id) { idx, tx in
                    transactionRow(tx: tx)
                    if idx < recentTransactions.count - 1 {
                        Hairline(indent: 58)
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
                    }
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(tx.merchant)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.textFaint)
                    Text(relativeDateString(tx.date))
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textFaint)
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
                btcPrice: btcPrice
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
