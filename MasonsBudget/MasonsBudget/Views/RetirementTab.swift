import SwiftUI
import SwiftData

struct RetirementTab: View {
    @Query private var btcAccounts: [BTCAccount]
    @Query(sort: \BTCBuy.date) private var btcBuys: [BTCBuy]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0

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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.cardSpacing) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("THE LONG STACK")
                            .font(AppTheme.eyebrowFont)
                            .foregroundStyle(AppTheme.accentColor)
                        Text("Retirement")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(AppTheme.primaryText)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)

                    runwayHero
                    storageBreakdown
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Stack")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    private var runwayHero: some View {
        let totalUSD = totalBTC * btcPrice
        let monthlyBurn: Decimal = 8500
        let runwayYears = monthlyBurn > 0 ? Double(truncating: (totalUSD / (monthlyBurn * 12)) as NSNumber) : 0
        let goalBTC: Decimal = 10
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

            ProgressView(value: min(goalPct, 1.0))
                .tint(.white)
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

    private var storageBreakdown: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("STORAGE")
                .font(AppTheme.eyebrowFont)
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
            }
            .glassCard()
        }
    }
}
