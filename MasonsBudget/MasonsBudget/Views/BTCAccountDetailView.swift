import SwiftUI
import SwiftData

struct BTCAccountDetailView: View {
    let account: BTCAccount

    @Query private var btcBuys: [BTCBuy]
    @Query private var btcBillPays: [BTCBillPay]
    @AppStorage(BTCPriceService.priceKey) private var liveBTCPriceUSD: Double = 0

    private var liveBTCPrice: Decimal? {
        liveBTCPriceUSD > 0 ? Decimal(liveBTCPriceUSD) : nil
    }

    private var accountBuys: [BTCBuy] {
        btcBuys
            .filter { buy in
                (buy.ownerMember ?? .victor) == account.ownerMember && isSameAccountName(buy.source, account.label)
            }
            .sorted { $0.date > $1.date }
    }

    private var accountBillPays: [BTCBillPay] {
        btcBillPays
            .filter { isSameAccountName($0.platform, account.label) }
            .sorted { $0.date > $1.date }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.cardSpacing) {
                accountHeader
                if !accountBuys.isEmpty { buysSection }
                if !accountBillPays.isEmpty { billPaysSection }
                if accountBuys.isEmpty && accountBillPays.isEmpty { emptyActivity }
            }
            .padding(.horizontal, AppTheme.horizontalPadding)
            .padding(.top, 8)
        }
        .background(AppTheme.background)
        .navigationTitle(account.label)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        #endif
    }

    private var accountHeader: some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: account.custody == .selfCustody ? "lock.shield.fill" : "building.columns.fill")
                    .font(.title3)
                    .foregroundStyle(AppTheme.accentColor)
                    .frame(width: 44, height: 44)
                    .background(RoundedRectangle(cornerRadius: 12).fill(AppTheme.warmGlow))
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.custody == .selfCustody ? "Self-Custody" : "Exchange")
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                    Text(formatBtc(account.btc))
                        .font(.title2.weight(.bold))
                        .foregroundStyle(AppTheme.primaryText)
                    Text(formatCurrency(account.usdValue(liveBTCPrice: liveBTCPrice)))
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
            }
        }
        .glassCard(highlight: true)
    }

    private var buysSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Buys", icon: "arrow.down.circle.fill")
            ForEach(accountBuys, id: \.id) { buy in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(buy.date.formatted(date: .abbreviated, time: .omitted))
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.primaryText)
                        if let note = buy.note, !note.isEmpty {
                            Text(note)
                                .font(.caption2)
                                .foregroundStyle(AppTheme.tertiaryText)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formatBtc(buy.amountBTC))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.positive)
                        Text(formatCurrency(buy.usd))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                }
                .glassCard()
            }
        }
    }

    private var billPaysSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Bill Pays", icon: "arrow.up.circle.fill")
            ForEach(accountBillPays, id: \.id) { pay in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pay.merchant)
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.primaryText)
                        Text(pay.date.formatted(date: .abbreviated, time: .omitted))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formatCurrency(pay.amountUSD))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.negative)
                        Text(formatBtc(pay.btcSpent))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                }
                .glassCard()
            }
        }
    }

    private var emptyActivity: some View {
        HStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.title3)
                .foregroundStyle(AppTheme.tertiaryText)
            Text("No account-specific Bitcoin activity recorded yet.")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private func isSameAccountName(_ lhs: String, _ rhs: String) -> Bool {
        let left = normalizeAccountName(lhs)
        let right = normalizeAccountName(rhs)
        return !left.isEmpty && !right.isEmpty && (left == right || left.contains(right) || right.contains(left))
    }

    private func normalizeAccountName(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
