import SwiftUI

struct BitcoinOverviewView: View {
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue

    @State private var compose: BitcoinComposeRoute?

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    private var balance: CanonicalBTCBalance? {
        canonicalFinancials.btcBalance.value
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "Bitcoin", eyebrow: "Overview") {
                    Button("+ ADD ACCOUNT") { compose = .account }
                        .ledgerType(.button)
                        .foregroundStyle(theme.accent)
                        .buttonStyle(.plain)
                        .accessibilityLabel("Add Bitcoin account")
                }

                if let balance {
                    stackCard(balance)
                        .padding(.horizontal, AppLayout.sectionPadding)
                        .padding(.bottom, AppLayout.cardSpacing)

                    custodyCards(balance)
                        .padding(.horizontal, AppLayout.sectionPadding)
                        .padding(.bottom, AppLayout.cardSpacing)

                    accountsCard(balance)
                        .padding(.horizontal, AppLayout.sectionPadding)
                } else if case .loading = canonicalFinancials.btcBalance {
                    LedgerSkeletonRows()
                        .padding(.horizontal, AppLayout.sectionPadding)
                } else {
                    RequiredFinancialSourceView(
                        title: "Bitcoin",
                        message: "The required Bitcoin balance document is empty or unavailable.",
                    )
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 112)
        }
        .background(theme.bg)
        .safeAreaInset(edge: .bottom) {
            actionFooter
        }
        .sheet(item: $compose) { route in
            switch route {
            case .buy:
                AddTransactionView(initialType: .btcBuy)
            case .billPay:
                BTCBillPayComposeView()
            case .transfer:
                NavigationStack { BitcoinTransferView() }
            case .account:
                AddBitcoinAccountView()
            }
        }
    }

    private func stackCard(_ balance: CanonicalBTCBalance) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("TOTAL STACK")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(theme.textMuted)
                Spacer()
                NavigationLink {
                    BitcoinPriceView()
                } label: {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(BTCPriceService.storedPrice == nil ? theme.warn : theme.success)
                            .frame(width: 6, height: 6)
                        Text(AppFormatter.formatCurrency(btcPrice))
                            .ledgerType(.rowFigure)
                            .foregroundStyle(theme.text)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Bitcoin price \(AppFormatter.formatCurrency(btcPrice))")
            }

            AmountView(
                sats: Decimal(balance.totalSats),
                unit: unit,
                role: .heroNumeral,
                btcPrice: btcPrice,
            )

            HStack {
                Text("AS OF \(balance.asOf.uppercased())")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textFaint)
                Spacer()
                Text("\(balance.accounts.count) ACCOUNTS")
                    .ledgerType(.kpiSub)
                    .foregroundStyle(theme.accent)
            }
        }
        .glassCard(padding: 18, radius: AppLayout.radiusMedium)
    }

    private func custodyCards(_ balance: CanonicalBTCBalance) -> some View {
        HStack(spacing: AppLayout.gridSpacing) {
            custodyCard(
                label: "SELF-CUSTODY",
                sats: balance.selfCustodySats,
                icon: AppIcon.vault,
                destination: BTCAccountDetailView(title: "Self-Custody", custody: .selfCustody),
            )
            custodyCard(
                label: "EXCHANGE",
                sats: balance.exchangeSats,
                icon: "building.columns.fill",
                destination: BTCAccountDetailView(title: "Exchange", custody: .exchange),
            )
        }
    }

    private func custodyCard(label: String, sats: Int64, icon: String, destination: some View) -> some View {
        NavigationLink {
            destination
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: icon)
                    .font(AppFont.iconSmall)
                    .foregroundStyle(theme.accent)
                Text(label)
                    .ledgerType(.kpiLabel)
                    .foregroundStyle(theme.textMuted)
                AmountView(sats: Decimal(sats), unit: unit, role: .rowFigure, btcPrice: btcPrice)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(padding: 14, radius: AppLayout.radiusMedium)
        }
        .buttonStyle(.plain)
    }

    private func accountsCard(_ balance: CanonicalBTCBalance) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ACCOUNT LEDGER")
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(14)

            Hairline()

            ForEach(Array(balance.accounts.enumerated()), id: \.element.key) { index, account in
                NavigationLink {
                    BTCAccountDetailView(title: account.label, custody: account.custody)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: account.custody == .selfCustody ? AppIcon.vault : "building.columns.fill")
                            .font(AppFont.iconTiny)
                            .foregroundStyle(theme.accent)
                            .frame(width: 28)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.label)
                                .ledgerType(.rowPrimary)
                                .foregroundStyle(theme.text)
                            Text(account.custody == .selfCustody ? "Self-custody" : "Exchange")
                                .ledgerType(.rowMeta)
                                .foregroundStyle(theme.textMuted)
                        }
                        Spacer()
                        AmountView(sats: Decimal(account.sats), unit: unit, role: .rowFigure, btcPrice: btcPrice)
                    }
                    .padding(14)
                }
                .buttonStyle(.plain)
                .ledgerRowReveal(index: index)

                if index < balance.accounts.count - 1 {
                    Hairline(indent: 54)
                }
            }
        }
        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
    }

    private var actionFooter: some View {
        HStack(spacing: 0) {
            footerAction("BUY", icon: "plus.circle.fill", route: .buy)
            footerAction("BILL PAY", icon: "banknote.fill", route: .billPay)
            footerAction("TRANSFER", icon: "arrow.left.arrow.right", route: .transfer)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(theme.surface)
        .overlay(alignment: .top) { Hairline() }
    }

    private func footerAction(_ label: String, icon: String, route: BitcoinComposeRoute) -> some View {
        Button { compose = route } label: {
            VStack(spacing: 5) {
                Image(systemName: icon)
                    .font(AppFont.iconTiny)
                Text(label)
                    .ledgerType(.tabLabel)
            }
            .foregroundStyle(theme.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }
}

private enum BitcoinComposeRoute: String, Identifiable {
    case buy
    case billPay
    case transfer
    case account

    var id: String {
        rawValue
    }
}

struct BitcoinPriceView: View {
    @Environment(\.theme) private var theme
    @Environment(\.ledgerTokens) private var tokens
    @Environment(\.ledgerEffects) private var effects
    @AppStorage(BTCPriceService.priceKey) private var storedPrice = 0.0
    @AppStorage(BTCPriceService.change24hKey) private var change24h = 0.0
    @AppStorage(BTCPriceService.sourceKey) private var source = ""
    @AppStorage(BTCPriceService.updatedAtKey) private var updatedAt = 0.0
    @AppStorage(LedgerPreference.phosphorGlowKey) private var glowEnabled = LedgerPreference.phosphorGlowDefault
    @State private var isRefreshing = false
    @State private var glowRadius = LedgerGlowToken.restingRadius

    private var displayPrice: Decimal {
        storedPrice > 0 ? Decimal(storedPrice) : BTCPriceService.fallbackPriceUSD
    }

    private var displayPriceValue: Double {
        NSDecimalNumber(decimal: displayPrice).doubleValue
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Price", eyebrow: "BTC / USD")

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(storedPrice > 0 ? "LIVE QUOTE" : "FALLBACK QUOTE")
                            .ledgerType(.chip)
                            .foregroundStyle(storedPrice > 0 ? theme.success : theme.warn)
                        Spacer()
                        Image(systemName: "bitcoinsign.circle.fill")
                            .font(AppFont.iconLarge)
                            .foregroundStyle(theme.accent)
                    }

                    // Whole dollars in the primary ink, cents in the decimals token.
                    // The glow wraps both runs so the pulse stays one bloom.
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        LedgerSettlingNumeral(value: displayPriceValue) {
                            AppFormatter.priceHeroParts(Decimal($0)).integer
                        }
                        .ledgerType(.priceHero)
                        .foregroundStyle(theme.text)
                        LedgerSettlingNumeral(value: displayPriceValue) {
                            AppFormatter.priceHeroParts(Decimal($0)).decimals
                        }
                        .ledgerType(.priceHeroDecimals)
                        .foregroundStyle(tokens.colors.priceHeroDecimals)
                    }
                    .minimumScaleFactor(0.7)
                    .ledgerGlow(radius: glowRadius)
                    .onChange(of: storedPrice) { _, _ in
                        LedgerPhosphorPulse.run(
                            radius: $glowRadius,
                            reduceMotion: effects.reduceMotion,
                            treatment: tokens.treatment,
                            glowEnabled: glowEnabled,
                        )
                    }

                    if storedPrice > 0 {
                        Text("\(change24h >= 0 ? "+" : "")\(change24h, specifier: "%.2f")% · 24H")
                            .ledgerType(.rowFigure)
                            .foregroundStyle(change24h >= 0 ? theme.success : theme.danger)
                    }
                }
                .glassCard(padding: 18, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    priceRow("SOURCE", value: source.isEmpty ? "Fallback" : source)
                    Hairline()
                    priceRow("UPDATED", value: updatedLabel)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                Button {
                    refresh()
                } label: {
                    HStack(spacing: 8) {
                        if isRefreshing {
                            ProgressView().controlSize(.small)
                        }
                        Text(isRefreshing ? "REFRESHING" : "REFRESH PRICE")
                            .ledgerType(.rowFigure)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.accent)
                .disabled(isRefreshing)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Price")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private var updatedLabel: String {
        guard updatedAt > 0 else { return "Not available" }
        return Date(timeIntervalSince1970: updatedAt).formatted(date: .abbreviated, time: .shortened)
    }

    private func priceRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            Spacer()
            Text(value)
                .ledgerType(.rowFigure)
                .foregroundStyle(theme.text)
        }
        .padding(14)
    }

    private func refresh() {
        isRefreshing = true
        Task {
            await BTCPriceService.shared.refreshAndStore()
            await MainActor.run { isRefreshing = false }
        }
    }
}

