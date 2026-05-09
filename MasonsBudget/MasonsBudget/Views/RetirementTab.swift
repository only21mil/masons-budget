import SwiftUI
import SwiftData

struct RetirementTab: View {
    @Query private var btcAccounts: [BTCAccount]
    @Query(sort: \BTCBuy.date) private var btcBuys: [BTCBuy]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0
    @State private var extraBtcPerMonth: Double = 0

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var myAccounts: [BTCAccount] {
        btcAccounts.filter { currentMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var totalBTC: Decimal {
        myAccounts.reduce(Decimal(0)) { $0 + $1.btc }
    }

    private var btcPrice: Decimal {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : AppTheme.fallbackBTCPrice
    }

    private var goalBTC: Decimal { 10 }
    private var monthlyBurn: Decimal { 8500 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    screenHeader
                    runwayHero
                    storageBreakdown
                    dcaProjection
                    costBasisSection
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 100)
            }
            .background(AppTheme.background)
            .navigationTitle("Stack")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    // MARK: - Header

    private var screenHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("THE LONG STACK")
                .font(AppTheme.eyebrowFont)
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)
            Text("Retirement")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    // MARK: - Runway Hero

    private var runwayHero: some View {
        let totalUSD = totalBTC * btcPrice
        let runwayYears = monthlyBurn > 0 ? Double(truncating: (totalUSD / (monthlyBurn * 12)) as NSNumber) : 0
        let goalPct = totalBTC > 0 ? Double(truncating: (totalBTC / goalBTC) as NSNumber) : 0

        return VStack(alignment: .leading, spacing: 6) {
            Text("PROJECTED RUNWAY")
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(.white.opacity(0.85))

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(String(format: "%.1f", runwayYears))
                    .font(.system(size: 50, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                Text("years")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white.opacity(0.25))
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(.white)
                        .frame(width: max(0, min(geo.size.width, CGFloat(min(goalPct, 1.0)) * geo.size.width)), height: 6)
                }
            }
            .frame(height: 6)
            .padding(.top, 8)

            HStack {
                Text("\(Int(goalPct * 100))% of \(formatBtc(goalBTC)) goal")
                Spacer()
                Text("\(formatBtc(goalBTC - totalBTC)) to go")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white.opacity(0.85))
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 22)
                .fill(AppTheme.accentGradient)
        )
    }

    // MARK: - Storage Breakdown

    private var storageBreakdown: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STORAGE")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(AppTheme.secondaryText)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                ForEach(Array(myAccounts.enumerated()), id: \.element.id) { index, account in
                    HStack(spacing: 12) {
                        Image(systemName: account.custody == .selfCustody ? "building.columns.fill" : "bolt.fill")
                            .foregroundStyle(AppTheme.accentColor)
                            .frame(width: 38, height: 38)
                            .background(AppTheme.accentSoft)
                            .clipShape(RoundedRectangle(cornerRadius: 11))

                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.label)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(AppTheme.primaryText)
                            Text(account.custody == .selfCustody ? "Self-custody" : "Exchange")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.tertiaryText)
                        }

                        Spacer()

                        Text(formatCurrency(account.btc * btcPrice))
                            .font(AppTheme.monoData)
                            .foregroundStyle(AppTheme.primaryText)
                    }
                    .padding(.vertical, 14)
                    .padding(.horizontal, 14)

                    if index < myAccounts.count - 1 {
                        Divider()
                            .background(AppTheme.cardBorder)
                            .padding(.leading, 68)
                    }
                }

                if myAccounts.isEmpty {
                    Text("No BTC accounts synced")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.tertiaryText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                }
            }
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
            )
        }
    }

    // MARK: - DCA Projection

    private var dcaProjection: some View {
        let currentBtc = Double(truncating: totalBTC as NSNumber)
        let weeklyDCA = 0.002
        let years = 10
        var points: [(year: Int, btc: Double)] = []
        for i in 0...years {
            let projected = currentBtc + Double(i) * 52 * weeklyDCA + Double(i) * 12 * extraBtcPerMonth
            points.append((year: 2026 + i, btc: projected))
        }
        let goal = Double(truncating: goalBTC as NSNumber)
        let reached = points.first { $0.btc >= goal }
        let goalYear = reached.map { String($0.year) } ?? "—"
        let yearsToGoal = reached.map { $0.year - 2026 }

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("GOAL PROJECTOR")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AppTheme.secondaryText)
                Spacer()
                if extraBtcPerMonth > 0 {
                    Text("+\(String(format: "%.3f", extraBtcPerMonth)) BTC/mo")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(AppTheme.accentColor)
                }
            }
            .padding(.horizontal, 4)

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(goalYear)
                        .font(.system(size: 28, weight: .bold, design: .monospaced))
                        .foregroundStyle(AppTheme.primaryText)
                    if let yrs = yearsToGoal {
                        Text("\(yrs) yrs to \(formatBtc(goalBTC)) goal")
                            .font(.system(size: 13))
                            .foregroundStyle(AppTheme.tertiaryText)
                    } else {
                        Text("goal not reached in window")
                            .font(.system(size: 13))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                }

                projectionChart(points: points, goal: goal)

                VStack(spacing: 10) {
                    HStack {
                        Text("What if I added…")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(AppTheme.primaryText)
                        Spacer()
                        Text("+\(String(format: "%.3f", extraBtcPerMonth)) BTC")
                            .font(.system(size: 13, weight: .bold, design: .monospaced))
                            .foregroundStyle(AppTheme.accentColor)
                        Text("/mo")
                            .font(.system(size: 11))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                    Slider(value: $extraBtcPerMonth, in: 0...0.05, step: 0.001)
                        .tint(AppTheme.accentColor)
                    HStack {
                        Text("0")
                        Spacer()
                        Text("0.025")
                        Spacer()
                        Text("0.05 BTC")
                    }
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(AppTheme.tertiaryText)
                }
                .padding(14)
                .background(AppTheme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .glassCard()
        }
    }

    private func projectionChart(points: [(year: Int, btc: Double)], goal: Double) -> some View {
        let maxVal = max(points.map(\.btc).max() ?? goal, goal)
        let minVal = (points.map(\.btc).min() ?? 0) * 0.9

        return GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let goalY = h - CGFloat((goal - minVal) / (maxVal - minVal)) * h * 0.8 - h * 0.1

            ZStack(alignment: .topLeading) {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: goalY))
                    path.addLine(to: CGPoint(x: w, y: goalY))
                }
                .stroke(AppTheme.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))

                Path { path in
                    for (i, point) in points.enumerated() {
                        let x = CGFloat(i) / CGFloat(points.count - 1) * w
                        let y = h - CGFloat((point.btc - minVal) / (maxVal - minVal)) * h * 0.8 - h * 0.1
                        if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(AppTheme.accentColor, lineWidth: 2)

                ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                    if i % 2 == 0 {
                        let x = CGFloat(i) / CGFloat(points.count - 1) * w
                        let y = h - CGFloat((point.btc - minVal) / (maxVal - minVal)) * h * 0.8 - h * 0.1
                        Circle()
                            .fill(AppTheme.accentColor)
                            .frame(width: 4, height: 4)
                            .position(x: x, y: y)
                    }
                }

                Text("Goal · \(formatBtc(goalBTC))")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(AppTheme.secondaryText)
                    .position(x: w - 50, y: goalY - 10)
            }
        }
        .frame(height: 140)
    }

    // MARK: - Cost Basis

    private var costBasisSection: some View {
        let totalBasis = btcBuys.reduce(Decimal(0)) { $0 + $1.usd }
        let currentValue = totalBTC * btcPrice
        let unrealized = currentValue - totalBasis

        return VStack(alignment: .leading, spacing: 8) {
            Text("COST BASIS")
                .font(.system(size: 12, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(AppTheme.secondaryText)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("TOTAL BASIS · FIFO")
                            .font(.system(size: 11, weight: .bold))
                            .tracking(0.5)
                            .foregroundStyle(AppTheme.secondaryText)
                        Text("\(btcBuys.count) buys tracked")
                            .font(.system(size: 13))
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formatCurrency(totalBasis))
                            .font(.system(size: 16, weight: .bold, design: .monospaced))
                            .foregroundStyle(AppTheme.primaryText)
                        if unrealized >= 0 {
                            Text("+\(formatCurrency(unrealized)) unrealized")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(AppTheme.positive)
                        } else {
                            Text("\(formatCurrency(unrealized)) unrealized")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(AppTheme.negative)
                        }
                    }
                }
                .padding(14)

                ForEach(Array(btcBuys.suffix(5).reversed().enumerated()), id: \.element.id) { index, buy in
                    Divider().background(AppTheme.cardBorder)

                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(AppTheme.accentColor.opacity(0.3 + Double(index) * 0.14))
                            .frame(width: 6)

                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                Text(buy.source)
                                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                                    .foregroundStyle(AppTheme.primaryText)
                            }
                            Text("\(buy.date.formatted(date: .abbreviated, time: .omitted)) · \(formatBtc(buy.amountBTC)) · cost \(formatCurrency(buy.usd))")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(AppTheme.tertiaryText)
                                .lineLimit(1)
                        }

                        Spacer()

                        let lotValue = buy.amountBTC * btcPrice
                        let lotReturn = buy.usd > 0 ? Double(truncating: ((lotValue - buy.usd) / buy.usd * 100) as NSNumber) : 0
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(formatCurrency(lotValue))
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundStyle(AppTheme.primaryText)
                            Text("\(lotReturn >= 0 ? "+" : "")\(Int(lotReturn))%")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(lotReturn >= 0 ? AppTheme.positive : AppTheme.negative)
                        }
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 14)
                }
            }
            .background(AppTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
            )
        }
    }
}
