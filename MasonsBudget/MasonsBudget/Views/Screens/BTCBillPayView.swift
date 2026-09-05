import SwiftData
import SwiftUI

struct BTCBillPayView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BTCBillPay.date, order: .reverse) private var allBillPays: [BTCBillPay]
    @State private var showCompose = false

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var visibleBillPays: [BTCBillPay] {
        allBillPays.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var grouped: [(String, [BTCBillPay])] {
        AppFormatter.groupedByMonth(visibleBillPays, by: \.date)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Bill Pay", eyebrow: "Pay Bills in Bitcoin") {
                    Button("COMPOSE") { showCompose = true }
                        .font(AppFont.monoMicroStrong)
                        .foregroundStyle(theme.accent)
                        .buttonStyle(.plain)
                }

                summaryCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)

                ForEach(grouped, id: \.0) { month, billPays in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(month.uppercased())
                            .font(AppFont.sectionHeader)
                            .tracking(AppFont.sectionTracking)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(billPays.enumerated()), id: \.element.id) { idx, bp in
                                billPayRow(bp)
                                    .ledgerRowReveal(index: idx)
                                if idx < billPays.count - 1 {
                                    Hairline(indent: 56)
                                }
                            }
                        }
                        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    }
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.bottom, AppLayout.cardSpacing)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Bill Pay")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .sheet(isPresented: $showCompose) {
            BTCBillPayComposeView()
        }
    }

    @ViewBuilder
    private var summaryCard: some View {
        if let ledger = canonicalFinancials.btcBillPays.value {
            let totalUSD = decimalMinorUnits(ledger.totalUSDCents, scale: 2)
            let totalSats = btcPrice > 0 ? (totalUSD / btcPrice) * 100_000_000 : 0
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("BILLS PAID")
                        .font(AppFont.sectionHeader)
                        .tracking(AppFont.sectionTracking)
                        .foregroundStyle(.white.opacity(0.7))
                    AmountView(sats: totalSats, unit: unit, size: 22, weight: .bold, color: .white, btcPrice: btcPrice)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("BTC SPENT")
                        .font(AppFont.sectionHeader)
                        .tracking(AppFont.sectionTracking)
                        .foregroundStyle(.white.opacity(0.7))
                    AmountView(sats: Decimal(ledger.totalSpentSats), unit: unit, size: 22, weight: .bold, color: .white, btcPrice: btcPrice)
                }
            }
            .padding(20)
            .background(
                LinearGradient(colors: [theme.plum, theme.plum.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing),
            )
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        } else if case .loading = canonicalFinancials.btcBillPays {
            LedgerSkeletonRows(rows: 1)
        } else {
            RequiredFinancialSourceView(
                title: "Bill Pay",
                message: "The required Bitcoin bill-pay ledger is empty or unavailable.",
            )
        }
    }

    private func billPayRow(_ bp: BTCBillPay) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.surface2)
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: iconFor(bp.category))
                        .font(AppFont.iconTiny)
                        .foregroundStyle(theme.plum),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(bp.merchant)
                    .font(AppFont.labelLarge)
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Text("\(bp.date.formatted(.dateTime.month(.abbreviated).day())) · \(bp.platform)")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                AmountView(sats: btcPrice > 0 ? (bp.amountUSD / btcPrice) * 100_000_000 : 0, unit: unit, size: 14, weight: .bold, btcPrice: btcPrice)
                AmountView(sats: bp.btcSpent * 100_000_000, unit: unit, size: 11, weight: .regular, color: theme.textMuted, btcPrice: btcPrice)
            }
        }
        .padding(14)
    }

    private func iconFor(_ category: String) -> String {
        switch category.lowercased() {
        case let c where c.contains("mortgage") || c.contains("housing"): "house.fill"
        case let c where c.contains("insurance"): "shield.fill"
        case let c where c.contains("credit"): "creditcard.fill"
        case let c where c.contains("auto") || c.contains("car"): "car.fill"
        case let c where c.contains("util"): "bolt.fill"
        default: "banknote.fill"
        }
    }
}

struct BTCBillPayComposeView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var merchant = ""
    @State private var amount = ""
    @State private var fee = ""
    @State private var effect: BTCBillPayBudgetEffect = .budgetCategory
    @State private var category = ""

    private var parsedAmount: Decimal {
        // Write-path parse: pinned POSIX locale (the entry pad emits
        // dot-decimal text; the device locale would read "12.50" as 1250).
        Decimal(
            string: amount.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "$", with: ""),
            locale: Locale(identifier: "en_US_POSIX"),
        ) ?? 0
    }

    private var parsedFee: Decimal? {
        let clean = fee.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "$", with: "")
        guard !clean.isEmpty else { return nil }
        return Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX"))
    }

    private var exactFee: Decimal? {
        RiverBillPayFeePolicy.fee(forAmount: parsedAmount, manualFee: parsedFee)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppLayout.cardSpacing) {
                    ScreenHeader(title: "Bill Pay", eyebrow: "Compose · River")

                    VStack(spacing: 0) {
                        composeField("MERCHANT", prompt: "Payee", text: $merchant)
                        Hairline()
                        composeField("AMOUNT", prompt: "$0.00", text: $amount)
                        Hairline()
                        composeField("FEE", prompt: "Enter exact fee", text: $fee)
                        Hairline()
                        HStack {
                            Text("BUDGET")
                                .font(AppFont.monoMicroStrong)
                                .foregroundStyle(theme.textMuted)
                            Spacer()
                            Picker("Budget effect", selection: $effect) {
                                Text("Budget category").tag(BTCBillPayBudgetEffect.budgetCategory)
                                Text("Credit card payment").tag(BTCBillPayBudgetEffect.creditCardPayment)
                            }
                            .labelsHidden()
                        }
                        .padding(14)

                        if effect == .budgetCategory {
                            Hairline()
                            composeField("CATEGORY", prompt: "Required", text: $category)
                        }
                    }
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("RIVER FEE HOLD")
                            .font(AppFont.monoMicroStrong)
                            .foregroundStyle(theme.warn)
                        Text(RiverBillPayFeePolicy.guidance)
                            .font(AppFont.labelRegular)
                            .foregroundStyle(theme.textMuted)
                        Text(exactFee.map { "MANUAL FEE · \(AppFormatter.formatCurrency($0))" } ?? "MANUAL FEE · NOT ENTERED")
                            .font(AppFont.monoSmallStrong)
                            .foregroundStyle(exactFee == nil ? theme.warn : theme.text)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("WRITEBACK HOLD")
                            .font(AppFont.monoMicroStrong)
                            .foregroundStyle(theme.warn)
                        Text("The Apple client has no bill-pay create route yet. This form does not submit or create a transaction row in its place.")
                            .font(AppFont.labelRegular)
                            .foregroundStyle(theme.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
                .padding(.bottom, 100)
            }
            .background(theme.bg)
            .navigationTitle("Compose bill pay")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func composeField(_ label: String, prompt: String, text: Binding<String>) -> some View {
        HStack {
            Text(label)
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(theme.textMuted)
            TextField(prompt, text: text)
                .font(AppFont.monoCaptionStrong)
                .multilineTextAlignment(.trailing)
        }
        .padding(14)
    }
}
