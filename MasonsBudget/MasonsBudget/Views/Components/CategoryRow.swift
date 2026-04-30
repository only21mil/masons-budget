import SwiftUI

struct CategoryRow: View {
    let name: String
    let icon: String
    let spent: Decimal
    let budget: Decimal

    private var pct: Double {
        budget > 0 ? Double(truncating: (spent / budget) as NSNumber) : 0
    }

    private var barColor: LinearGradient {
        if pct > 1.0 {
            return LinearGradient(colors: [AppTheme.negative, AppTheme.negative.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
        } else if pct > 0.85 {
            return LinearGradient(colors: [AppTheme.warning, AppTheme.warning.opacity(0.6)], startPoint: .leading, endPoint: .trailing)
        }
        return LinearGradient(colors: [AppTheme.accentColor, AppTheme.accentColor.opacity(0.5)], startPoint: .leading, endPoint: .trailing)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(icon) \(name)")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.primaryText)
                Spacer()
                Text("\(formatCurrency(spent)) / \(formatCurrency(budget))")
                    .font(.caption)
                    .foregroundStyle(pct > 1.0 ? AppTheme.negative : AppTheme.secondaryText)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(AppTheme.background)
                        .frame(height: 7)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(barColor)
                        .frame(width: max(0, min(geo.size.width, CGFloat(pct) * geo.size.width)), height: 7)
                }
            }
            .frame(height: 7)
        }
        .glassCard()
    }
}

#Preview {
    VStack(spacing: 12) {
        CategoryRow(name: "Groceries", icon: "🛒", spent: 340, budget: 500)
        CategoryRow(name: "Dining & Drinks", icon: "🍔", spent: 480, budget: 400)
        CategoryRow(name: "Auto & Transport", icon: "🚗", spent: 170, budget: 200)
    }
    .padding()
    .background(AppTheme.background)
}
