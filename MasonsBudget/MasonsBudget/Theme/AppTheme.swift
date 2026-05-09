import SwiftUI

enum AppTheme {
    // MARK: - Color tokens (spec-aligned)
    static let accentColor = Color(hex: 0xF7931A)      // accent.bitcoin
    static let accentGold = Color(hex: 0xFFB347)
    static let secondaryAccent = Color(hex: 0xF7931A)
    static let background = Color(hex: 0x0B0907)
    static let cardBackground = Color(hex: 0x15120E)
    static let cardBackgroundElevated = Color(hex: 0x211C16)
    static let primaryText = Color(hex: 0xF4ECD8)
    static let secondaryText = Color(hex: 0xF4ECD8, opacity: 0.62)
    static let tertiaryText = Color(hex: 0xF4ECD8, opacity: 0.38)
    static let cardBorder = Color(hex: 0xFFECC8, opacity: 0.10)
    static let positive = Color(hex: 0x4ADE80)
    static let warning = Color(hex: 0xF2C94C)
    static let negative = Color(hex: 0xF87171)

    // MARK: - Layout
    static let cornerRadius: CGFloat = 18
    static let cardSpacing: CGFloat = 14
    static let horizontalPadding: CGFloat = 18

    // MARK: - Gradients
    static let accentGradient = LinearGradient(
        colors: [Color(hex: 0xF7931A), Color(hex: 0xE07B0E)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    static let warmGlow = Color(hex: 0xF7931A, opacity: 0.16)

    // MARK: - Typography
    static let heroNumber: Font = .system(size: 56, weight: .bold)
    static let largeNumber: Font = .system(size: 32, weight: .bold)
    static let subNumber: Font = .system(size: 28, weight: .semibold)
    static let monoCaption: Font = .system(size: 13, weight: .medium, design: .monospaced)
    static let monoData: Font = .system(size: 17, weight: .medium, design: .monospaced)

    // MARK: - Motion
    static let durationFast: Double = 0.2
    static let durationMedium: Double = 0.3
    static let durationSlow: Double = 0.45
    static let entryAnimation: Animation = .easeOut(duration: 0.3)
    static let springAnimation: Animation = .spring(response: 0.45, dampingFraction: 0.7)

    // MARK: - Data
    static let fallbackBTCPrice: Decimal = 90000
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

func formatSats(_ btc: Decimal) -> String {
    let sats = btc * Decimal(100_000_000)
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.maximumFractionDigits = 0
    return f.string(from: sats as NSDecimalNumber) ?? "0"
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
