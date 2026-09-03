import SwiftData
import SwiftUI

struct RetirementView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var lots: [CostBasisLot]
    @Query(sort: \BudgetCategory.sortOrder) private var budgetCategories: [BudgetCategory]

    @State private var projectionHorizon: Int = 10

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var canonicalBTC: CanonicalBTCBalance? {
        canonicalFinancials.btcBalance.value
    }

    private var totalBtc: Decimal {
        guard let canonicalBTC else { return 0 }
        return decimalMinorUnits(canonicalBTC.totalSats, scale: 8)
    }

    private var coldBtc: Decimal {
        guard let canonicalBTC else { return 0 }
        return decimalMinorUnits(canonicalBTC.selfCustodySats, scale: 8)
    }

    private var hotBtc: Decimal {
        totalBtc - coldBtc
    }

    // MARK: - Planning-assumption constants (display only)
    //
    // These are the household's stated goals, not derived data: the weekly DCA
    // target is the standing 0.021 BTC/week plan; the BTC goals are the
    // 1 BTC (Mason) and 5 BTC (household) accumulation targets; the net-worth
    // goals are the $100k (Mason) and $2.25M (household) milestones. They feed
    // the progress card only — nothing persists or computes against them.

    /// Standing weekly dollar-cost-average target, in sats.
    private let dcaWeeklySats: Decimal = 2_100_000

    /// BTC accumulation goal: 1 BTC for Mason, 5 BTC for the household.
    private var btcGoal: Decimal {
        activeMember == .mason ? 1 : 5
    }

    /// Net-worth milestone: $100k for Mason, $2.25M for the household.
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

                if canonicalBTC != nil {
                    goalsCard
                        .padding(.horizontal, AppLayout.sectionPadding)
                        .padding(.bottom, AppLayout.cardSpacing)

                    storageSection
                        .padding(.bottom, AppLayout.cardSpacing)
                } else {
                    RequiredFinancialSourceView(
                        title: "Bitcoin Retirement Balance",
                        message: "The required Bitcoin balance document is empty or unavailable.",
                    )
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)
                }

                if !visibleHoldings.isEmpty {
                    holdingsSection
                        .padding(.bottom, AppLayout.cardSpacing)
                }

                if canonicalBTC != nil, currentIncomeCents != nil {
                    projectionsSection
                        .padding(.bottom, AppLayout.cardSpacing)
                } else {
                    RequiredFinancialSourceView(
                        title: "Retirement Projection",
                        message: "A projection requires both canonical Bitcoin and income sources.",
                    )
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)
                }

                lotsSection
            }
            .padding(.bottom, 170)
        }
        .background(theme.bg)
    }

    // MARK: - Goals Card

    private var goalsCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("2026 GOALS")
                .font(AppFont.sectionHeader)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(.white.opacity(0.85))

            goalRow(
                icon: "bitcoinsign.circle.fill",
                label: "\(AppFormatter.formatBtc(btcGoal)) BTC",
                current: totalBtc,
                target: btcGoal,
                pct: btcPct,
                detail: "\(AppFormatter.formatBtc(totalBtc)) / \(AppFormatter.formatBtc(btcGoal))",
            )

            goalRow(
                icon: "chart.line.uptrend.xyaxis",
                label: "\(AppFormatter.formatCurrency(netWorthGoal)) Net Worth",
                current: currentNetWorth,
                target: netWorthGoal,
                pct: netWorthPct,
                detail: "\(AppFormatter.formatCurrency(currentNetWorth)) / \(AppFormatter.formatCurrency(netWorthGoal))",
            )
        }
        .padding(20)
        .background(
            LinearGradient(colors: [theme.accent, theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing),
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func goalRow(icon: String, label: String, current _: Decimal, target _: Decimal, pct: Double, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(AppFont.labelLargeStrong)
                    .foregroundStyle(.white.opacity(0.9))
                Text(label)
                    .font(AppFont.bodyBold)
                    .foregroundStyle(.white)
                Spacer()
                Text("\(Int(pct))%")
                    .font(AppFont.monoCaptionStrong)
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
                .font(AppFont.monoSmallStrong)
                .foregroundStyle(.white.opacity(0.7))
        }
    }

    // MARK: - Storage Section

    private var storageSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STORAGE")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                NavigationLink {
                    BTCAccountDetailView(title: "Cold Storage", custody: .selfCustody)
                } label: {
                    storageRow(
                        title: "Cold Storage",
                        subtitle: "Multi-sig · 2-of-3",
                        icon: AppIcon.vault,
                        btc: coldBtc,
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
                        btc: hotBtc,
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
                        .font(AppFont.iconMedium)
                        .foregroundStyle(theme.accent),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppFont.labelLarge)
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
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
                    .font(AppFont.labelSmallStrong)
                    .tracking(AppFont.sectionTracking)
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
                            .font(AppFont.subtitleStrong)
                            .foregroundStyle(theme.accent),
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(account.provider)
                        .font(AppFont.labelLarge)
                        .foregroundStyle(theme.text)
                    Text(holdingAccountSubtitle(account))
                        .font(AppFont.small)
                        .foregroundStyle(theme.textMuted)
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

    private func holdingAccountSubtitle(_ account: HoldingAccount) -> String {
        let label = account.name.uppercased()
        guard account.weeklyContribution > 0 else { return label }
        return "\(label) · Fri DCA \(AppFormatter.formatCurrency(account.weeklyContribution))/wk"
    }

    private func holdingRow(_ holding: Holding) -> some View {
        let vooPrice = StockPriceService.vooPrice
        let ibitPrice = StockPriceService.ibitPrice
        let ticker = holding.ticker?.uppercased() ?? ""
        let liveVal: Decimal = switch ticker {
        case "VOO" where vooPrice != nil:
            (vooPrice ?? 0) * holding.shares
        case "IBIT" where ibitPrice != nil:
            (ibitPrice ?? 0) * holding.shares
        default:
            holding.value
        }
        let gainPct = holding.gainPct
        let sats: Decimal = btcPrice > 0 ? (liveVal / btcPrice) * 100_000_000 : 0

        return HStack(spacing: 8) {
            Text(holding.ticker ?? "—")
                .font(AppFont.monoSmallStrong)
                .foregroundStyle(theme.accent)
                .frame(width: 40, alignment: .leading)

            Text(holding.name)
                .font(AppFont.labelSmallRegular)
                .foregroundStyle(theme.text)
                .lineLimit(1)

            Spacer()

            AmountView(sats: sats, unit: unit, size: 12, weight: .semibold, btcPrice: btcPrice)

            let positive = gainPct >= 0
            Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: gainPct).intValue)%")
                .font(AppFont.monoMicroStrong)
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
    private let victorAnnualBonuses: Decimal = 97000

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

    private var currentIncomeCents: Int64? {
        guard let income = canonicalFinancials.income.value else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return income.cents(forMonth: formatter.string(from: Date()))
    }

    private var monthlyIncomeNet: Decimal {
        guard let currentIncomeCents else { return 0 }
        return decimalMinorUnits(currentIncomeCents, scale: 2)
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

        for _ in 0 ..< quarters {
            let vooContrib = quarterlyTotal * vooFraction
            let ibitContrib = quarterlyTotal * ibitFraction
            vooBalance = vooBalance * (1 + vooQuarterlyRate) + vooContrib
            ibitBalance = ibitBalance * (1 + ibitQuarterlyRate) + ibitContrib
        }

        let otherRate = Decimal(vooAnnualReturn / 4.0)
        for _ in 0 ..< quarters {
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

        for _ in 0 ..< (years * 12) {
            projectedValue = projectedValue * (1 + monthlyRate) + (monthlyBtc * btcPrice)
        }

        return projectedValue / btcPrice
    }

    private var projectionHorizons: [Int] {
        [5, 10, 15, 20]
    }

    private var projectionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECTIONS")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
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
                        .font(AppFont.labelSmallStrong)
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
                .font(AppFont.microStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
            AmountView(sats: totalSats, unit: unit, size: 28, weight: .bold, btcPrice: btcPrice)
            Text("with 15% BTC/IBIT · 10% VOO growth")
                .font(AppFont.smallRegular)
                .foregroundStyle(theme.textMuted)
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
                subtitle: "IBIT 15% · VOO 10% · 100% match",
            )
            Divider().background(theme.border)
            projectionAmountRow(
                label: "Bitcoin",
                icon: "bitcoinsign.circle.fill",
                sats: btcSats,
                subtitle: "\(AppFormatter.formatBtc(btcProjected)) BTC",
            )
        }
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func projectionAmountRow(label: String, icon: String, sats: Decimal, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(AppFont.iconTiny)
                .foregroundStyle(theme.accent)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(AppFont.captionStrong)
                    .foregroundStyle(theme.text)
                Text(subtitle)
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
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
                "Bonuses: $24k Jul · $24k Dec · $49k Mar → BTC",
            ]
        } else {
            return [
                "401k: \(weeklyLabel)/wk (Fri) + 100% match (quarterly)",
                "IBIT & BTC: 15%/yr growth",
                "VOO: 10%/yr growth",
                "Budget surplus: \(surplusLabel)/mo → BTC",
            ]
        }
    }

    private var projectionAssumptions: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Assumptions")
                .font(AppFont.sectionHeader)
                .foregroundStyle(theme.textMuted)

            ForEach(assumptionLines, id: \.self) { line in
                Text("• \(line)")
                    .font(AppFont.micro)
                    .foregroundStyle(theme.textMuted)
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
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            VStack(spacing: 0) {
                if visibleLots.isEmpty {
                    Text("No cost basis lots tracked yet")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
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
                        .font(AppFont.monoCaptionStrong)
                        .foregroundStyle(theme.text)
                    Text(lot.label)
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.text)
                }
                Text("\(lot.date) · \(AppFormatter.formatBtc(lot.btcAmount)) BTC · cost \(AppFormatter.formatCurrency(lot.basisUsd))")
                    .font(AppFont.monoSmall)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                AmountView(sats: lotSats, unit: unit, size: 13, weight: .bold, btcPrice: btcPrice)
                Text("\(positive ? "+" : "")\(NSDecimalNumber(decimal: returnPct).intValue)%")
                    .font(AppFont.monoMicroStrong)
                    .foregroundStyle(positive ? theme.success : theme.danger)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