struct BitcoinTransferView: View {
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @Environment(\.dismiss) private var dismiss
    @State private var sourceKey = ""
    @State private var destinationKey = ""
    @State private var amount = ""

    private var accounts: [CanonicalBTCBalance.Account] {
        canonicalFinancials.btcBalance.value?.accounts ?? []
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Transfer", eyebrow: "Between Bitcoin accounts")

                VStack(spacing: 0) {
                    accountPicker("FROM", selection: $sourceKey)
                    Hairline()
                    accountPicker("TO", selection: $destinationKey)
                    Hairline()
                    HStack {
                        Text("SATS")
                            .ledgerType(.kpiLabel)
                            .foregroundStyle(theme.textMuted)
                        TextField("0", text: $amount)
                            .ledgerType(.rowFigure)
                            .multilineTextAlignment(.trailing)
                        #if os(iOS)
                            .keyboardType(.numberPad)
                        #endif
                    }
                    .padding(14)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                holdCard(
                    title: "ATOMIC LEDGER HOLD",
                    message: "Apple does not yet have an atomic account-to-account write route. This compose screen will not create one-sided ledger rows.",
                )
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Transfer")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
            }
        }
    }

    private func accountPicker(_ label: String, selection: Binding<String>) -> some View {
        HStack {
            Text(label)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            Spacer()
            Picker(label, selection: selection) {
                Text("Select account").tag("")
                ForEach(accounts, id: \.key) { account in
                    Text(account.label).tag(account.key)
                }
            }
            .labelsHidden()
        }
        .padding(14)
    }

    private func holdCard(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.warn)
            Text(message)
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(padding: 14, radius: AppLayout.radiusMedium)
        .padding(.horizontal, AppLayout.sectionPadding)
    }
}

struct AddBitcoinAccountView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Add account", eyebrow: "Canonical Bitcoin ledger")
                VStack(alignment: .leading, spacing: 8) {
                    Text("ACCOUNT WRITEBACK HOLD")
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(theme.warn)
                    Text("Bitcoin accounts come from the canonical balance document. This client will not create a local account that disappears on the next sync.")
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
                Spacer()
            }
            .background(theme.bg)
            .navigationTitle("Add account")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
