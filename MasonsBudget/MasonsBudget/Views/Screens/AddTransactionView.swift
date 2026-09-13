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
    @Environment(\.ledgerTokens) private var ledgerTokens
    @ScaledMetric(relativeTo: .body) private var padRowHeight = 56.0
    @ScaledMetric(relativeTo: .body) private var labelWidth = 88.0
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
    @State private var note = ""
    @State private var extraOptionsOpen = false
    @Query(sort: \Transaction.date, order: .reverse) private var history: [Transaction]
    private enum EntryField: Hashable { case merchant, price, note }
    @FocusState private var focusedField: EntryField?
    @State private var btcBuyPrice = ""
    @State private var amountValidationMessage: String?
    @State private var commitHaptic = LedgerHapticTrigger()
    /// Holds the in-flight write and its cause-specific rejection message. The
    /// sheet stays open until the write is accepted.
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @State private var incomeID = UUID().uuidString
    @State private var incomeDate = Date()
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

        _categories = Query(
            filter: BudgetCategory.predicate(for: FamilyMember(rawValue: storedOwner)),
            sort: [SortDescriptor(\BudgetCategory.sortOrder)],
        )
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
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 20) {
                        typeSegment
                        amountSection.id("amount")
                            .onTapGesture { focusedField = nil }
                        fieldsCard.id("fields")
                    }
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.vertical, 12)
                    .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
                }
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 8) {
                        if let inlineMessage {
                            Text(inlineMessage).ledgerType(.body).foregroundStyle(theme.danger)
                                .accessibilityIdentifier("entry.validation")
                        }
                        saveButton
                        if focusedField == nil {
                            numPad.disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
                        }
                    }
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.top, 8)
                    .background(theme.bg)
                }
                .onChange(of: amountValidationMessage) { _, message in
                    if message != nil { proxy.scrollTo(focusedField == nil ? "amount" : "fields", anchor: .top) }
                }
            }
            .background(theme.bg)
            .ledgerHaptics(commitHaptic)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(writeFeedback.isRetryPending ? "Abandon" : "Cancel") { cancelSheet() }
                        .foregroundStyle(theme.accent)
                        .disabled(writeFeedback.isSaving)
                }
            }
            .navigationTitle("New transaction")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .interactiveDismissDisabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
        .onAppear { restoreDefaults() }
        .onChange(of: method) { _, _ in restoreDefaults() }
        .onChange(of: selectedMemberRaw) { _, _ in restoreDefaults() }
    }

    private var saveButton: some View {
        Button(writeFeedback.isSaving ? "Saving…" : (writeFeedback.isRetryPending ? "Retry pending" : "Save")) {
            saveTransaction()
        }
        .ledgerType(.button)
        .frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(theme.onAccent)
        .background(theme.accentFill)
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .buttonStyle(.plain)
        .disabled(writeFeedback.isSaving || writeFeedback.isRetryPending)
        .accessibilityIdentifier("entry.save.pinned")
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
        }
        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
    }

    private var unitSelector: some View {
        HStack(spacing: 0) {
            ForEach(DisplayUnit.allCases) { u in
                Button { switchUnit(to: u) } label: {
                    Text(u.label)
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(inputUnit == u ? theme.onAccent : theme.textMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(inputUnit == u ? theme.accentFill : Color.clear)
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
                    TextField("USD per BTC", text: $btcBuyPrice)
                        .focused($focusedField, equals: .price)
                        .submitLabel(.done).onSubmit { focusedField = nil }
                }
            }
            fieldRow(label: txType == .income ? "Source" : txType == .btcBuy ? "Account" : "Merchant") {
                TextField(txType == .income ? "Employer or source" : txType == .btcBuy ? "Strike, River…" : "Where?", text: $merchant)
                    .ledgerType(.rowPrimary)
                    .focused($focusedField, equals: .merchant)
                    .submitLabel(.done).onSubmit { focusedField = nil }
                    .accessibilityIdentifier("entry.merchant")
            }
            if txType == .spend {
                Hairline()
                fieldRow(label: "Category") {
                    Menu {
                        ForEach(scopedCategories.filter { !$0.isIncome }, id: \.name) { category in
                            Button(category.displayName) { selectedCategory = category.displayName }
                        }
                    } label: {
                        Text(selectedCategory.isEmpty ? "Select" : selectedCategory)
                            .ledgerType(.rowPrimary).frame(minHeight: 44)
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 8)], alignment: .leading, spacing: 4) {
                    ForEach(frequentCategories, id: \.name) { category in
                        Button(category.displayName) { selectedCategory = category.displayName }
                            .ledgerType(.chip)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(selectedCategory == category.displayName ? theme.onAccent : theme.accent)
                            .background(selectedCategory == category.displayName ? theme.accentFill : theme.accentSoft)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                            .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)
            }
            Hairline()
            DatePicker(Calendar.current.isDateInToday(incomeDate) ? "Today" : "Date", selection: $incomeDate, displayedComponents: .date)
                .datePickerStyle(.compact)
                .ledgerType(.rowPrimary)
                .padding(14)
                .accessibilityIdentifier("entry.date")
            if txType == .spend {
                DisclosureGroup("More options", isExpanded: $extraOptionsOpen) {
                    fieldRow(label: "Method") {
                        Picker("Method", selection: $method) {
                            ForEach(pickerOptions) { option in Text(option.label).tag(option.wire) }
                        }
                        .labelsHidden()
                    }
                    noteField
                }
                .ledgerType(.rowPrimary).padding(14)
                if isBitcoinNativeMethod { accountField }
            } else { noteField }
        }
        .foregroundStyle(theme.text)
        .glassCard(padding: 0, radius: AppLayout.radiusCompact)
    }

    private var noteField: some View {
        fieldRow(label: "Note") {
            TextField("Optional", text: $note)
                .focused($focusedField, equals: .note)
                .submitLabel(.done).onSubmit { focusedField = nil }
        }
    }
    private var accountField: some View {
        fieldRow(label: "Account") {
            Menu {
                ForEach(adultBtcAccounts, id: \.key) { account in
                    Button(account.label) { bitcoinAccountKey = account.key }
                }
            } label: {
                Text(bitcoinAccountLabel).ledgerType(.rowPrimary).frame(minHeight: 44)
            }
        }
    }
    private var frequentCategories: [BudgetCategory] {
        guard let member = activeMember else { return [] }
        let rows = history.filter { member.sharesNetWorth(with: $0.ownerMember) && $0.isSpend }
        let counts = Dictionary(uniqueKeysWithValues: scopedCategories.map { category in
            (category.name, rows.count(where: { category.matches($0) }))
        })
        return Array(scopedCategories.filter { !$0.isIncome }.sorted {
            let left = counts[$0.name, default: 0]
            let right = counts[$1.name, default: 0]
            return left == right ? $0.sortOrder < $1.sortOrder : left > right
        }.prefix(4))
    }
    private func restoreDefaults() {
        guard let member = activeMember else { selectedCategory = ""; merchant = ""; return }
        let defaults = EntryFormDefaults.load(owner: member.ledgerOwner, method: method)
        selectedCategory = scopedCategories.contains { $0.name == defaults.category || $0.displayName == defaults.category } ? defaults.category : ""
        merchant = defaults.merchant
    }
    private func fieldRow(label: String, @ViewBuilder content: () -> some View) -> some View {
        HStack {
            Text(label)
                .ledgerType(.rowPrimary)
                .foregroundStyle(theme.textMuted)
                .frame(width: labelWidth, alignment: .leading)
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
                                .ledgerType(.amountInput)
                                .foregroundStyle(theme.text)
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: max(LedgerMetrics.minimumHitTarget, padRowHeight))
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
        if message.localizedCaseInsensitiveContains("source") || message.localizedCaseInsensitiveContains("merchant") {
            focusedField = .merchant
        } else {
            focusedField = nil
        }
        if message.localizedCaseInsensitiveContains("account") { extraOptionsOpen = true }
        commitHaptic.fire(.error)
    }

    private func saveTransaction() {
        guard !writeFeedback.isSaving, !writeFeedback.isRetryPending else { return }
        guard let activeMember else {
            rejectSave("Select a valid family profile")
            return
        }
        let ledgerOwner = activeMember.ledgerOwner
        let savedDefaults = EntryFormDefaults(category: selectedCategory, merchant: merchant)
        let defaultsMethod = method

        if txType == .income {
            saveIncome(member: activeMember)
            return
        }

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
            date: incomeDate,
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
            note: note.isEmpty ? nil : note,
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
                if createIDs.recordServerResult(result, for: .transaction) { savedDefaults.save(owner: ledgerOwner, method: defaultsMethod); dismiss() }
            },
        )
    }

    private func saveIncome(member: FamilyMember) {
        let savedDefaults = EntryFormDefaults(category: selectedCategory, merchant: merchant)
        let defaultsMethod = method
        let amountUSD = inputUnit == .usd ? numericAmount : computedSats / 100_000_000 * conversionBTCPrice
        guard amountUSD > 0 else {
            rejectSave("Enter an amount")
            return
        }
        let source = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else {
            rejectSave("Enter the income source")
            return
        }
        writeFeedback.begin()
        AppWriteSyncService.pushIncome(
            id: incomeID, date: incomeDate, amount: amountUSD, source: source, note: note.isEmpty ? nil : note, member: member,
        ) { [writeFeedback, canonicalFinancials, dismiss] result in
            if result.isOk {
                _ = writeFeedback.finish(result, operation: "Income")
                canonicalFinancials.requestReload()
                savedDefaults.save(owner: member.ledgerOwner, method: defaultsMethod)
                dismiss()
            } else {
                // Income has no optimistic transaction or background retry owner.
                // Keep this draft and its ID so the user can safely retry.
                writeFeedback.reject(result.userMessage(operation: "Income") ?? "Income could not be saved.")
            }
        }
    }

    private func saveBTCBuy(owner activeMember: FamilyMember) {
        let ledgerOwner = activeMember.ledgerOwner
        let savedDefaults = EntryFormDefaults(category: selectedCategory, merchant: merchant)
        let defaultsMethod = method
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
        let date = incomeDate

        let buy = BTCBuy(
            id: createIDs.bitcoinBuyID,
            date: date,
            source: account,
            amountBTC: btc,
            amountSats: sats,
            priceUSD: price,
            usd: usd,
            note: note.isEmpty ? "Logged in app" : note,
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
                if createIDs.recordServerResult(result, for: .bitcoinBuy) { savedDefaults.save(owner: ledgerOwner, method: defaultsMethod); dismiss() }
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

struct EntryFormDefaults: Codable, Equatable {
    var category = ""
    var merchant = ""

    static func key(owner: FamilyMember, method: String) -> String {
        "entry_defaults_v1.\(owner.ledgerOwner.rawValue).\(method)"
    }
    static func load(owner: FamilyMember, method: String, store: UserDefaults = .standard) -> Self {
        guard let data = store.data(forKey: key(owner: owner, method: method)),
              let value = try? JSONDecoder().decode(Self.self, from: data)
        else { return Self() }
        return value
    }
    func save(owner: FamilyMember, method: String, store: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        store.set(data, forKey: Self.key(owner: owner, method: method))
    }
}
