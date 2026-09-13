import SwiftUI

struct BTCAccountDetailView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue

    let title: String
    let custody: BTCCustody?

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var visibleAccounts: [CanonicalBTCBalance.Account] {
        canonicalFinancials.btcBalance.value?.accounts.filter {
            custody == nil || $0.custody == custody
        } ?? []
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: title, eyebrow: "Bitcoin accounts")

                if canonicalFinancials.btcBalance.value != nil {
                    VStack(spacing: 0) {
                        ForEach(Array(visibleAccounts.enumerated()), id: \.element.key) { idx, account in
                            accountRow(account)
                                .ledgerRowReveal(index: idx)
                            if idx < visibleAccounts.count - 1 {
                                Hairline(indent: 56)
                            }
                        }
                    }
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                } else if case .loading = canonicalFinancials.btcBalance {
                    LedgerSkeletonRows()
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                } else {
                    RequiredFinancialSourceView(
                        title: title,
                        message: "Your Bitcoin balance is empty or unavailable.",
                    )
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle(title)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func accountRow(_ account: CanonicalBTCBalance.Account) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: account.custody == .selfCustody ? AppIcon.vault : "building.columns.fill")
                        .font(AppFont.icon(size: 17, weight: .semibold))
                        .foregroundStyle(theme.accent),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(account.label)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(canonicalFinancials.btcBalance.value?.owner.displayName ?? "")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            AmountView(sats: Decimal(account.sats), unit: unit, role: .rowFigure, btcPrice: btcPrice)
        }
        .padding(14)
    }
}
