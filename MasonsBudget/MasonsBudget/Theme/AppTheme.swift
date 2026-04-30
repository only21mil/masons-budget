import SwiftUI

enum AppTheme {
    static let accentColor = Color(hex: 0xF7931A)
    static let secondaryAccent = Color(hex: 0x4ECDC4)
    static let background = Color(hex: 0x0A0A0A)
    static let cardBackground = Color(hex: 0x161616)
    static let cardBackgroundElevated = Color(hex: 0x1E1E1E)
    static let primaryText = Color(hex: 0xFAF0E6)
    static let secondaryText = Color(hex: 0xA0A0A0)
    static let tertiaryText = Color(hex: 0x555555)
    static let positive = Color(hex: 0x4ADE80)
    static let negative = Color(hex: 0xF87171)
    static let cornerRadius: CGFloat = 18
    static let cardSpacing: CGFloat = 14
    static let horizontalPadding: CGFloat = 18

    static let accentGradient = LinearGradient(
        colors: [Color(hex: 0xF7931A), Color(hex: 0xE8721A)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    static let warmGlow = Color(hex: 0xF7931A, opacity: 0.08)

    static let assumedBTCPrice: Decimal = 90000
}

// MARK: - Shared formatters

func formatCurrency(_ value: Decimal) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.maximumFractionDigits = 0
    return f.string(from: value as NSDecimalNumber) ?? "$0"
}

func formatBtc(_ value: Decimal) -> String {
    String(format: "%.4f BTC", Double(truncating: value as NSNumber))
}

struct GlassCard: ViewModifier {
    var highlight: Bool = false
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .fill(highlight ? AppTheme.cardBackgroundElevated : AppTheme.cardBackground)
                    .overlay(
                        RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                            .strokeBorder(
                                LinearGradient(
                                    colors: [Color.white.opacity(highlight ? 0.12 : 0.06), Color.clear],
                                    startPoint: .topLeading, endPoint: .bottomTrailing
                                ),
                                lineWidth: 1
                            )
                    )
            )
    }
}

extension View {
    func glassCard(highlight: Bool = false) -> some View {
        modifier(GlassCard(highlight: highlight))
    }
}

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
