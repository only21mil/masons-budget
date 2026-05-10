import SwiftUI
import SwiftData

struct RetirementView: View {
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var accounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var lots: [CostBasisLot]
    @Query private var budgetSnapshots: [MonthlyBudgetSnapshot]
    @Query(sort: \BudgetCategory.sortOrder) private var budgetCategories: [BudgetCategory]

    @State private var extraBtcPerMonth: Double = 0
    @State private var projectionHorizon: Int = 10

    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }
    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }

    private var visibleAccounts: [BTCAccount] {
        accounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var totalBtc: Decimal { visibleAccounts.reduce(Decimal(0)) { $0 + $1.btc } }
    private var coldBtc: Decimal {
        visibleAccounts.filter { $0.custody == .selfCustody }.reduce(Decimal(0)) { $0 + $1.btc }
    }
    private var hotBtc: Decimal { totalBtc - coldBtc }

    private let targetBtc: Decimal = 10
    private let annualBurnUsd: Decimal = 60_000
    private let dcaWeeklySats: Decimal = 2_100_000

    private var goalPct: Double {
        guard targetBtc > 0 else { return 0 }
        return NSDecimalNumber(decimal: totalBtc / targetBtc * 100).doubleValue
    }

    private var visibleHoldings: [HoldingAccount] {
        holdingAccounts.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var totalHoldingsUsd: Decimal {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        return visibleHoldings.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
    }

    private var visibleLots: [CostBasisLot] {
        lots.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Retirement", eyebrow: "The Long Stack")

                runwayCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                storageSection
                    .padding(.bottom, AppLayout.cardSpacing)

                if !visibleHoldings.isEmpty {
                    holdingsSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                projectionsSection
                    .padding(.bottom, AppLayout.cardSpacing)

                projectorSection
                    .padding(.bottom, AppLayout.cardSpacing)

                lotsSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Runway Hero Card

    private var runwayYears: Int {
        guard annualBurnUsd > 0, btcPrice > 0 else { return 0 }
        let totalUsd = totalBtc * btcPrice
        return Int(NSDecimalNumber(decimal: totalUsd / annualBurnUsd).doubleValue)
    }

    private var runwayEndYear: Int {
        Calendar.current.component(.year, from: Date()) + runwayYears
    }

    private var runwayCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PROJECTED RUNWAY")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.1)
                .opacity(0.85)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(runwayYears)")
                    .font(.system(size: 50, weight: .bold, design: .monospaced))
                    .tracking(-1.5)
                Text("years")
                    .font(.system(size: 16, weight: .semibold))
                    .opacity(0.85)
            }

            Text("At your current burn, your stack covers life past \(runwayEndYear).")
                .font(.system(size: 13))
                .opacity(0.85)
                .padding(.top, 2)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white.opacity(0.25))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white)
                        .frame(width: geo.size.width * min(goalPct / 100, 1))
                }
            }
            .frame(height: 6)
            .padding(.top, 8)

            HStack {
                Text("\(Int(goalPct))% of \(NSDecimalNumber(decimal: targetBtc).intValue) BTC goal")
                    .font(.system(size: 11, weight: .semibold))
                    .opacity(0.85)
                Spacer()
                let remaining = targetBtc - totalBtc
                Text("\(AppFormatter.formatBtc(max(remaining, 0))) BTC to go")
                    .font(.system(size: 11, weight: .semibold))
                    .opacity(0.85)
            }
        }
        .foregroundStyle(.white)
        .padding(20)
        .background(
            LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    // MARK: - Storage Section

    private var storageSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STORAGE")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                NavigationLink {
                    BTCAccountDetailView(title: "Cold Storage", custody: .selfCustody)
                } label: {
                    storageRow(
                        title: "Cold Storage · Coldcard Q",
                        subtitle: "Multi-sig · 2-of-3",
                        icon: AppIcon.vault,
                        btc: coldBtc
                    )
                }
                .buttonStyle(.plain)
                Hairline(indent: 68)
                NavigationLink {
                    BTCAccountDetailView(title: "Spending Wallets", custody: .exchange)
                } label: {
                    storageRow(
                        title: "Spending · Phoenix LN",
                        subtitle: "Self-custodial Lightning",
                        icon: "bolt.fill",
                        btc: hotBtc
                    )
                }
                .buttonStyle(.plain)
            }
            .glassCard(padding: 0, radius: 18)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func storageRow(title: String, subtitle: String, icon: String, btc: Decimal) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 11)
                .fill(theme.accentSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 20))
                        .foregroundStyle(theme.accent)
                )

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

    // MARK: - Holdings (401k, WAP)

    private var holdingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("RETIREMENT ACCOUNTS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text(AppFormatter.formatCurrency(totalHoldingsUsd))
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                ForEach(Array(visibleHoldings.enumerated()), id: \.element.name) { idx, account in
                    holdingAccountRow(account)
                    if idx < visibleHoldings.count - 1 {
                        Hairline(indent: 56)
                    }
                }
            }
            .glassCard(padding: 0, radius: 18)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func holdingAccountRow(_ account: HoldingAccount) -> some View {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        let value = account.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice)

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 11)
                    .fill(theme.accentSoft)
                    .frame(width: 38, height: 38)
                    .overlay(
                        Image(systemName: "chart.line.uptrend.xyaxis")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(theme.accent)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(account.provider)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.text)
                    Text(account.name.uppercased())
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.textFaint)
                }

                Spacer()

                Text(AppFormatter.formatCurrency(value))
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.text)
            }
            .padding(14)

            if !account.holdings.isEmpty {
                VStack(spacing: 0) {
                    ForEach(account.holdings, id: \.name) { holding in
                        holdingRow(holding)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            }
        }
    }

    private func holdingRow(_ holding: Holding) -> some View {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        let ticker = holding.ticker?.uppercased() ?? ""
        let liveVal: Decimal
        switch ticker {
        case "VOO" where vooPrice != nil:
            liveVal = (vooPrice ?? 0) * holding.shares
        case "IBIT" where ibitPrice != nil:
            liveVal = (ibitPrice ?? 0) * holding.shares
        default:
            liveVal = holding.value
        }
        let gainPct = holding.gainPct

        return HStack(spacing: 8) {
            Text(holding.ticker ?? "—")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(theme.accent)
                .frame(width: 40, alignment: .leading)

            Text(holding.name)
                .font(.system(size: 12))
                .foregroundStyle(theme.text)
                .lineLimit(1)

            Spacer()

            Text(AppFormatter.formatCurrency(liveVal))
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(theme.text)

            let positive = gainPct >= 0
            Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: gainPct).intValue)%")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(positive ? theme.success : theme.danger)
                .frame(width: 44, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .padding(.leading, 50)
    }

    // MARK: - Projections

    private let weekly401k: Decimal = 291.60
    private let matchRate: Decimal = 1.0
    private let annualGrowthRate: Double = 0.07
    private let annualBonuses: Decimal = 97_000

    private var current401kBalance: Decimal {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        return visibleHoldings.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
    }

    private var monthlyBudgetTotal: Decimal {
        budgetCategories
            .filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) && !$0.isIncome }
            .reduce(Decimal(0)) { $0 + $1.monthlyBudget }
    }

    private var monthlyIncomeNet: Decimal {
        let df = DateFormatter()
        df.dateFormat = "MMMM yyyy"
        let key = df.string(from: Date())
        guard let snapshot = budgetSnapshots.first(where: { $0.monthKey == key }) else { return 0 }
        return snapshot.mtdIncome > 0 ? snapshot.mtdIncome : snapshot.monthlyGross
    }

    private var monthlySurplusForBtc: Decimal {
        let surplus = monthlyIncomeNet - monthlyBudgetTotal
        return max(surplus, 0)
    }

    private func project401k(years: Int) -> Decimal {
        let quarterlyContrib = weekly401k * 13
        let quarterlyTotal = quarterlyContrib + (quarterlyContrib * matchRate)
        let quarterlyRate = Decimal(annualGrowthRate / 4.0)
        let quarters = years * 4
        var balance = current401kBalance
        for _ in 0..<quarters {
            balance = balance * (1 + quarterlyRate) + quarterlyTotal
        }
        return balance
    }

    private func projectBtc(years: Int) -> Decimal {
        guard btcPrice > 0 else { return totalBtc }
        let weeklyBtcFromDCA = dcaWeeklySats / 100_000_000
        let monthlyBtcFromDCA = weeklyBtcFromDCA * Decimal(4.33)
        let monthlyBtcFromSurplus = monthlySurplusForBtc / btcPrice
        let annualBtcFromBonuses = annualBonuses / btcPrice
        let monthlyBtc = monthlyBtcFromDCA + monthlyBtcFromSurplus + (annualBtcFromBonuses / 12)
        return totalBtc + (monthlyBtc * 12 * Decimal(years))
    }

    private var projectionHorizons: [Int] { [5, 10, 15, 20] }

    private var projectionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTIONS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 16) {
                horizonPicker

                projectionSummaryCard

                projectionBreakdown

                projectionAssumptions
            }
            .glassCard()
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var horizonPicker: some View {
        HStack(spacing: 0) {
            ForEach(projectionHorizons, id: \.self) { yr in
                Button {
                    projectionHorizon = yr
                } label: {
                    Text("\(yr)yr")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(projectionHorizon == yr ? .white : theme.textMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(projectionHorizon == yr ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(theme.surface2)
        .clipShape(Capsule())
    }

    private var projectionSummaryCard: some View {
        let btcProjected = projectBtc(years: projectionHorizon)
        let retirementProjected = project401k(years: projectionHorizon)
        let btcUsd = btcProjected * btcPrice
        let totalUsd = btcUsd + retirementProjected

        return VStack(alignment: .leading, spacing: 4) {
            Text("TOTAL AT \(projectionHorizon) YEARS")
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(theme.textFaint)
            Text(AppFormatter.formatCurrency(totalUsd))
                .font(.system(size: 28, weight: .bold, design: .monospaced))
                .tracking(-0.56)
                .foregroundStyle(theme.text)
            Text("at today's BTC price")
                .font(.system(size: 11))
                .foregroundStyle(theme.textFaint)
        }
    }

    private var projectionBreakdown: some View {
        let btcProjected = projectBtc(years: projectionHorizon)
        let retirementProjected = project401k(years: projectionHorizon)
        let btcUsd = btcProjected * btcPrice

        return VStack(spacing: 0) {
            projectionRow(
                label: "401(k)",
                icon: "chart.line.uptrend.xyaxis",
                value: AppFormatter.formatCurrency(retirementProjected),
                subtitle: "7% growth · 100% match"
            )
            Divider().background(theme.border)
            projectionRow(
                label: "Bitcoin",
                icon: "bitcoinsign.circle.fill",
                value: "\(AppFormatter.formatBtc(btcProjected)) BTC",
                subtitle: AppFormatter.formatCurrency(btcUsd)
            )
        }
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func projectionRow(label: String, icon: String, value: String, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(theme.accent)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            Text(value)
                .font(.system(size: 14, weight: .bold, design: .monospaced))
                .foregroundStyle(theme.text)
        }
        .padding(12)
    }

    private var projectionAssumptions: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Assumptions")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(theme.textMuted)

            let weeklySatsLabel = AppFormatter.formatSats(dcaWeeklySats)
            let surplusLabel = AppFormatter.formatCurrency(monthlySurplusForBtc)
            let lines = [
                "401k: $291.60/wk + 100% match (quarterly)",
                "Stock growth: 7%/yr compounded",
                "DCA: \(weeklySatsLabel) sats/wk",
                "Surplus: \(surplusLabel)/mo → BTC",
                "Bonuses: $24k Jul · $24k Dec · $49k Mar → BTC",
                "BTC price: current (no appreciation)"
            ]
            ForEach(lines, id: \.self) { line in
                Text("• \(line)")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .padding(12)
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Goal Projector

    private var projectorSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("GOAL PROJECTOR")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Text("\(AppFormatter.formatSats(dcaWeeklySats)) SATS/wk")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(theme.accent)
            }
            .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(alignment: .leading, spacing: 8) {
                let goalYear = projectedGoalYear
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(goalYear)
                        .font(.system(size: 28, weight: .bold, design: .monospaced))
                        .tracking(-0.56)
                        .foregroundStyle(theme.text)
                    Text("to \(NSDecimalNumber(decimal: targetBtc).intValue) BTC goal")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.textFaint)
                }

                projectionChart
                    .frame(height: 140)

                whatIfSlider
            }
            .glassCard()
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private var projectedGoalYear: String {
        let weeklyBtc = dcaWeeklySats / 100_000_000
        let monthlyBtc = weeklyBtc * Decimal(4.33) + Decimal(extraBtcPerMonth)
        var projected = totalBtc
        var year = Calendar.current.component(.year, from: Date())
        while projected < targetBtc && year < 2050 {
            projected += monthlyBtc * 12
            year += 1
        }
        return projected >= targetBtc ? "\(year)" : "—"
    }

    private var projectionChart: some View {
        Canvas { context, size in
            let weeklyBtc = NSDecimalNumber(decimal: dcaWeeklySats / 100_000_000).doubleValue
            let monthlyExtra = extraBtcPerMonth
            let monthly = weeklyBtc * 4.33 + monthlyExtra
            let startBtc = NSDecimalNumber(decimal: totalBtc).doubleValue
            let target = NSDecimalNumber(decimal: targetBtc).doubleValue

            var points: [CGFloat] = []
            for year in 0...9 {
                let btc = startBtc + monthly * 12 * Double(year)
                points.append(CGFloat(btc))
            }

            let maxVal = max(points.max() ?? target, target)
            let minVal = max((points.min() ?? 0) * 0.9, 0)
            let range = maxVal - minVal
            guard range > 0 else { return }

            let targetY = size.height - ((CGFloat(target) - minVal) / range) * size.height * 0.8 - size.height * 0.1

            var dashed = Path()
            dashed.move(to: CGPoint(x: 0, y: targetY))
            dashed.addLine(to: CGPoint(x: size.width, y: targetY))
            context.stroke(dashed, with: .color(theme.borderStrong), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))

            var path = Path()
            for (i, val) in points.enumerated() {
                let x = size.width * CGFloat(i) / CGFloat(points.count - 1)
                let y = size.height - ((val - minVal) / range) * size.height * 0.8 - size.height * 0.1
                if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }

            var fill = path
            fill.addLine(to: CGPoint(x: size.width, y: size.height))
            fill.addLine(to: CGPoint(x: 0, y: size.height))
            fill.closeSubpath()

            context.fill(fill, with: .linearGradient(
                Gradient(colors: [theme.accent.opacity(0.3), theme.accent.opacity(0)]),
                startPoint: .zero,
                endPoint: CGPoint(x: 0, y: size.height)
            ))
            context.stroke(path, with: .color(theme.accent), lineWidth: 2)
        }
    }

    private var whatIfSlider: some View {
        VStack(spacing: 10) {
            HStack {
                Text("What if I added…")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(theme.text)
                Spacer()
                Text("+\(String(format: "%.3f", extraBtcPerMonth)) BTC/mo")
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.accent)
            }

            Slider(value: $extraBtcPerMonth, in: 0...0.05, step: 0.001)
                .tint(theme.accent)

            HStack {
                Text("0")
                Spacer()
                Text("0.025")
                Spacer()
                Text("0.05 BTC")
            }
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.textFaint)
        }
        .padding(14)
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Cost Basis Lots

    private var lotsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LOTS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.72)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                if visibleLots.isEmpty {
                    Text("No cost basis lots tracked yet")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.textFaint)
                        .padding(16)
                } else {
                    ForEach(Array(visibleLots.enumerated()), id: \.element.lotId) { idx, lot in
                        lotRow(lot: lot, idx: idx)
                        if idx < visibleLots.count - 1 {
                            Hairline(indent: 20)
                        }
                    }
                }
            }
            .glassCard(padding: 0)
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func lotRow(lot: CostBasisLot, idx: Int) -> some View {
        let value = lot.currentValue(btcPrice: btcPrice)
        let returnPct = lot.unrealizedGainPct(btcPrice: btcPrice)
        let positive = returnPct >= 0

        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(theme.accent.opacity(0.2 + Double(idx) * 0.15))
                .frame(width: 6)
                .frame(minHeight: 28)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(lot.lotId)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.text)
                    Text(lot.label)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.text)
                }
                Text("\(lot.date) · \(AppFormatter.formatBtc(lot.btcAmount)) BTC · cost \(AppFormatter.formatCurrency(lot.basisUsd))")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(AppFormatter.formatCurrency(value))
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(theme.text)
                Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: returnPct).intValue)%")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(positive ? theme.success : theme.danger)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
