import SwiftUI

struct TransactionRow: View {
    let merchant: String
    let amount: Decimal
    let category: String
    let date: Date
    var card: String? = nil

    var body: some View {
        HStack {
            merchantMark
            VStack(alignment: .leading, spacing: 2) {
                Text(merchant)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.primaryText)
                Text(date.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formatCurrency(amount))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.negative)
                HStack(spacing: 4) {
                    Text(category)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.secondaryText)
                    if let card {
                        Text(card)
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundStyle(AppTheme.accentColor)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(AppTheme.warmGlow)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.04), lineWidth: 1)
        )
    }

    private var merchantMark: some View {
        Text(String(merchant.prefix(1)).uppercased())
            .font(.system(size: 13, weight: .bold, design: .rounded))
            .foregroundStyle(AppTheme.accentColor)
            .frame(width: 32, height: 32)
            .background(AppTheme.warmGlow)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

#Preview {
    VStack(spacing: 8) {
        TransactionRow(merchant: "Costco", amount: 142.37, category: "Groceries", date: .now, card: "Aven")
        TransactionRow(merchant: "Shell Gas", amount: 54.20, category: "Auto", date: .now)
        TransactionRow(merchant: "Netflix", amount: 15.99, category: "Bills", date: .now, card: "Strike")
    }
    .padding()
    .background(AppTheme.background)
}
