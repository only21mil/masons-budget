import SwiftData
import SwiftUI

struct AddTransactionAmountIntent: Equatable {
    let amountUSD: Decimal
    let amountSats: Int64?
    let enteredInBitcoin: Bool?

    static func make(
        isIncome: Bool,
        inputUnit: DisplayUnit,
        typedAmount: Decimal,
        computedSats: Int64,
        btcPrice: Decimal,
    ) -> AddTransactionAmountIntent {
        let isBitcoinEntry = inputUnit != .usd
        let isBitcoinIncome = isIncome && isBitcoinEntry
        let amountUSD = inputUnit == .usd
            ? abs(typedAmount)
            : (Decimal(computedSats) / 100_000_000) * btcPrice

        return AddTransactionAmountIntent(
            amountUSD: amountUSD,
            amountSats: isIncome ? (isBitcoinIncome ? computedSats : nil) : computedSats,
            enteredInBitcoin: isBitcoinEntry ? true : nil,
        )
    }
}

@MainActor
final class AddTransactionCreateIDStore: ObservableObject {
    enum Entry {
        case transaction
        case bitcoinBuy
    }

    private let makeUUID: () -> UUID
    private(set) var transactionID: String
    private(set) var bitcoinBuyID: String

    init(makeUUID: @escaping () -> UUID = { UUID() }) {
        self.makeUUID = makeUUID
        transactionID = makeUUID().uuidString
        bitcoinBuyID = "b-app-\(makeUUID().uuidString)"
    }

    /// A rejected or ambiguous write keeps the same id for the user's retry.
    /// Only a receipt the server accepted advances the session to a new create.
    @discardableResult
    func recordServerResult(_ result: ConvexWriteResult, for entry: Entry) -> Bool {
        guard result.isOk else { return false }

        switch entry {
        case .transaction:
            transactionID = makeUUID().uuidString
        case .bitcoinBuy:
            bitcoinBuyID = "b-app-\(makeUUID().uuidString)"
        }
        return true
    }
}

struct AddTransactionView: View {
    @Environment(\.theme) var theme
    @Environment(\.dismiss) var dismiss
    @Environment(\.modelContext) var modelContext
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query private var categories: [BudgetCategory]

    @State private var txType: TxType
    @State private var inputUnit: DisplayUnit = .usd
    @State private var amount = ""
    @State private var selectedCategory = ""
    /// Selected payment-source wire (TransactionSourceCatalog), never a display label.
    @State private var method: String
    /// Bitcoin account for a Bitcoin-native method. Synced BTCAccounts are
    /// queried; a Bitcoin-native save requires a selection.
    @State private var bitcoinAccountKey: String?
    @Query private var btcAccounts: [BTCAccount]
    @State private var merchant = ""
    @State private var btcBuyPrice = ""
    @State private var amountValidationMessage: String?
    @State private var commitHaptic = LedgerHapticTrigger()
    /// Holds the in-flight write and its cause-specific rejection message. The
    /// sheet stays open until the write is accepted.
    @StateObject private var writeFeedback = WriteFeedbackStore()
    /// One create id per logical entry for this sheet session. If the server
    /// commits but its response is lost, Save retries the same id instead of
    /// creating and crediting a second row.
    @StateObject private var createIDs = AddTransactionCreateIDStore()

    /// The single inline message slot: local validation first, then the write cause.
    private var inlineMessage: String? {
        amountValidationMessage ?? writeFeedback.message
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? BTCPriceService.fallbackPriceUSD
    }

