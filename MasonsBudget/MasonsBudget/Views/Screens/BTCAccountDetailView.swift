import SwiftUI
import SwiftData

struct BTCAccountDetailView: View {
    @Environment(\.theme) private var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query private var accounts: [BTCAccount]

    let title: String
    let custody: BTCCustody?

    private var unit: DisplayUnit { DisplayUnit(rawValue: displayUnitRaw) ?? .btc }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }
    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }
    private var visibleAccounts: [BTCAccount] {
        accounts.filter { account in
            activeMember.sharesNetWorth(with: account.ownerMember) &&
            (custody == nil || account.custody == custody)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: title, eyebrow: "Bitcoin accounts")

                VStack(spacing: 0) {
                    ForEach(Array(visibleAccounts.enumerated()), id: \.element.key) { idx, account in
                        accountRow(account)
                        if idx < visibleAccounts.count - 1 {
                            Hairline(indent: 56)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func accountRow(_ account: BTCAccount) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: account.custody == .selfCustody ? AppIcon.vault : "building.columns.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(theme.accent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(account.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                Text(account.ownerMember.displayName)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textFaint)
            }

            Spacer()

            AmountView(sats: account.btc * 100_000_000, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
        }
        .padding(14)
    }
}
