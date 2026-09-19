import SwiftData
import SwiftUI

struct BTCBillPayView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BTCBillPay.date, order: .reverse) private var allBillPays: [BTCBillPay]
    @State private var showCompose = false
    @State private var selectedBillPay: BTCBillPay?
    @State private var writeMessage: String?
    @State private var isDeleting = false
    @Environment(\.modelContext) private var modelContext

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
                    if activeMember.isAdult {
                        Button("COMPOSE") { showCompose = true }
                            .disabled(!AppWritebackConfig.canWriteBitcoin)
                            .ledgerType(.button)
                            .foregroundStyle(theme.accent)
                            .buttonStyle(.plain)
                    }
                }

                if activeMember.isAdult { DeviceWriteSetupPrompt().padding(.horizontal, ledgerTokens.metrics.screenGutter) }
                if let writeMessage { Text(writeMessage).foregroundStyle(theme.warn) }
                summaryCard
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.bottom, AppLayout.cardSpacing)

                if visibleBillPays.isEmpty && activeMember.isAdult {
                    Button("Record a bill payment") { showCompose = true }.disabled(!AppWritebackConfig.canWriteBitcoin).padding(ledgerTokens.metrics.screenGutter)
                }
                ForEach(grouped, id: \.0) { month, billPays in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(month.uppercased())
                            .ledgerType(.sectionLabel)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(billPays.enumerated()), id: \.element.id) { idx, bp in
                                Button { selectedBillPay = bp } label: { billPayRow(bp) }
                                    .buttonStyle(.plain)
                                    .disabled(isDeleting)
                                    .ledgerRowReveal(index: idx)
                                if idx < billPays.count - 1 {
                                    Hairline(indent: 56)
                                }
                            }
                        }
                        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    }
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
        .confirmationDialog("Delete bill payment?", isPresented: Binding(
            get: { selectedBillPay != nil }, set: { if !$0 { selectedBillPay = nil } }
        ), titleVisibility: .visible) {
            if let billPay = selectedBillPay {
                Button("Delete \(billPay.merchant)", role: .destructive) {
                    isDeleting = true
                    AppWriteSyncService.deleteBitcoinEntry(.billPay, id: billPay.id, owner: billPay.ownerMember,
                                                           baseUpdatedAtMs: billPay.updatedAtMs) { result in
                        isDeleting = false
                        if result.isOk {
                            modelContext.delete(billPay)
                            do { try modelContext.save() }
                            catch { writeMessage = "Deleted online. Refresh to update this device." }
                        } else { writeMessage = result.userMessage(operation: "Delete bill payment") }
                    }
                }
            }
        }
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
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(theme.bg)
                    AmountView(sats: totalSats, unit: unit, role: .kpiValue, color: theme.bg, btcPrice: btcPrice)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("BTC SPENT")
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(theme.bg)
                    AmountView(sats: Decimal(ledger.totalSpentSats), unit: unit, role: .kpiValue, color: theme.bg, btcPrice: btcPrice)
                }
            }
            .padding(20)
            // Plum card, page-colour ink: 0A0D0C on light plum is only 3.1:1,
            // F4F3EE on the light plum clears 5.7:1 and 0A0D0C on the dark plum 8.9:1.
            .background(theme.plum)
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
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Text("\(bp.date.formatted(.dateTime.month(.abbreviated).day())) · \(bp.platform)")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                AmountView(sats: btcPrice > 0 ? (bp.amountUSD / btcPrice) * 100_000_000 : 0, unit: unit, role: .rowFigure, btcPrice: btcPrice)
                AmountView(sats: bp.btcSpent * 100_000_000, unit: unit, role: .rowFigure, color: theme.textMuted, btcPrice: btcPrice)
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
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \BudgetCategory.sortOrder) private var budgetCategories: [BudgetCategory]
    @State private var note = ""
    @State private var reference = ""
    @State private var merchant = ""
    @State private var amount = ""
    @State private var fee = ""
    @State private var effect: BTCBillPayBudgetEffect = .budgetCategory
    @State private var category = ""
    @State private var sats = ""
    @State private var price = ""
    @State private var date = LedgerClock.now
    @State private var id = UUID().uuidString
    @State private var isSaving = false
    @State private var writeMessage: String?
    @AppStorage("selected_family_member") private var memberRaw = FamilyMember.victor.rawValue

    private var householdCategories: [String] {
        let member = FamilyMember(rawValue: memberRaw) ?? .victor
        return budgetCategories.filter { $0.ownerMember.isAdult && member.canSee(dataOwnedBy: $0.ownerMember) }
            .map { LedgerMapper.wireBudgetCategoryName(from: $0.name, owner: $0.ownerMember) }
    }

    private var parsedPrice: Decimal { Decimal(string: price, locale: Locale(identifier: "en_US_POSIX")) ?? 0 }
    private var canSave: Bool {
        AppWritebackConfig.canWriteBitcoin && !isSaving && (FamilyMember(rawValue: memberRaw)?.isAdult == true) &&
            !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && parsedAmount > 0 &&
            (try? ConvexClient.exactMinorUnits(parsedAmount, field: "billPay.amount")) != nil &&
            (Int64(sats) ?? 0) > 0 && parsedPrice > 0 &&
            (try? ConvexClient.exactMinorUnits(parsedPrice, field: "billPay.price")) != nil &&
            exactFee != nil && (exactFee ?? -1) >= 0 &&
            (try? ConvexClient.exactMinorUnits(exactFee ?? -1, field: "billPay.fee")) != nil &&
            (effect == .creditCardPayment || householdCategories.contains(category))
    }

    private var receiptHint: String? {
        guard let satsValue = Int64(sats), satsValue > 0, parsedPrice > 0, parsedAmount > 0 else { return nil }
        let receiptValue = Decimal(satsValue) / 100_000_000 * parsedPrice
        let difference = receiptValue - parsedAmount
        guard (difference < 0 ? -difference : difference) > parsedAmount / 100 else { return nil }
        return "Sats × price is \(AppFormatter.formatCurrency(receiptValue)), not \(AppFormatter.formatCurrency(parsedAmount)). Check the receipt."
    }

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
                    ScreenHeader(title: "Record a bill pay", eyebrow: "Already paid through River")
                    DeviceWriteSetupPrompt()
                        .ledgerType(.button)
                        .tint(theme.accent)
                    Text("Record a payment you made in River. Enter the exact sats and fee from its receipt.")
                        .ledgerType(.rowMeta).padding(.horizontal, ledgerTokens.metrics.screenGutter)

                    VStack(spacing: 0) {
                        HStack {
                            Text("DATE").ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
                            Spacer()
                            DatePicker("Date", selection: $date, displayedComponents: .date)
                                .labelsHidden()
                                .tint(theme.accent)
                        }
                        .padding(14)
                        Hairline()
                        composeField("MERCHANT", prompt: "Payee", text: $merchant)
                        Hairline()
                        HStack {
                            Text("BUDGET").ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
                            Spacer()
                            Menu {
                                Picker("Budget effect", selection: $effect) {
                                    Text("Budget category").tag(BTCBillPayBudgetEffect.budgetCategory)
                                    Text("Credit card payment").tag(BTCBillPayBudgetEffect.creditCardPayment)
                                }
                                .pickerStyle(.inline)
                            } label: {
                                pickerLabel(effect == .budgetCategory ? "Budget category" : "Credit card payment")
                            }
                            .buttonStyle(.plain)
                            .menuIndicator(.hidden)
                            .tint(theme.accent)
                            .accessibilityLabel("Budget effect")
                            .accessibilityValue(effect == .budgetCategory ? "Budget category" : "Credit card payment")
                        }.padding(14)
                        if effect == .budgetCategory {
                            Hairline()
                            HStack {
                                Text("CATEGORY").ledgerType(.kpiLabel).foregroundStyle(theme.textMuted)
                                Spacer()
                                Menu {
                                    Picker("Category", selection: $category) {
                                        Text("Select category").tag("")
                                        ForEach(householdCategories, id: \.self) { Text($0).tag($0) }
                                    }
                                    .pickerStyle(.inline)
                                } label: {
                                    pickerLabel(category.isEmpty ? "Select category" : category)
                                }
                                .buttonStyle(.plain)
                                .menuIndicator(.hidden)
                                .tint(theme.accent)
                                .accessibilityLabel("Category")
                                .accessibilityValue(category.isEmpty ? "Select category" : category)
                            }.padding(14)
                        }
                        Hairline()
                        composeField("AMOUNT USD", prompt: "$0.00", text: $amount)
                        Hairline()
                        composeField("SATS SPENT", prompt: "Exact sats spent", text: $sats)
                        Hairline()
                        composeField("BTC PRICE USD", prompt: "Receipt price", text: $price)
                        Hairline()
                        composeField("FEE USD", prompt: "Enter exact fee", text: $fee)
                        if parsedFee == nil {
                            Text("Enter the fee River charged, or 0.").ledgerType(.rowMeta).foregroundStyle(theme.warn).padding(.horizontal, 14)
                        }
                        Text(RiverBillPayFeePolicy.guidance).ledgerType(.rowMeta).foregroundStyle(theme.textMuted).padding(14)
                        DisclosureGroup("Note and reference") {
                            composeField("NOTE", prompt: "Optional", text: $note)
                            composeField("REFERENCE", prompt: "Optional", text: $reference)
                        }
                        .ledgerType(.button)
                        .tint(theme.accent)
                        .padding(14)
                    }
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    if let receiptHint { Text(receiptHint).ledgerType(.rowMeta).foregroundStyle(theme.warn).padding(.horizontal, ledgerTokens.metrics.screenGutter) }
                    if let writeMessage { Text(writeMessage).foregroundStyle(theme.warn) }
                }
                .padding(.bottom, 100)
            }
            .background(theme.bg)
            .disabled(isSaving)
            #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
            #endif
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Button("Cancel") { dismiss() }
                        .ledgerType(.button)
                        .tint(theme.accent)
                        .frame(minHeight: LedgerMetrics.minimumHitTarget)
                        .disabled(isSaving)
                    Spacer()
                    Button(isSaving ? "Saving" : "Save bill payment", action: save)
                        .ledgerType(.button)
                        .buttonStyle(.borderedProminent)
                        .tint(theme.accentFill)
                        .foregroundStyle(canSave ? theme.onAccent : theme.textFaint)
                        .frame(minHeight: LedgerMetrics.minimumHitTarget)
                        .disabled(!canSave)
                }
                .padding(ledgerTokens.metrics.screenGutter).background(theme.surface)
            }
            .interactiveDismissDisabled(isSaving)
        }
        // This sheet owns its header rather than inheriting the presenting tab's title.
        .environment(\.ledgerRootTitle, nil)
        .environment(\.ledgerRootAccessory, nil)
    }

    private func pickerLabel(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title).ledgerType(.button)
            Image(systemName: "chevron.up.chevron.down").font(AppFont.icon(size: 12))
        }
        .foregroundStyle(theme.accent)
        .frame(minHeight: LedgerMetrics.minimumHitTarget)
    }

    private func save() {
        guard canSave, let satsValue = Int64(sats), let feeValue = exactFee,
              let priceValue = Decimal(string: price, locale: Locale(identifier: "en_US_POSIX")) else { return }
        isSaving = true
        writeMessage = nil
        AppWriteSyncService.pushBillPay(id: id, date: date, merchant: merchant, category: category,
                                        effect: effect, amount: parsedAmount, sats: satsValue, price: priceValue,
                                        fee: feeValue, member: FamilyMember(rawValue: memberRaw) ?? .victor, note: note, reference: reference) { result in
            isSaving = false
            if result.isOk { dismiss() } else { writeMessage = result.userMessage(operation: "Bill payment") }
        }
    }

    private func composeField(_ label: String, prompt: String, text: Binding<String>) -> some View {
        HStack {
            Text(label)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            TextField(prompt, text: text)
                .ledgerType(.rowFigure)
                .multilineTextAlignment(.trailing)
        }
        .padding(14)
    }
}