    init(initialType: TransactionActivityType = .spend) {
        _txType = State(initialValue: TxType(activity: initialType))
        _method = State(initialValue: TransactionSourceCatalog.defaultSource(for: initialType))

        let storedOwner = UserDefaults.standard.string(forKey: "selected_family_member")
            ?? FamilyMember.victor.rawValue

        if let member = FamilyMember(rawValue: storedOwner), member.isAdult {
            let victor = FamilyMember.victor.rawValue
            let rachel = FamilyMember.rachel.rawValue
            _categories = Query(
                filter: #Predicate<BudgetCategory> { category in
                    category.owner == victor || category.owner == rachel
                },
                sort: [SortDescriptor(\BudgetCategory.sortOrder)],
            )
        } else {
            let owner = FamilyMember(rawValue: storedOwner)?.rawValue ?? "__invalid_owner__"
            _categories = Query(
                filter: #Predicate<BudgetCategory> { category in
                    category.owner == owner
                },
                sort: [SortDescriptor(\BudgetCategory.sortOrder)],
            )
        }
    }

    private var activeMember: FamilyMember? {
        FamilyMember(rawValue: selectedMemberRaw)
    }

    private var scopedCategories: [BudgetCategory] {
        guard let activeMember else { return [] }
        return categories.filter { category in
            guard let categoryOwner = FamilyMember(rawValue: category.owner) else { return false }
            return activeMember.sharesNetWorth(with: categoryOwner)
        }
    }

    enum TxType: String, CaseIterable {
        case spend = "Spend"
        case income = "Income"
        case transfer = "Transfer"
        case btcBuy = "Buy BTC"

        /// Owned-wallet movement requires the dedicated atomic ledger flow.
        /// Keep the legacy case decodable, but never offer it as budget spend.
        static let selectableCases: [TxType] = [.spend, .income, .btcBuy]

        init(activity: TransactionActivityType) {
            switch activity {
            case .spend, .btcBillPay: self = .spend
            case .income: self = .income
            case .transfer: self = .transfer
            case .btcBuy: self = .btcBuy
            }
        }
    }

    private var numericAmount: Decimal {
        decimal(from: amount)
    }

    private var effectiveBTCBuyPrice: Decimal {
        let entered = decimal(from: btcBuyPrice)
        return entered > 0 ? entered : btcPrice
    }

    private var conversionBTCPrice: Decimal {
        txType == .btcBuy ? effectiveBTCBuyPrice : btcPrice
    }

    private func decimal(from rawValue: String) -> Decimal {
        let cleaned = rawValue
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: "₿", with: "")
        // The custom numpad always emits dot-decimal text; a device locale
        // would parse "12.50" as 1250 in comma-decimal regions.
        return Decimal(string: cleaned, locale: Locale(identifier: "en_US_POSIX")) ?? 0
    }

    private var computedSats: Decimal {
        switch inputUnit {
        case .sats: numericAmount
        case .btc: numericAmount * 100_000_000
        case .usd:
            conversionBTCPrice > 0 ? (numericAmount / conversionBTCPrice) * 100_000_000 : 0
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                typeSegment
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.top, 12)
                    .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)

                Spacer()

                amountSection
                    .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)

                Spacer()

                fieldsCard
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)

                numPad
                    .padding(.top, 8)
                    .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
            }
            .background(theme.bg)
            .ledgerHaptics(commitHaptic)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(writeFeedback.isRetryPending ? "Abandon" : "Cancel") {
                        cancelSheet()
                    }
                        .foregroundStyle(theme.accent)
                        .disabled(writeFeedback.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(
                        writeFeedback.isSaving
                            ? "Saving…"
                            : (writeFeedback.isRetryPending ? "Retry pending" : "Save"),
                    ) { saveTransaction() }
                        .ledgerType(.button)
                        .foregroundStyle(theme.accent)
                        .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
                }
            }
            .navigationTitle("New transaction")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .interactiveDismissDisabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
    }

    // MARK: - Type Segment

    private var typeSegment: some View {
        HStack(spacing: 0) {
            ForEach(TxType.selectableCases, id: \.self) { t in
                Button {
                    if txType != t {
                        txType = t
                        selectedCategory = ""
                        // Each activity has its own default payment source; a
                        // selection carried across a type switch could be
                        // unsupported (e.g. a fiat card on income).
                        method = TransactionSourceCatalog.defaultSource(for: activityTypeFor(t))
                    }
                } label: {
                    Text(t.rawValue)
                        .ledgerType(.chip)
                        .foregroundStyle(txType == t ? theme.text : theme.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(txType == t ? theme.surface : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Amount Section

    private var amountSection: some View {
        VStack(spacing: 8) {
            Text("AMOUNT")
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.accent)

            unitSelector

            HStack(spacing: 8) {
                if txType == .spend {
                    Text("\u{2212}")
                        .ledgerType(.amountInput)
                        .foregroundStyle(theme.textMuted)
                }
                Text("\(inputUnit.prefix)\(amount.isEmpty ? "0" : amount)")
                    .ledgerType(.amountInput)
                    .foregroundStyle(theme.text)
                if inputUnit != .usd {
                    Text(inputUnit.label)
                        .ledgerType(.kpiValue)
                        .foregroundStyle(theme.textMuted)
                }
            }

            conversionLine

            if let inlineMessage {
                Text(inlineMessage)
                    .ledgerType(.body)
                    .foregroundStyle(theme.danger)
            }
        }
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var unitSelector: some View {
        HStack(spacing: 0) {
            ForEach(DisplayUnit.allCases) { u in
                Button { switchUnit(to: u) } label: {
                    Text(u.label)
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(inputUnit == u ? .white : theme.textMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(inputUnit == u ? theme.accent : Color.clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(theme.surface2)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(theme.border, lineWidth: 1))
    }

    private var conversionLine: some View {
        let sats = computedSats
        let btc = sats / 100_000_000
        let usd = btc * conversionBTCPrice

        return Group {
            switch inputUnit {
            case .usd:
                Text("≈ \(AppFormatter.formatSats(sats)) SATS · \(AppFormatter.formatBtc(btc)) BTC")
            case .btc:
                Text("≈ \(AppFormatter.formatSats(sats)) SATS · \(AppFormatter.formatCurrency(usd))")
            case .sats:
                Text("≈ \(AppFormatter.formatBtc(btc)) BTC · \(AppFormatter.formatCurrency(usd))")
            }
        }
        .ledgerType(.rowPrimary)
        .foregroundStyle(inlineMessage == nil ? theme.textMuted : theme.danger)
    }

    private func switchUnit(to newUnit: DisplayUnit) {
        guard newUnit != inputUnit else { return }
        let sats = computedSats
        switch newUnit {
        case .sats: amount = AppFormatter.formatSats(sats)
        case .btc: amount = AppFormatter.formatBtc(sats / 100_000_000)
        case .usd: amount = AppFormatter.formatCurrency(sats / 100_000_000 * conversionBTCPrice)
        }
        inputUnit = newUnit
    }

    // MARK: - Fields Card

    private var fieldsCard: some View {
        VStack(spacing: 0) {
            if txType == .btcBuy {
                fieldRow(label: "Price") {
                    TextField(AppFormatter.formatCurrency(btcPrice), text: $btcBuyPrice)
                        .ledgerType(.rowFigure)
                        .foregroundStyle(theme.text)
                }

                Hairline()

                fieldRow(label: "Account") {
                    TextField("Strike, River...", text: $merchant)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.text)
                }
            } else {
                fieldRow(label: "Category") {
                    Menu {
                        ForEach(
                            scopedCategories.filter { txType == .income ? $0.isIncome : !$0.isIncome },
                            id: \.name,
                        ) { cat in
                            Button {
                                selectedCategory = cat.name
                            } label: {
                                Label(cat.name, systemImage: cat.icon)
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if !selectedCategory.isEmpty {
                                let cat = scopedCategories.first(where: { $0.name == selectedCategory })
                                CatGlyphView(kind: cat?.icon ?? "wrench", size: 11, color: .white)
                                    .frame(width: 18, height: 18)
                                    .background(theme.accent)
                                    .clipShape(RoundedRectangle(cornerRadius: 5))
                            }
                            Text(selectedCategory.isEmpty ? "Select" : selectedCategory)
                                .ledgerType(.rowPrimary)
                                .foregroundStyle(selectedCategory.isEmpty ? theme.textMuted : theme.text)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(AppFont.icon(size: 12, weight: .regular))
                                .foregroundStyle(theme.textMuted)
                        }
                    }
                }

                Hairline()

                fieldRow(label: "Method") {
                    // The catalogue's canonical order; selection is stored as
                    // the option's wire value, never its display label.
                    Menu {
                        ForEach(pickerOptions) { option in
                            Button {
                                method = option.wire
                            } label: {
                                Label(option.label, systemImage: PaymentMethod.icon(forWire: option.wire))
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: PaymentMethod.icon(forWire: method))
                                .font(AppFont.icon(size: 12, weight: .regular))
                                .foregroundStyle(theme.textMuted)
                            Text(selectedLabel)
                                .ledgerType(.rowPrimary)
                                .foregroundStyle(theme.text)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(AppFont.icon(size: 12, weight: .regular))
                                .foregroundStyle(theme.textMuted)
                        }
                    }
                }

                if isBitcoinNativeMethod {
                    Hairline()

                    fieldRow(label: "Account") {
                        // The backend requires a named Bitcoin account on
                        // every Bitcoin-native posting; the save is blocked
                        // below until one is chosen.
                        Menu {
                            ForEach(adultBtcAccounts, id: \.key) { account in
                                Button {
                                    bitcoinAccountKey = account.key
                                } label: {
                                    Label(account.label, systemImage: "bitcoinsign.circle")
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "bitcoinsign.circle")
                                    .font(AppFont.icon(size: 12, weight: .regular))
                                    .foregroundStyle(theme.textMuted)
                                Text(bitcoinAccountLabel)
                                    .ledgerType(.rowPrimary)
                                    .foregroundStyle(bitcoinAccountKey == nil ? theme.textMuted : theme.text)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(AppFont.icon(size: 12, weight: .regular))
                                    .foregroundStyle(theme.textMuted)
                            }
                        }
                    }
                }

                Hairline()

                fieldRow(label: "Merchant") {
                    TextField("Where?", text: $merchant)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.text)
                }
            }
        }
        .glassCard(padding: 0, radius: AppLayout.radiusCompact)
    }

    private func fieldRow(label: String, @ViewBuilder content: () -> some View) -> some View {
        HStack {
            Text(label)
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.textMuted)
                .frame(width: 88, alignment: .leading)
            content()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: - Method Picker

    /// Spend, income, and transfer map to the shared activity types; all
    /// selectable cases here are payment-source activities.
    private var activityType: TransactionActivityType {
        activityTypeFor(txType)
    }

    private func activityTypeFor(_ t: TxType) -> TransactionActivityType {
        switch t {
        case .spend: .spend
        case .income: .income
        case .transfer: .transfer
        case .btcBuy: .spend
        }
    }

    private var pickerOptions: [TransactionSourceOption] {
        TransactionSourceCatalog.sources(for: activityType, including: method)
    }

    private var selectedLabel: String {
        pickerOptions.first { $0.wire == method }?.label ?? method
    }

    /// True when the selected method is a catalogued Bitcoin-native wire.
    private var isBitcoinNativeMethod: Bool {
        TransactionSourceCatalog.option(forWire: method)?.classification.isBitcoinNative == true
    }

    /// Accounts the posting may target: adults only, matching the backend's
    /// postsToHouseholdBitcoinLedger gate.
    private var adultBtcAccounts: [BTCAccount] {
        btcAccounts
            .filter { $0.ownerMember == .victor || $0.ownerMember == .rachel }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private var bitcoinAccountLabel: String {
        guard let bitcoinAccountKey,
              let account = adultBtcAccounts.first(where: { $0.key == bitcoinAccountKey })
        else { return "None" }
        return account.label
    }

    // MARK: - Number Pad

    private var numPad: some View {
        VStack(spacing: 0) {
            ForEach([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "⌫"]], id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(row, id: \.self) { key in
                        Button {
                            handleKey(key)
                        } label: {
                            Text(key)
                                .font(AppFont.iconLarge)
                                .foregroundStyle(theme.text)
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(key == "⌫" ? "Delete digit" : key)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }

    private func handleKey(_ key: String) {
        guard !writeFeedback.isSaving, !writeFeedback.isRetryPending else { return }
        amountValidationMessage = nil
        writeFeedback.clear()
        if key == "⌫" {
            if !amount.isEmpty { amount.removeLast() }
        } else if key == "." {
            if inputUnit == .sats { return }
            if amount.contains(".") { return }
            amount += key
        } else {
            amount += key
        }
    }

    private func cancelSheet() {
        guard !writeFeedback.isSaving else { return }
        guard writeFeedback.isRetryPending else {
            dismiss()
            return
        }

        do {
            switch txType {
            case .btcBuy:
                let buys = try modelContext.fetch(FetchDescriptor<BTCBuy>())
                if let buy = buys.first(where: { $0.id == createIDs.bitcoinBuyID }) {
                    modelContext.delete(buy)
                }
                let lots = try modelContext.fetch(FetchDescriptor<CostBasisLot>())
                if let lot = lots.first(where: { $0.lotId == createIDs.bitcoinBuyID }) {
                    modelContext.delete(lot)
                }
            default:
                let transactions = try modelContext.fetch(FetchDescriptor<Transaction>())
                if let pending = transactions.first(where: {
                    $0.id == createIDs.transactionID
                        && $0.sourceFile == Transaction.pendingRowWriteSource
                }) {
                    modelContext.delete(pending)
                }
            }
            try modelContext.save()
            AppWriteSyncService.abandonOptimisticTransaction(createIDs.transactionID)
            if let operationID = writeFeedback.retryOperationID {
                SyncStatusStore.shared.dismissFailure(id: operationID)
            }
            writeFeedback.abandonRetry()
            dismiss()
        } catch {
            writeFeedback.failRetryAbandonment(.persistence, operation: "Abandon transaction")
        }
    }

    // MARK: - Save

    /// A refused save plays the error haptic after validation, never on press.
    private func rejectSave(_ message: String) {
        amountValidationMessage = message
        commitHaptic.fire(.error)
    }

    private func saveTransaction() {
        guard let activeMember else {
            rejectSave("Select a valid family profile")
            return
        }
        let ledgerOwner = activeMember.ledgerOwner

        if txType == .btcBuy {
            saveBTCBuy(owner: activeMember)
            return
        }

        let sats = computedSats

        // A Bitcoin-native payment source posts exact sats the user typed —
        // the server debits/credits the literal amount, so a value derived
        // from dollars and a price quote must never be sent. Block the save
        // and say what the form needs (Linux shows the same message shape).
        if isBitcoinNativeMethod {
            guard inputUnit != .usd else {
                rejectSave("\(selectedLabel) posts Bitcoin. Enter the amount in sats.")
                return
            }
            guard sats > 0 else {
                rejectSave("Enter an amount")
                return
            }
            guard let key = bitcoinAccountKey, !key.isEmpty else {
                rejectSave("Choose the Bitcoin account this posts to.")
                return
            }
        } else {
            bitcoinAccountKey = nil
        }

        guard sats != 0 else {
            rejectSave("Enter an amount")
            return
        }

        let isIncome = txType == .income
        let signedSatsDecimal = abs(sats)
        let signedSats = signedSatsDecimal.clampedInt64
        let amountIntent = AddTransactionAmountIntent.make(
            isIncome: isIncome,
            inputUnit: inputUnit,
            typedAmount: numericAmount,
            computedSats: signedSats,
            btcPrice: btcPrice,
        )
        let transactionCategory = selectedCategory.isEmpty ? (isIncome ? "Income" : "Other") : selectedCategory

        let tx = Transaction(
            id: createIDs.transactionID,
            date: Date(),
            merchant: merchant.isEmpty ? (isIncome ? "Income" : "Expense") : merchant,
            amount: amountIntent.amountUSD,
            category: transactionCategory,
            amountSats: amountIntent.amountSats,
            enteredInBitcoin: amountIntent.enteredInBitcoin,
            // Persist the selected option's wire value, not a display string.
            // Fiat card wires persist here in `card` the same way; the sats
            // posting fields above are unchanged (this sheet always computed
            // them from the entry unit).
            card: method,
            bitcoinAccountKey: isBitcoinNativeMethod ? bitcoinAccountKey : nil,
            owner: ledgerOwner,
            createdBy: "app",
        )
        amountValidationMessage = nil
        // The sheet stays open until the write result arrives, and closes only
        // on `.ok`. Dismissing first made every rejection invisible.
        OptimisticSaveFlow.run(
            models: [tx],
            operation: "Transaction",
            in: modelContext,
            feedback: writeFeedback,
            push: { completion in
                AppWriteSyncService.pushTransaction(
                    tx,
                    owner: ledgerOwner,
                    tracksOptimisticCreate: true,
                    onOperationStart: { writeFeedback.bindRetryOperation($0) },
                    onResult: completion,
                )
            },
            resolveResult: {
                OptimisticSaveFlow.resolveCreateResult(
                    $0,
                    acceptedRevision: tx.updatedAtMs,
                )
            },
            afterResult: { [createIDs, dismiss, haptic = $commitHaptic] result in
                haptic.wrappedValue.fire(result.isOk ? .success : .error)
                if createIDs.recordServerResult(result, for: .transaction) { dismiss() }
            },
        )
    }

    private func saveBTCBuy(owner activeMember: FamilyMember) {
        let ledgerOwner = activeMember.ledgerOwner
        let sats = roundedSats(from: abs(computedSats))
        guard sats > 0 else {
            rejectSave("Enter an amount")
            return
        }

        let btc = Decimal(sats) / 100_000_000
        let price = effectiveBTCBuyPrice
        let usd = inputUnit == .usd ? abs(numericAmount) : btc * price
        let source = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = source.isEmpty ? "Bitcoin Buy" : source
        let date = Date()

        let buy = BTCBuy(
            id: createIDs.bitcoinBuyID,
            date: date,
            source: account,
            amountBTC: btc,
            amountSats: sats,
            priceUSD: price,
            usd: usd,
            note: "Logged in app",
            loggedBy: "app",
            owner: ledgerOwner,
        )
        let lot = CostBasisLot(
            lotId: buy.id,
            date: LegacyTransactionDTO.dateString(from: date),
            sats: sats,
            basisUsd: usd,
            label: account,
            owner: ledgerOwner,
        )

        amountValidationMessage = nil
        OptimisticSaveFlow.run(
            models: [buy, lot],
            operation: "Bitcoin buy",
            in: modelContext,
            feedback: writeFeedback,
            push: { completion in
                AppWriteSyncService.pushBTCBuy(
                    buy,
                    owner: ledgerOwner,
                    onOperationStart: { writeFeedback.bindRetryOperation($0) },
                    onResult: completion,
                )
            },
            afterResult: { [createIDs, dismiss, haptic = $commitHaptic] result in
                haptic.wrappedValue.fire(result.isOk ? .success : .error)
                if createIDs.recordServerResult(result, for: .bitcoinBuy) { dismiss() }
            },
        )
    }

    private func roundedSats(from value: Decimal) -> Int64 {
        let handler = NSDecimalNumberHandler(
            roundingMode: .plain,
            scale: 0,
            raiseOnExactness: false,
            raiseOnOverflow: false,
            raiseOnUnderflow: false,
            raiseOnDivideByZero: false,
        )
        return NSDecimalNumber(decimal: value).rounding(accordingToBehavior: handler).int64Value
    }
}

private extension AppLayout {
    static let radiusCompact: CGFloat = 14
}
