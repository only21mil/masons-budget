import SwiftUI
import SwiftData

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \BudgetCategory.sortOrder) private var categories: [BudgetCategory]
    @State private var amountText = ""
    @State private var merchant = ""
    @State private var selectedCategory = ""
    @State private var card = "Strike"
    @State private var note = ""

    private let cards = ["Strike", "River", ""]

    var onSave: (Decimal, String, String, String?, String?) -> Void

    private var displayAmount: String {
        if amountText.isEmpty { return "$0" }
        if let value = Decimal(string: amountText) {
            return formatCurrency(value)
        }
        return "$\(amountText)"
    }

    private var canSave: Bool {
        guard let amount = Decimal(string: amountText), amount > 0 else { return false }
        return !merchant.isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                amountSection
                fieldsCard
                numberPad
            }
            .background(AppTheme.background)
            .navigationTitle("New Transaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AppTheme.accentColor)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .fontWeight(.bold)
                        .foregroundStyle(canSave ? AppTheme.accentColor : AppTheme.tertiaryText)
                        .disabled(!canSave)
                }
            }
            .onAppear {
                if selectedCategory.isEmpty {
                    selectedCategory = categories.first?.name ?? "Other"
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Amount

    private var amountSection: some View {
        VStack(spacing: 8) {
            Text("AMOUNT")
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(AppTheme.accentColor)

            Text(displayAmount)
                .font(.system(size: 56, weight: .bold, design: .monospaced))
                .foregroundStyle(AppTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    // MARK: - Fields

    private var fieldsCard: some View {
        VStack(spacing: 0) {
            fieldRow(label: "Merchant") {
                TextField("Where?", text: $merchant)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText)
                    #if os(iOS)
                    .textInputAutocapitalization(.words)
                    #endif
            }

            Divider().background(AppTheme.cardBorder)

            fieldRow(label: "Category") {
                Picker("", selection: $selectedCategory) {
                    if categories.isEmpty {
                        Text("Other").tag("Other")
                    }
                    ForEach(categories.filter { !$0.isIncome }, id: \.name) { cat in
                        Label {
                            Text(cat.name)
                        } icon: {
                            Text(cat.icon)
                        }
                        .tag(cat.name)
                    }
                }
                .labelsHidden()
                .tint(AppTheme.primaryText)
            }

            Divider().background(AppTheme.cardBorder)

            fieldRow(label: "Card") {
                HStack(spacing: 6) {
                    ForEach(cards.filter { !$0.isEmpty }, id: \.self) { c in
                        Button {
                            card = card == c ? "" : c
                        } label: {
                            Text(c)
                                .font(.system(size: 12, weight: .semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(card == c ? AppTheme.accentSoft : AppTheme.surface2)
                                .foregroundStyle(card == c ? AppTheme.accentColor : AppTheme.secondaryText)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .strokeBorder(card == c ? AppTheme.accentColor : AppTheme.cardBorder, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                }
            }

            Divider().background(AppTheme.cardBorder)

            fieldRow(label: "Note") {
                TextField("Optional", text: $note)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.primaryText)
            }
        }
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
        )
        .padding(.horizontal, AppTheme.horizontalPadding)
    }

    private func fieldRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.secondaryText)
                .frame(width: 80, alignment: .leading)
            content()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: - Number Pad

    private var numberPad: some View {
        #if os(iOS)
        VStack(spacing: 0) {
            ForEach([["1","2","3"],["4","5","6"],["7","8","9"],[".","0","⌫"]], id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(row, id: \.self) { key in
                        Button {
                            handleKey(key)
                        } label: {
                            Text(key)
                                .font(.system(size: 26, weight: .medium))
                                .foregroundStyle(AppTheme.primaryText)
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
        #else
        HStack {
            Text("Amount")
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.secondaryText)
                .frame(width: 80, alignment: .leading)
            TextField("0.00", text: $amountText)
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .foregroundStyle(AppTheme.primaryText)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
        )
        .padding(.horizontal, AppTheme.horizontalPadding)
        .padding(.top, 8)
        #endif
    }

    private func handleKey(_ key: String) {
        switch key {
        case "⌫":
            if !amountText.isEmpty {
                amountText.removeLast()
            }
        case ".":
            if !amountText.contains(".") {
                amountText += amountText.isEmpty ? "0." : "."
            }
        default:
            if amountText.contains(".") {
                let parts = amountText.split(separator: ".", maxSplits: 1)
                if parts.count > 1 && parts[1].count >= 2 { return }
            }
            amountText += key
        }
    }

    private func save() {
        guard let amount = Decimal(string: amountText), !merchant.isEmpty else { return }
        let cat = selectedCategory.isEmpty ? (categories.first?.name ?? "Other") : selectedCategory
        onSave(amount, merchant, cat, card.isEmpty ? nil : card, note.isEmpty ? nil : note)
        dismiss()
    }
}
