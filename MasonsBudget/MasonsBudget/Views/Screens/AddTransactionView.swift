import SwiftUI
import SwiftData

struct AddTransactionView: View {
    @Environment(\.theme) var theme
    @Environment(\.dismiss) var dismiss
    @Environment(\.modelContext) var modelContext
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]

    @State private var txType: TxType = .spend
    @State private var inputUnit: DisplayUnit = .usd
    @State private var amount = ""
    @State private var selectedCategory = ""
    @State private var method: String = "Lightning"
    @State private var merchant = ""

    private var btcPrice: Decimal { BTCPriceService.storedPrice ?? AppTheme.fallbackBTCPrice }
    private var activeMember: FamilyMember { FamilyMember(rawValue: selectedMemberRaw) ?? .victor }

    enum TxType: String, CaseIterable {
        case spend = "Spend"
        case income = "Income"
        case transfer = "Transfer"
    }

    private var numericAmount: Decimal {
        let cleaned = amount
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: "₿", with: "")
        return Decimal(string: cleaned) ?? 0
    }

    private var computedSats: Decimal {
        switch inputUnit {
        case .sats: return numericAmount
        case .btc: return numericAmount * 100_000_000
        case .usd: return btcPrice > 0 ? (numericAmount / btcPrice) * 100_000_000 : 0
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                typeSegment
                    .padding(.horizontal, AppLayout.sectionPadding)
                    .padding(.top, 12)

                Spacer()

                amountSection

                Spacer()

                fieldsCard
                    .padding(.horizontal, AppLayout.sectionPadding)

                numPad
                    .padding(.top, 8)
            }
            .background(theme.bg)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(theme.accent)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveTransaction() }
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(theme.accent)
                }
            }
            .navigationTitle("New transaction")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
        }
    }

    // MARK: - Type Segment

    private var typeSegment: some View {
        HStack(spacing: 0) {
            ForEach(TxType.allCases, id: \.self) { t in
                Button { txType = t } label: {
                    Text(t.rawValue)
                        .font(.system(size: 13, weight: .semibold))
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
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(theme.accent)

            unitSelector

            HStack(spacing: 8) {
                if txType == .spend {
                    Text("\u{2212}")
                        .font(.system(size: 56, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.textFaint)
                }
                Text("\(inputUnit.prefix)\(amount.isEmpty ? "0" : amount)")
                    .font(.system(size: 56, weight: .bold, design: .monospaced))
                    .tracking(-1.68)
                    .foregroundStyle(theme.text)
                if inputUnit != .usd {
                    Text(inputUnit.label)
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .foregroundStyle(theme.textMuted)
                }
            }

            conversionLine
        }
        .padding(.horizontal, AppLayout.sectionPadding)
    }

    private var unitSelector: some View {
        HStack(spacing: 0) {
            ForEach(DisplayUnit.allCases) { u in
                Button { switchUnit(to: u) } label: {
                    Text(u.label)
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.44)
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
        let usd = btc * btcPrice

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
        .font(.system(size: 13))
        .foregroundStyle(theme.textFaint)
    }

    private func switchUnit(to newUnit: DisplayUnit) {
        guard newUnit != inputUnit else { return }
        let sats = computedSats
        switch newUnit {
        case .sats: amount = AppFormatter.formatSats(sats)
        case .btc: amount = AppFormatter.formatBtc(sats / 100_000_000)
        case .usd: amount = AppFormatter.formatCurrency(sats / 100_000_000 * btcPrice)
        }
        inputUnit = newUnit
    }

    // MARK: - Fields Card

    private var fieldsCard: some View {
        VStack(spacing: 0) {
            fieldRow(label: "Category") {
                Menu {
                    ForEach(categories.filter { !$0.isIncome }, id: \.name) { cat in
                        Button {
                            selectedCategory = cat.name
                        } label: {
                            Label(cat.name, systemImage: cat.icon)
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if !selectedCategory.isEmpty {
                            let cat = categories.first(where: { $0.name == selectedCategory })
                            CatGlyphView(kind: cat?.icon ?? "wrench", size: 11, color: .white)
                                .frame(width: 18, height: 18)
                                .background(theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                        }
                        Text(selectedCategory.isEmpty ? "Select" : selectedCategory)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(selectedCategory.isEmpty ? theme.textFaint : theme.text)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 12))
                            .foregroundStyle(theme.textFaint)
                    }
                }
            }

            Hairline()

            fieldRow(label: "Method") {
                HStack(spacing: 6) {
                    methodChip("Lightning", icon: "bolt.fill")
                    methodChip("On-chain", icon: "link")
                    Spacer()
                }
            }

            Hairline()

            fieldRow(label: "Merchant") {
                TextField("Where?", text: $merchant)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
            }
        }
        .glassCard(padding: 0, radius: AppLayout.radiusCompact)
    }

    private func fieldRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(theme.textMuted)
                .frame(width: 88, alignment: .leading)
            content()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func methodChip(_ name: String, icon: String) -> some View {
        let isSelected = method == name
        return Button { method = name } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                Text(name)
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(isSelected ? theme.accent : theme.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(isSelected ? theme.accentSoft : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? theme.accent : theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Number Pad

    private var numPad: some View {
        VStack(spacing: 0) {
            ForEach([["1","2","3"],["4","5","6"],["7","8","9"],[".","0","⌫"]], id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(row, id: \.self) { key in
                        Button {
                            handleKey(key)
                        } label: {
                            Text(key)
                                .font(.system(size: 26, weight: .medium))
                                .foregroundStyle(theme.text)
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }

    private func handleKey(_ key: String) {
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

    // MARK: - Save

    private func saveTransaction() {
        let sats = computedSats
        guard sats != 0 else { return }

        let signedSatsDecimal = txType == .spend ? -abs(sats) : abs(sats)
        let signedSats = Int64(truncating: signedSatsDecimal as NSNumber)
        let signedUsd = (Decimal(signedSats) / 100_000_000) * btcPrice

        let tx = Transaction(
            id: UUID().uuidString,
            date: Date(),
            merchant: merchant.isEmpty ? (txType == .income ? "Income" : "Expense") : merchant,
            amount: signedUsd,
            category: selectedCategory.isEmpty ? "Other" : selectedCategory,
            amountSats: signedSats,
            card: method == "Lightning" ? "lightning" : "on-chain",
            owner: activeMember,
            createdBy: "app"
        )
        modelContext.insert(tx)
        try? modelContext.save()
        AppWriteSyncService.pushTransaction(tx, owner: activeMember)
        dismiss()
    }
}

private extension AppLayout {
    static let radiusCompact: CGFloat = 14
}
