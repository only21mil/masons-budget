import SwiftUI

struct BitcoinOverviewView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue

    @State private var compose: BitcoinComposeRoute?
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue
    private var isAdult: Bool { FamilyMember(rawValue: memberRaw)?.isAdult == true }

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
                ScreenHeader(title: "Bitcoin", eyebrow: "Overview")

                if let balance {
                    stackCard(balance)
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                        .padding(.bottom, AppLayout.cardSpacing)

                    custodyCards(balance)
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                        .padding(.bottom, AppLayout.cardSpacing)

                    accountsCard(balance)
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    VStack(spacing: 14) {
                        if isAdult { Button("Transfer Bitcoin") { compose = .transfer }.disabled(!AppWritebackConfig.canWriteBitcoin) }
                        NavigationLink("Bill payments") { BTCBillPayView() }
                        NavigationLink("Buys and corrections") { BitcoinEntryHistoryView(entity: .buy, title: "Bitcoin buys") }
                        if isAdult {
                            NavigationLink("Transfer history") { BitcoinEntryHistoryView(entity: .transfer, title: "Transfers") }
                            NavigationLink("Manage accounts") { BitcoinEntryHistoryView(entity: .account, title: "Accounts") }
                        }
                    }
                    .padding(ledgerTokens.metrics.screenGutter)
                } else if case .loading = canonicalFinancials.btcBalance {
                    LedgerSkeletonRows()
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                } else {
                    RequiredFinancialSourceView(
                        title: "Bitcoin",
                        message: "Your Bitcoin balance is empty or unavailable.",
                    )
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
            HStack {
                Text("ACCOUNT LEDGER").ledgerType(.sectionLabel).foregroundStyle(theme.textMuted)
                Spacer()
                if isAdult { Button("Add account") { compose = .account }.ledgerType(.button).disabled(!AppWritebackConfig.canWriteBitcoin) }
            }
            .padding(14)

            if isAdult { DeviceWriteSetupPrompt().padding(.horizontal, 14) }
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
    @Environment(\.ledgerTokens) private var ledgerTokens
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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                VStack(spacing: 0) {
                    priceRow("SOURCE", value: source.isEmpty ? "Fallback" : source)
                    Hairline()
                    priceRow("UPDATED", value: updatedLabel)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @Environment(\.dismiss) private var dismiss
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue
    @State private var id = UUID().uuidString
    @State private var sourceKey = ""
    @State private var destinationKey = ""
    @State private var amount = ""
    @State private var fee = ""
    @State private var date = Date.now
    @State private var isSaving = false
    @State private var message: String?

    private var member: FamilyMember { FamilyMember(rawValue: memberRaw) ?? .victor }
    private var accounts: [CanonicalBTCBalance.Account] {
        guard canonicalFinancials.btcBalance.value?.owner.isAdult == true else { return [] }
        return canonicalFinancials.btcBalance.value?.accounts ?? []
    }
    private var feeSats: Int64? { fee.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : Int64(fee) }
    private var totalDebit: Int64? {
        guard let sats = Int64(amount), let feeSats, feeSats >= 0 else { return nil }
        let (total, overflow) = sats.addingReportingOverflow(feeSats)
        return overflow ? nil : total
    }
    private var validationMessage: String? {
        if !member.isAdult { return "Bitcoin transfers are available to adult profiles." }
        if accounts.count < 2 { return "At least two household Bitcoin accounts are required" }
        if sourceKey.isEmpty || destinationKey.isEmpty { return "Select the From and To accounts." }
        if sourceKey == destinationKey { return "Choose two different accounts." }
        guard let sats = Int64(amount), sats > 0 else { return "Enter a positive whole number of sats." }
        guard let feeSats, feeSats >= 0 else { return "Enter a whole network fee of 0 sats or more." }
        guard let source = accounts.first(where: { $0.key == sourceKey }),
              accounts.contains(where: { $0.key == destinationKey }),
              let totalDebit, totalDebit <= source.sats else { return "The From account does not have enough sats." }
        return nil
    }
    private var canSave: Bool { AppWritebackConfig.canWriteBitcoin && !isSaving && validationMessage == nil }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Transfer", eyebrow: "Between Bitcoin accounts")
                DeviceWriteSetupPrompt()
                    .ledgerType(.button)
                    .tint(theme.accent)
                VStack(spacing: 0) {
                    accountPicker("FROM", selection: $sourceKey)
                    Hairline()
                    accountPicker("TO", selection: $destinationKey)
                    Hairline()
                    satsField("SATS", text: $amount)
                    Hairline()
                    satsField("Network fee (sats)", text: $fee)
                    Text("Charged to the From account.").ledgerType(.rowMeta).foregroundStyle(theme.textMuted).padding(.horizontal, 14)
                    Hairline()
                    HStack {
                        Text("DATE").ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
                        Spacer()
                        DatePicker("Date", selection: $date, displayedComponents: .date)
                            .labelsHidden()
                            .tint(theme.accent)
                    }
                    .padding(14)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                if let totalDebit, let sats = Int64(amount), sats > 0 {
                    Text("From loses \(totalDebit) sats · To gains \(sats) sats").ledgerType(.rowMeta)
                }
                if let validationMessage {
                    Text(validationMessage)
                        .foregroundStyle(theme.warn)
                        .ledgerType(.rowMeta)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                }
                if let message { Text(message).foregroundStyle(theme.warn) }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .disabled(isSaving)
        #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
        #endif
        .interactiveDismissDisabled(isSaving)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button("Cancel") { dismiss() }
                    .ledgerType(.button)
                    .tint(theme.accent)
                    .frame(minHeight: LedgerMetrics.minimumHitTarget)
                    .disabled(isSaving)
                Spacer()
                Button(isSaving ? "Saving" : "Save transfer", action: save)
                    .ledgerType(.button)
                    .buttonStyle(.borderedProminent)
                    .tint(theme.accentFill)
                    .foregroundStyle(canSave ? theme.onAccent : theme.textFaint)
                    .frame(minHeight: LedgerMetrics.minimumHitTarget)
                    .disabled(!canSave)
            }
            .padding(ledgerTokens.metrics.screenGutter).background(theme.surface)
        }
        // This sheet owns its header rather than inheriting the presenting tab's title.
        .environment(\.ledgerRootTitle, nil)
        .environment(\.ledgerRootAccessory, nil)
    }

    private func accountPicker(_ label: String, selection: Binding<String>) -> some View {
        let selectedTitle = accounts.first(where: { $0.key == selection.wrappedValue })
            .map { "\($0.label) · \($0.sats) sats" } ?? "Select account"
        return HStack {
            Text(label).ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
            Spacer()
            Menu {
                Picker(label, selection: selection) {
                    Text("Select account").tag("")
                    ForEach(accounts, id: \.key) { Text("\($0.label) · \($0.sats) sats").tag($0.key) }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: 6) {
                    Text(selectedTitle).ledgerType(.button)
                    Image(systemName: "chevron.up.chevron.down").font(AppFont.icon(size: 12))
                }
                .foregroundStyle(theme.accent)
                .frame(minHeight: LedgerMetrics.minimumHitTarget)
            }
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .tint(theme.accent)
            .accessibilityLabel(label)
            .accessibilityValue(selectedTitle)
        }
        .padding(14)
    }

    private func satsField(_ label: String, text: Binding<String>) -> some View {
        HStack {
            Text(label).ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
            TextField("0", text: text).ledgerType(.rowFigure).multilineTextAlignment(.trailing)
                #if os(iOS)
                    .keyboardType(.numberPad)
                #endif
        }
        .padding(14)
    }

    private func save() {
        guard canSave, let sats = Int64(amount), let feeSats else { return }
        isSaving = true
        message = nil
        AppWriteSyncService.pushTransfer(id: id, date: date, from: sourceKey, to: destinationKey,
                                         sats: sats, feeSats: feeSats, member: member) { result in
            isSaving = false
            if result.isOk { dismiss() } else { message = result.userMessage(operation: "Transfer") }
        }
    }
}

