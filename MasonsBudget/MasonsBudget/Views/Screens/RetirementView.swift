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

    private let dcaWeeklySats: Decimal = 2_100_000

    private var btcGoal: Decimal {
        activeMember == .mason ? 1 : 5
    }

    private var netWorthGoal: Decimal {
        activeMember == .mason ? 100_000 : 2_250_000
    }

    private var currentNetWorth: Decimal {
        totalBtc * btcPrice + totalHoldingsUsd
    }

    private var btcPct: Double {
        guard btcGoal > 0 else { return 0 }
        return min(NSDecimalNumber(decimal: totalBtc / btcGoal * 100).doubleValue, 100)
    }

    private var netWorthPct: Double {
        guard netWorthGoal > 0 else { return 0 }
        return min(NSDecimalNumber(decimal: currentNetWorth / netWorthGoal * 100).doubleValue, 100)
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

                goalsCard
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

                lotsSection
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    // MARK: - Goals Card

    private var goalsCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("2026 GOALS")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.85))

            goalRow(
                icon: "bitcoinsign.circle.fill",
                label: "\(AppFormatter.formatBtc(btcGoal)) BTC",
                current: totalBtc,
                target: btcGoal,
                pct: btcPct,
                detail: "\(AppFormatter.formatBtc(totalBtc)) / \(AppFormatter.formatBtc(btcGoal))"
            )

            goalRow(
                icon: "chart.line.uptrend.xyaxis",
                label: "\(AppFormatter.formatCurrency(netWorthGoal)) Net Worth",
                current: currentNetWorth,
                target: netWorthGoal,
                pct: netWorthPct,
                detail: "\(AppFormatter.formatCurrency(currentNetWorth)) / \(AppFormatter.formatCurrency(netWorthGoal))"
            )
        }
        .padding(20)
        .background(
            LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func goalRow(icon: String, label: String, current: Decimal, target: Decimal, pct: Double, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white.opacity(0.9))
                Text(label)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                Spacer()
                Text("\(Int(pct))%")
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white.opacity(0.25))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white)
                        .frame(width: geo.size.width * min(CGFloat(pct) / 100, 1))
                }
            }
            .frame(height: 5)

            Text(detail)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
        }
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

    private var totalHoldingsSats: Decimal {
        btcPrice > 0 ? (totalHoldingsUsd / btcPrice) * 100_000_000 : 0
    }

    private var holdingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("RETIREMENT ACCOUNTS")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.72)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                AmountView(sats: totalHoldingsSats, unit: unit, size: 12, weight: .bold, accent: true, btcPrice: btcPrice)
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
        let sats: Decimal = btcPrice > 0 ? (value / btcPrice) * 100_000_000 : 0

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

                AmountView(sats: sats, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
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
        let sats: Decimal = btcPrice > 0 ? (liveVal / btcPrice) * 100_000_000 : 0

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

            AmountView(sats: sats, unit: unit, size: 12, weight: .semibold, btcPrice: btcPrice)

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

    private let btcIbitAnnualReturn: Double = 0.15
    private let vooAnnualReturn: Double = 0.10
    private let matchRate: Decimal = 1.0
    private let victorAnnualBonuses: Decimal = 97_000

    private var weekly401kContribution: Decimal {
        visibleHoldings.reduce(Decimal(0)) { $0 + $1.weeklyContribution }
    }

    private var currentHoldingsBalance: Decimal {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        return visibleHoldings.reduce(Decimal(0)) { $0 + $1.liveValue(vooPrice: vooPrice, ibitPrice: ibitPrice) }
    }

    private var monthlyBudgetTotal: Decimal {
        budgetCategories
            .filter { activeMember.sharesNetWorth(with: $0.ownerMember) && !$0.isIncome }
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

    private func projectHoldings(years: Int) -> Decimal {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        let weeklyContrib = weekly401kContribution
        let quarterlyContrib = weeklyContrib * 13
        let quarterlyTotal = quarterlyContrib + (quarterlyContrib * matchRate)

        var vooBalance: Decimal = 0
        var ibitBalance: Decimal = 0
        var otherBalance: Decimal = 0

        for account in visibleHoldings {
            for holding in account.holdings {
                let ticker = holding.ticker?.uppercased() ?? ""
                let val: Decimal
                switch ticker {
                case "VOO" where vooPrice != nil:
                    val = (vooPrice ?? 0) * holding.shares
                    vooBalance += val
                case "IBIT" where ibitPrice != nil:
                    val = (ibitPrice ?? 0) * holding.shares
                    ibitBalance += val
                default:
                    otherBalance += holding.value
                }
            }
        }

        let quarters = years * 4
        let vooQuarterlyRate = Decimal(vooAnnualReturn / 4.0)
        let ibitQuarterlyRate = Decimal(btcIbitAnnualReturn / 4.0)

        let totalBalance = vooBalance + ibitBalance + otherBalance
        let vooFraction: Decimal = totalBalance > 0 ? vooBalance / totalBalance : Decimal(0.5)
        let ibitFraction: Decimal = totalBalance > 0 ? ibitBalance / totalBalance : Decimal(0.5)

        for _ in 0..<quarters {
            let vooContrib = quarterlyTotal * vooFraction
            let ibitContrib = quarterlyTotal * ibitFraction
            vooBalance = vooBalance * (1 + vooQuarterlyRate) + vooContrib
            ibitBalance = ibitBalance * (1 + ibitQuarterlyRate) + ibitContrib
        }

        let otherRate = Decimal(vooAnnualReturn / 4.0)
        for _ in 0..<quarters {
            otherBalance = otherBalance * (1 + otherRate)
        }

        return vooBalance + ibitBalance + otherBalance
    }

    private func projectBtc(years: Int) -> Decimal {
        guard btcPrice > 0 else { return totalBtc }
        let weeklyBtcFromDCA = dcaWeeklySats / 100_000_000
        let monthlyBtcFromDCA = weeklyBtcFromDCA * Decimal(4.33)
        let monthlyBtcFromSurplus = monthlySurplusForBtc / btcPrice

        var monthlyBtc = monthlyBtcFromDCA + monthlyBtcFromSurplus

        if activeMember == .victor || activeMember == .rachel {
            let annualBtcFromBonuses = victorAnnualBonuses / btcPrice
            monthlyBtc += annualBtcFromBonuses / 12
        }

        let currentBtcValue = totalBtc * btcPrice
        let annualAppreciation = Decimal(btcIbitAnnualReturn)
        var projectedValue = currentBtcValue
        let monthlyRate = annualAppreciation / 12

        for _ in 0..<(years * 12) {
            projectedValue = projectedValue * (1 + monthlyRate) + (monthlyBtc * btcPrice)
        }

        return projectedValue / btcPrice
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
        let holdingsProjected = projectHoldings(years: projectionHorizon)
        let btcUsd = btcProjected * btcPrice
        let totalUsd = btcUsd + holdingsProjected
        let totalSats: Decimal = btcPrice > 0 ? (totalUsd / btcPrice) * 100_000_000 : 0

        return VStack(alignment: .leading, spacing: 4) {
            Text("TOTAL AT \(projectionHorizon) YEARS")
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(theme.textFaint)
            AmountView(sats: totalSats, unit: unit, size: 28, weight: .bold, btcPrice: btcPrice)
            Text("with 15% BTC/IBIT · 10% VOO growth")
                .font(.system(size: 11))
                .foregroundStyle(theme.textFaint)
        }
    }

    private var projectionBreakdown: some View {
        let btcProjected = projectBtc(years: projectionHorizon)
        let holdingsProjected = projectHoldings(years: projectionHorizon)
        let holdingsSats: Decimal = btcPrice > 0 ? (holdingsProjected / btcPrice) * 100_000_000 : 0
        let btcSats = btcProjected * 100_000_000

        return VStack(spacing: 0) {
            projectionAmountRow(
                label: "401(k) + WAP",
                icon: "chart.line.uptrend.xyaxis",
                sats: holdingsSats,
                subtitle: "IBIT 15% · VOO 10% · 100% match"
            )
            Divider().background(theme.border)
            projectionAmountRow(
                label: "Bitcoin",
                icon: "bitcoinsign.circle.fill",
                sats: btcSats,
                subtitle: "\(AppFormatter.formatBtc(btcProjected)) BTC"
            )
        }
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func projectionAmountRow(label: String, icon: String, sats: Decimal, subtitle: String) -> some View {
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

            AmountView(sats: sats, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
        }
        .padding(12)
    }

    private var assumptionLines: [String] {
        let weeklySatsLabel = AppFormatter.formatSats(dcaWeeklySats)
        let surplusLabel = AppFormatter.formatCurrency(monthlySurplusForBtc)
        let weeklyLabel = AppFormatter.formatCurrency(weekly401kContribution)

        if activeMember == .victor || activeMember == .rachel {
            return [
                "401k + WAP: \(weeklyLabel)/wk (Fri) + 100% match (quarterly)",
                "IBIT & BTC: 15%/yr growth",
                "VOO: 10%/yr growth",
                "DCA: \(weeklySatsLabel) sats/wk",
                "Budget surplus: \(surplusLabel)/mo → BTC",
                "Bonuses: $24k Jul · $24k Dec · $49k Mar → BTC"
            ]
        } else {
            return [
                "401k: \(weeklyLabel)/wk (Fri) + 100% match (quarterly)",
                "IBIT & BTC: 15%/yr growth",
                "VOO: 10%/yr growth",
                "Budget surplus: \(surplusLabel)/mo → BTC"
            ]
        }
    }

    private var projectionAssumptions: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Assumptions")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(theme.textMuted)

            ForEach(assumptionLines, id: \.self) { line in
                Text("• \(line)")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.textFaint)
            }
        }
        .padding(12)
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 10))
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
        let lotSats: Decimal = btcPrice > 0 ? (value / btcPrice) * 100_000_000 : 0

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
                AmountView(sats: lotSats, unit: unit, size: 13, weight: .bold, btcPrice: btcPrice)
                Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: returnPct).intValue)%")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(positive ? theme.success : theme.danger)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
