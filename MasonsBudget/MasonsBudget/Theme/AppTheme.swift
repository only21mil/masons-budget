import SwiftUI

enum AppTheme {
    // MARK: - Color tokens (Bitcoin Standard design spec)

    static let accentColor = Color(hex: 0xF7931A)
    static let accentDeep = Color(hex: 0xFFB347)
    static let accentSoft = Color(hex: 0xF7931A, opacity: 0.16)
    static let accentSoft2 = Color(hex: 0xF7931A, opacity: 0.28)

    static let background = Color(hex: 0x0B0907)
    static let cardBackground = Color(hex: 0x15120E)
    static let surface2 = Color(hex: 0x1C1813)
    static let cardBackgroundElevated = Color(hex: 0x211C16)

    static let cardBorder = Color(hex: 0xFFECC8, opacity: 0.08)
    static let borderStrong = Color(hex: 0xFFECC8, opacity: 0.14)

    static let primaryText = Color(hex: 0xF4ECD8)
    static let secondaryText = Color(hex: 0xF4ECD8, opacity: 0.62)
    static let tertiaryText = Color(hex: 0xF4ECD8, opacity: 0.38)

    static let positive = Color(hex: 0x4ADE80)
    static let positiveSoft = Color(hex: 0x4ADE80, opacity: 0.18)
    static let warning = Color(hex: 0xF2C94C)
    static let warningSoft = Color(hex: 0xF2C94C, opacity: 0.18)
    static let negative = Color(hex: 0xF87171)
    static let negativeSoft = Color(hex: 0xF87171, opacity: 0.18)

    static let info = Color(hex: 0x7AC4E5)
    static let infoSoft = Color(hex: 0x7AC4E5, opacity: 0.16)
    static let plum = Color(hex: 0xC9A0DC)
    static let plumSoft = Color(hex: 0xC9A0DC, opacity: 0.16)

    // Legacy aliases
    static let accentGold = accentDeep
    static let secondaryAccent = info
    static let warmGlow = accentSoft

    // MARK: - Layout
    static let cornerRadius: CGFloat = 20
    static let cardSpacing: CGFloat = 14
    static let horizontalPadding: CGFloat = 18

    // MARK: - Gradients
    static let accentGradient = LinearGradient(
        colors: [Color(hex: 0xF7931A), Color(hex: 0xFFB347)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )

    // MARK: - Typography
    static let heroNumber: Font = .system(size: 42, weight: .bold, design: .monospaced)
    static let largeNumber: Font = .system(size: 32, weight: .bold, design: .monospaced)
    static let subNumber: Font = .system(size: 22, weight: .bold, design: .monospaced)
    static let monoCaption: Font = .system(size: 11, weight: .semibold, design: .monospaced)
    static let monoData: Font = .system(size: 14, weight: .semibold, design: .monospaced)

    // MARK: - Eyebrow
    static let eyebrowFont: Font = .system(size: 11, weight: .bold)
    static let eyebrowTracking: CGFloat = 0.08

    // MARK: - Motion
    static let durationFast: Double = 0.12
    static let durationMedium: Double = 0.2
    static let durationSlow: Double = 0.35
    static let entryAnimation: Animation = .easeOut(duration: 0.2)
    static let springAnimation: Animation = .spring(response: 0.4, dampingFraction: 0.75)

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

// MARK: - Card modifier

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
                                highlight ? AppTheme.borderStrong : AppTheme.cardBorder,
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

// MARK: - Color hex init

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