struct AddBitcoinAccountView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue
    let existing: BitcoinDeviceEntry?
    @State private var key: String?
    @State private var label: String
    @State private var custody: BTCCustody
    @State private var isSaving = false
    @State private var message: String?
    @State private var showingDelete = false
    @State private var document: BitcoinAccountDocument?
    @State private var didLoadDocument = false

    init(existing: BitcoinDeviceEntry? = nil) {
        self.existing = existing
        _key = State(initialValue: existing?.key)
        _label = State(initialValue: existing?.label ?? "")
        _custody = State(initialValue: existing?.custody ?? .selfCustody)
    }

    private var member: FamilyMember { FamilyMember(rawValue: memberRaw) ?? .victor }
    private var trimmedLabel: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validationMessage: String? {
        if !member.isAdult { return "Bitcoin accounts are managed by adult profiles." }
        if trimmedLabel.isEmpty { return "Enter an account name." }
        if document?.accounts.contains(where: {
            $0.key != key && $0.label.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(trimmedLabel) == .orderedSame
        }) == true { return "An account with this name already exists." }
        return nil
    }
    private var canSave: Bool { AppWritebackConfig.canWriteBitcoin && didLoadDocument && !isSaving && validationMessage == nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppLayout.cardSpacing) {
                    ScreenHeader(title: existing == nil ? "Add account" : "Edit account", eyebrow: "Bitcoin accounts")
                    DeviceWriteSetupPrompt()
                        .ledgerType(.button)
                        .tint(theme.accent)
                    if !didLoadDocument {
                        Button("Load account details") { Task { await loadDocument() } }
                            .ledgerType(.button)
                            .tint(theme.accent)
                            .frame(minHeight: LedgerMetrics.minimumHitTarget)
                    }
                    VStack(spacing: 14) {
                        TextField("Coldcard, River, Phoenix", text: $label).ledgerType(.textInput)
                        HStack(spacing: LedgerMetrics.siblingChipSpacing) {
                            PillButton(label: "Self custody", isActive: custody == .selfCustody, accent: true) { custody = .selfCustody }
                            PillButton(label: "Exchange", isActive: custody == .exchange, accent: true) { custody = .exchange }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Custody")
                        if existing == nil { Text("Starts at 0 sats. Buys, bill pays, and transfers change the balance.").ledgerType(.rowMeta) }
                    }
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    if let validationMessage { Text(validationMessage).foregroundStyle(theme.warn).ledgerType(.rowMeta) }
                    if let message { Text(message).foregroundStyle(theme.warn).ledgerType(.rowMeta) }
                    if existing != nil {
                        Button("Delete account", role: .destructive) { showingDelete = true }
                            .ledgerType(.button)
                            .tint(theme.danger)
                    }
                }
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
            }
            .background(theme.bg)
            .disabled(isSaving)
            #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
            #endif
            .interactiveDismissDisabled(isSaving)
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Button("Cancel") { dismiss() }
                        .ledgerType(.button)
                        .tint(theme.accent)
                        .frame(minHeight: LedgerMetrics.minimumHitTarget)
                        .disabled(isSaving)
                    Spacer()
                    Button(isSaving ? "Saving" : "Save account", action: save)
                        .ledgerType(.button)
                        .buttonStyle(.borderedProminent)
                        .tint(theme.accentFill)
                        .foregroundStyle(canSave ? theme.onAccent : theme.textFaint)
                        .frame(minHeight: LedgerMetrics.minimumHitTarget)
                        .disabled(!canSave)
                }
                .padding(ledgerTokens.metrics.screenGutter).background(theme.surface)
            }
            .task(id: memberRaw) { await loadDocument() }
            .confirmationDialog("Delete this account?", isPresented: $showingDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { remove() }
            } message: { Text("Removes \(trimmedLabel) from the Bitcoin ledger. This cannot be undone.") }
        }
        // This sheet owns its header rather than inheriting the presenting tab's title.
        .environment(\.ledgerRootTitle, nil)
        .environment(\.ledgerRootAccessory, nil)
    }

    private func loadDocument() async {
        let requestedMember = member
        didLoadDocument = false
        do {
            let loaded = try await AppWritebackClient().bitcoinAccountDocument(profile: requestedMember)
            guard member == requestedMember else { return }
            if let existing {
                guard let account = loaded?.accounts.first(where: { $0.key == existing.key }),
                      account.sats == existing.sats, account.label == existing.label, account.custody == existing.custody else {
                    message = "This account changed. Close the editor and refresh the account list."
                    return
                }
            }
            document = loaded
            didLoadDocument = true
            message = nil
        } catch { message = ConvexWriteResult.classify(error).userMessage(operation: "Load account") }
    }

    private func save() {
        guard canSave else { return }
        if key == nil { key = Self.makeKey(label: trimmedLabel, owner: member.ledgerOwner) }
        guard let key else { return }
        isSaving = true
        message = nil
        let asOf = document?.asOf ?? canonicalFinancials.btcBalance.value?.asOf ?? Self.defaultAsOf()
        AppWriteSyncService.pushAccount(key: key, label: trimmedLabel, custody: custody, sats: existing?.sats ?? 0,
                                        asOf: asOf, member: member, baseUpdatedAtMs: document?.updatedAtMs) { result in
            isSaving = false
            if result.isOk { dismiss() } else { message = result.userMessage(operation: "Bitcoin account") }
        }
    }

    private func remove() {
        guard let existing, let document else { return }
        isSaving = true
        AppWriteSyncService.deleteBitcoinEntry(.account, id: existing.id, owner: existing.owner, baseUpdatedAtMs: document.updatedAtMs) { result in
            isSaving = false
            if result.isOk { dismiss() } else { message = result.userMessage(operation: "Bitcoin account") }
        }
    }

    static func makeKey(label: String, owner: FamilyMember) -> String {
        let slug = label.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).joined(separator: "-")
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(6)
        return "\(slug)-\(owner.ledgerOwner.rawValue)-\(suffix)"
    }

    static func defaultAsOf(date: Date = .now) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date) + "T00:00:00.000Z"
    }
}

