import SwiftUI
import SwiftData

struct BudgetView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State private var selectedMonthOffset: Int = 0

    private var unit: DisplayUnit { .usd }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }

    private var myCategories: [BudgetCategory] {
        categories.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var selectedMonth: Date {
        Calendar.current.date(byAdding: .month, value: -selectedMonthOffset, to: Date()) ?? Date()
    }

    private var monthTransactions: [Transaction] {
        let cal = Calendar.current
        return allTransactions.filter { tx in
            activeMember.sharesNetWorth(with: tx.ownerMember) &&
            cal.isDate(tx.date, equalTo: selectedMonth, toGranularity: .month)
        }
    }

    private var monthSpent: Decimal {
        monthTransactions.reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private var monthLimit: Decimal {
        myCategories.reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var isCurrent: Bool { selectedMonthOffset == 0 }

    private func spentForOffset(_ offset: Int) -> Decimal {
        let cal = Calendar.current
        let date = cal.date(byAdding: .month, value: -offset, to: Date()) ?? Date()
        return allTransactions.filter { tx in
            activeMember.sharesNetWorth(with: tx.ownerMember) &&
            cal.isDate(tx.date, equalTo: date, toGranularity: .month) &&
            tx.isSpend
        }.reduce(Decimal(0)) { $0 + $1.spendAmount }
    }

    private func incomeForOffset(_ offset: Int) -> Decimal {
        let cal = Calendar.current
        let date = cal.date(byAdding: .month, value: -offset, to: Date()) ?? Date()
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        let baseKey = df.string(from: date)
        let key = activeMember.isAdult ? baseKey : "\(activeMember.rawValue):\(baseKey)"
        guard let snapshot = snapshots.first(where: { $0.monthKey == key }) else { return 0 }
        if snapshot.mtdIncome > 0 { return snapshot.mtdIncome }
        return max(snapshot.monthlyGross, 0)
    }

    private func savingsRateForOffset(_ offset: Int) -> Int? {
        let income = incomeForOffset(offset)
        guard income > 0 else { return nil }
        let spent = spentForOffset(offset)
        let saved = income - spent
        return max(0, Int(NSDecimalNumber(decimal: (saved / income) * 100).doubleValue))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(
                    title: "Budget",
                    eyebrow: monthEyebrow
                )

                monthStrip
                    .padding(.bottom, AppLayout.cardSpacing)

                spentCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                budgetVsActualSection
                    .padding(.bottom, AppLayout.cardSpacing)

                categoriesSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Month Eyebrow

    private var monthEyebrow: String {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        let base = df.string(from: selectedMonth)
        return isCurrent ? "\(base) · MTD" : base
    }

    // MARK: - Month Strip

    private var monthStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(0..<6, id: \.self) { offset in
                    monthChip(offset: offset)
                }
            }
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func monthChip(offset: Int) -> some View {
        let isSelected = offset == selectedMonthOffset
        let date = Calendar.current.date(byAdding: .month, value: -offset, to: Date()) ?? Date()
        let df = DateFormatter()
        df.dateFormat = "MMM"
        let label = df.string(from: date)
        let year = Calendar.current.component(.year, from: date)
        let rate = savingsRateForOffset(offset)

        return Button {
            selectedMonthOffset = offset
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(label) '\(String(year).suffix(2))\(offset == 0 ? " · now" : "")")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.6)
                    .textCase(.uppercase)
                    .opacity(isSelected ? 0.85 : 0.55)

                if let rate {
                    Text("\(rate)%")
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                } else {
                    Text("--")
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                }
            }
            .foregroundStyle(isSelected ? .white : theme.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minWidth: 64, alignment: .leading)
            .background(isSelected ? theme.accent : theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? theme.accent : theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Spent / Limit Card

    private var spentCard: some View {
        let limit = monthLimit
        let pct = limit > 0 ? min(1, NSDecimalNumber(decimal: monthSpent / limit).doubleValue) : 0

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(isCurrent ? "Spent / Limit" : "Spent / Income")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.textMuted)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(AppFormatter.formatCurrency(monthSpent))
                        .font(.system(size: 20, weight: .bold, design: .monospaced))
                        .tracking(-0.4)
                        .foregroundStyle(theme.text)
                    Text("/ \(AppFormatter.formatCurrency(limit))")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(theme.textFaint)
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(theme.surface2)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(theme.accent)
                        .frame(width: geo.size.width * pct)
                }
            }
            .frame(height: 8)

            HStack {
                Text("\(Int(pct * 100))% of income spent")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.textMuted)
                Spacer()
                let saved = limit - monthSpent
                Text("\(AppFormatter.formatCurrency(max(saved, 0))) saved")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.success)
            }
        }
        .glassCard()
    }

    // MARK: - Budget vs Actual

    private var budgetVsActualSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("BUDGET vs ACTUAL")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 6) {
                ForEach(myCategories.filter { $0.monthlyBudget > 0 }, id: \.name) { cat in
                    budgetVsActualRow(cat: cat)
                }
            }
            .glassCard(padding: 12, radius: 18)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func budgetVsActualRow(cat: BudgetCategory) -> some View {
        let spent = spentInCategory(cat.name)
        let budget = cat.monthlyBudget
        let maxVal = max(spent, budget)
        let budgetPct = maxVal > 0 ? CGFloat(NSDecimalNumber(decimal: budget / maxVal).doubleValue) : 0
        let spentPct = maxVal > 0 ? CGFloat(NSDecimalNumber(decimal: spent / maxVal).doubleValue) : 0
        let over = spent > budget

        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(cat.name)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Spacer()
                Text("\(AppFormatter.formatCurrency(spent)) / \(AppFormatter.formatCurrency(budget))")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(over ? theme.danger : theme.textMuted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(theme.surface2)
                        .frame(width: geo.size.width * budgetPct, height: 6)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(over ? theme.danger : theme.accent)
                        .frame(width: geo.size.width * spentPct, height: 4)
                        .offset(y: 0)
                }
            }
            .frame(height: 6)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Categories

    private var categoriesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CATEGORIES")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 10) {
                ForEach(myCategories, id: \.name) { cat in
                    NavigationLink {
                        CategoryDetailView(category: cat)
                    } label: {
                        categoryCard(cat: cat)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func categoryCard(cat: BudgetCategory) -> some View {
        let spent = spentInCategory(cat.name)
        let limit = cat.monthlyBudget
        let pct = limit > 0 ? NSDecimalNumber(decimal: min(spent / limit, 2)).doubleValue : 0
        let over = spent > limit
        let close = pct >= 0.85 && !over
        let statusColor = over ? theme.danger : close ? theme.warn : theme.success
        let statusSoft = over ? theme.dangerSoft : close ? theme.warnSoft : theme.successSoft
        let statusLabel = over ? "OVER" : close ? "CLOSE" : "ON TRACK"
        let remainingPct = max(0, Int((1 - pct) * 100))

        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12)
                .fill(statusSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    CatGlyphView(kind: cat.icon, size: 18, color: statusColor)
                )

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    HStack(spacing: 8) {
                        Text(cat.name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(theme.text)
                        Text(statusLabel)
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .tracking(0.54)
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(statusSoft)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer()
                    Text(AppFormatter.formatCurrency(spent))
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.text)
                }

                HStack(spacing: 10) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 3).fill(theme.surface2)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(statusColor)
                                .frame(width: geo.size.width * min(pct, 1))
                        }
                    }
                    .frame(height: 6)

                    Text(over ? "+\(Int((pct - 1) * 100))% over" : "\(remainingPct)% left")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(statusColor)
                        .frame(minWidth: 76, alignment: .trailing)
                }
            }
        }
        .glassCard(padding: AppLayout.paddingCompact, radius: AppLayout.radiusMedium)
    }

    private func spentInCategory(_ name: String) -> Decimal {
        monthTransactions
            .filter { $0.category == name && $0.isSpend }
            .reduce(Decimal(0)) { $0 + $1.spendAmount }
    }
}
