import SwiftUI

struct StatCard: View {
    let title: String
    let value: String
    let subtitle: String
    let icon: String
    var style: Style = .standard

    enum Style { case standard, hero }

    var body: some View {
        HStack(spacing: 14) {
            iconView
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(style == .hero ? AppTheme.primaryText.opacity(0.7) : AppTheme.secondaryText)
                    .textCase(.uppercase)
                    .tracking(0.5)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Text(value)
                    .font(style == .hero ? .system(size: 32, weight: .bold, design: .rounded) : .title2.weight(.bold))
                    .foregroundStyle(AppTheme.primaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                    .allowsTightening(true)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.tertiaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .layoutPriority(1)
            Spacer()
        }
        .glassCard(highlight: style == .hero)
        .overlay(alignment: .topTrailing) {
            if style == .hero {
                Circle()
                    .fill(AppTheme.accentColor.opacity(0.06))
                    .frame(width: 120, height: 120)
                    .offset(x: 30, y: -30)
                    .clipped()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
    }

    private var iconView: some View {
        Image(systemName: icon)
            .font(style == .hero ? .title3 : .body)
            .foregroundStyle(style == .hero ? .white : AppTheme.accentColor)
            .frame(width: style == .hero ? 44 : 36, height: style == .hero ? 44 : 36)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(style == .hero ? AppTheme.accentGradient : LinearGradient(colors: [AppTheme.warmGlow], startPoint: .top, endPoint: .bottom))
            )
    }
}

#Preview {
    VStack(spacing: 14) {
        StatCard(title: "Net Worth", value: "$1,234,567", subtitle: "BTC + 401k + WAP", icon: "chart.line.uptrend.xyaxis", style: .hero)
        StatCard(title: "Bitcoin Stack", value: "4.578 BTC", subtitle: "$328,831", icon: "bitcoinsign.circle")
    }
    .padding()
    .background(AppTheme.background)
}