struct DeviceWriteSetupPrompt: View {
    var body: some View {
        if !AppWritebackConfig.canWriteLedger {
            NavigationLink("Pair this device in Sync Setup") { LedgerDrilldown(title: "Sync Setup") { SyncSetupView() } }
        } else if !AppWritebackConfig.canWriteBitcoin {
            Text("This device does not have permission to change Bitcoin entries.").ledgerType(.rowMeta)
            NavigationLink("Open Sync Setup") { LedgerDrilldown(title: "Sync Setup") { SyncSetupView() } }
        }
    }
}

struct BitcoinEntryHistoryView: View {
    let entity: AppWriteSyncService.BitcoinEntity
    let title: String
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue
    @State private var entries: [BitcoinDeviceEntry] = []
    @State private var selected: BitcoinDeviceEntry?
    @State private var editingAccount: BitcoinDeviceEntry?
    @State private var showAddAccount = false
    @State private var message: String?
    @State private var isLoading = false
    @State private var isDeleting = false

    var body: some View {
        List {
            DeviceWriteSetupPrompt()
            if isLoading { ProgressView("Loading") }
            if let message { Text(message) }
            ForEach(entries) { entry in
                Button {
                    if entity == .account { editingAccount = entry } else { selected = entry }
                } label: {
                    VStack(alignment: .leading) {
                        Text(entry.title)
                        Text("\(entry.sats) sats · \(entry.date ?? "")").ledgerType(.rowMeta)
                    }
                }
                .disabled(isDeleting)
            }
            if entries.isEmpty && !isLoading && message == nil { Text("No entries yet") }
        }
        .navigationTitle(title)
        .toolbar {
            if entity == .account && FamilyMember(rawValue: memberRaw)?.isAdult == true {
                Button("Add account") { showAddAccount = true }.disabled(!AppWritebackConfig.canWriteBitcoin)
            }
        }
        .sheet(isPresented: $showAddAccount, onDismiss: { Task { await refresh() } }) { AddBitcoinAccountView() }
        .sheet(item: $editingAccount, onDismiss: { Task { await refresh() } }) { AddBitcoinAccountView(existing: $0) }
        .task(id: memberRaw) {
            entries = []
            selected = nil
            message = nil
            await refresh()
        }
        .refreshable { await refresh() }
        .confirmationDialog("Delete this entry?", isPresented: Binding(
            get: { selected != nil }, set: { if !$0 { selected = nil } }
        ), titleVisibility: .visible) {
            if let selected {
                Button("Delete \(selected.title)", role: .destructive) { remove(selected) }
            }
            Button("Cancel", role: .cancel) { selected = nil }
        } message: {
            Text("The associated Bitcoin balance changes will be reversed. Accounts must have no remaining entries.")
        }
    }

    private func refresh() async {
        let member = FamilyMember(rawValue: memberRaw) ?? .victor
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await AppWritebackClient().bitcoinEntries(kind: entity.rawValue, profile: member)
            guard memberRaw == member.rawValue else { return }
            entries = loaded
            message = nil
        } catch {
            message = ConvexWriteResult.classify(error).userMessage(operation: "Load entries")
        }
    }

    private func remove(_ entry: BitcoinDeviceEntry) {
        isDeleting = true
        AppWriteSyncService.deleteBitcoinEntry(entity, id: entry.id, owner: entry.owner,
                                               baseUpdatedAtMs: entry.updatedAtMs) { result in
            isDeleting = false
            if result.isOk { entries.removeAll { $0.id == entry.id } }
            else { message = result.userMessage(operation: "Delete entry") }
        }
    }
}
