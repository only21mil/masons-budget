import SwiftUI

// MARK: - Color Hex Extension

extension Color {
    init(hex: UInt) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    init(hex: UInt, opacity: Double) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - Appearance Mode

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

// MARK: - Display Unit

enum DisplayUnit: String, CaseIterable, Identifiable {
    case btc, sats, usd

    var id: String { rawValue }

    var label: String {
        switch self {
        case .btc: "BTC"
        case .sats: "SATS"
        case .usd: "USD"
        }
    }

    var prefix: String {
        ""
    }
}

// MARK: - Color Tokens

struct ColorTokens {
    let bg: Color
    let surface: Color
    let surface2: Color
    let elevated: Color
    let border: Color
    let borderStrong: Color
    let text: Color
    let textMuted: Color
    let textFaint: Color
    let accent: Color
    let accentDeep: Color
    let accentSoft: Color
    let accentSoft2: Color
    let success: Color
    let successSoft: Color
    let warn: Color
    let warnSoft: Color
    let danger: Color
    let dangerSoft: Color
    let info: Color
    let infoSoft: Color
    let plum: Color
    let plumSoft: Color
    let chartGrid: Color
}

extension ColorTokens {
    static let dark = ColorTokens(
        bg:           Color(hex: 0x0B0907),
        surface:      Color(hex: 0x15120E),
        surface2:     Color(hex: 0x1C1813),
        elevated:     Color(hex: 0x211C16),
        border:       Color(red: 1.0,    green: 0.925,  blue: 0.784, opacity: 0.08),
        borderStrong: Color(red: 1.0,    green: 0.925,  blue: 0.784, opacity: 0.14),
        text:         Color(hex: 0xF4ECD8),
        textMuted:    Color(red: 0.957,  green: 0.925,  blue: 0.847, opacity: 0.62),
        textFaint:    Color(red: 0.957,  green: 0.925,  blue: 0.847, opacity: 0.38),
        accent:       Color(hex: 0xF7931A),
        accentDeep:   Color(hex: 0xFFB347),
        accentSoft:   Color(red: 0.969,  green: 0.576,  blue: 0.102, opacity: 0.16),
        accentSoft2:  Color(red: 0.969,  green: 0.576,  blue: 0.102, opacity: 0.28),
        success:      Color(hex: 0x4ADE80),
        successSoft:  Color(red: 0.290,  green: 0.871,  blue: 0.502, opacity: 0.18),
        warn:         Color(hex: 0xF2C94C),
        warnSoft:     Color(red: 0.949,  green: 0.788,  blue: 0.298, opacity: 0.18),
        danger:       Color(hex: 0xF87171),
        dangerSoft:   Color(red: 0.973,  green: 0.443,  blue: 0.443, opacity: 0.18),
        info:         Color(hex: 0x7AC4E5),
        infoSoft:     Color(red: 0.478,  green: 0.769,  blue: 0.898, opacity: 0.16),
        plum:         Color(hex: 0xC9A0DC),
        plumSoft:     Color(red: 0.788,  green: 0.627,  blue: 0.863, opacity: 0.16),
        chartGrid:    Color(red: 1.0,    green: 0.925,  blue: 0.784, opacity: 0.05)
    )

    static let light = ColorTokens(
        bg:           Color(hex: 0xFAF8F4),
        surface:      .white,
        surface2:     Color(hex: 0xF4F1EB),
        elevated:     .white,
        border:       Color(red: 0.078,  green: 0.063,  blue: 0.039, opacity: 0.08),
        borderStrong: Color(red: 0.078,  green: 0.063,  blue: 0.039, opacity: 0.14),
        text:         Color(hex: 0x15110A),
        textMuted:    Color(red: 0.082,  green: 0.067,  blue: 0.039, opacity: 0.58),
        textFaint:    Color(red: 0.082,  green: 0.067,  blue: 0.039, opacity: 0.38),
        accent:       Color(hex: 0xF7931A),
        accentDeep:   Color(hex: 0xE07B0E),
        accentSoft:   Color(red: 0.969,  green: 0.576,  blue: 0.102, opacity: 0.12),
        accentSoft2:  Color(red: 0.969,  green: 0.576,  blue: 0.102, opacity: 0.22),
        success:      Color(hex: 0x1B7A3E),
        successSoft:  Color(red: 0.106,  green: 0.478,  blue: 0.243, opacity: 0.14),
        warn:         Color(hex: 0xB8860B),
        warnSoft:     Color(red: 0.722,  green: 0.525,  blue: 0.043, opacity: 0.16),
        danger:       Color(hex: 0xC0392B),
        dangerSoft:   Color(red: 0.753,  green: 0.224,  blue: 0.169, opacity: 0.14),
        info:         Color(hex: 0x2C6E8F),
        infoSoft:     Color(red: 0.173,  green: 0.431,  blue: 0.561, opacity: 0.14),
        plum:         Color(hex: 0x7A4F8A),
        plumSoft:     Color(red: 0.478,  green: 0.310,  blue: 0.541, opacity: 0.14),
        chartGrid:    Color(red: 0.078,  green: 0.063,  blue: 0.039, opacity: 0.06)
    )
}

// MARK: - Theme Environment

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = ColorTokens.dark
}

extension EnvironmentValues {
    var theme: ColorTokens {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

private struct ThemeModifier: ViewModifier {
    @Environment(\.colorScheme) var colorScheme

    func body(content: Content) -> some View {
        content.environment(\.theme, colorScheme == .dark ? .dark : .light)
    }
}

extension View {
    func themed() -> some View {
        modifier(ThemeModifier())
    }
}

// MARK: - Typography

enum AppFont {
    static let heroNumber    = Font.system(size: 48, weight: .bold)
    static let largeNumber   = Font.system(size: 30, weight: .bold)
    static let title         = Font.system(size: 22, weight: .bold)
    static let monoData      = Font.system(size: 17, weight: .semibold, design: .monospaced)
    static let monoCaption   = Font.system(size: 13, weight: .regular, design: .monospaced)
    static let sectionHeader = Font.system(size: 11, weight: .bold)
    static let body          = Font.system(size: 15, weight: .medium)
    static let bodyStrong    = Font.system(size: 15, weight: .semibold)
    static let caption       = Font.system(size: 13, weight: .medium)
    static let captionStrong = Font.system(size: 13, weight: .semibold)
    static let small         = Font.system(size: 11, weight: .medium)

    static let heroTracking: CGFloat    = -0.03 * 48
    static let largeTracking: CGFloat   = -0.02 * 30
    static let sectionTracking: CGFloat =  0.08 * 11
}

// MARK: - Layout Constants

enum AppLayout {
    static let radiusLarge: CGFloat   = 20
    static let radiusMedium: CGFloat  = 16
    static let radiusSmall: CGFloat   = 14

    static let paddingHero: CGFloat    = 20
    static let paddingDefault: CGFloat = 16
    static let paddingCompact: CGFloat = 14

    static let sectionPadding: CGFloat = 18
    static let cardSpacing: CGFloat    = 14
    static let gridSpacing: CGFloat    = 10

    static let sidebarWidth: CGFloat   = 220
}

// MARK: - Compatibility Facade

enum AppTheme {
    static let accentColor = ColorTokens.dark.accent
    static let accentGold = ColorTokens.dark.accentDeep
    static let secondaryAccent = ColorTokens.dark.accent
    static let background = ColorTokens.dark.bg
    static let cardBackground = ColorTokens.dark.surface
    static let cardBackgroundElevated = ColorTokens.dark.elevated
    static let primaryText = ColorTokens.dark.text
    static let secondaryText = ColorTokens.dark.textMuted
    static let tertiaryText = ColorTokens.dark.textFaint
    static let cardBorder = ColorTokens.dark.border
    static let positive = ColorTokens.dark.success
    static let warning = ColorTokens.dark.warn
    static let negative = ColorTokens.dark.danger

    static let cornerRadius = AppLayout.radiusMedium
    static let cardSpacing = AppLayout.cardSpacing
    static let horizontalPadding = AppLayout.sectionPadding

    static let fallbackBTCPrice: Decimal = 104_000

    static let accentGradient = LinearGradient(
        colors: [Color(hex: 0xF7931A), Color(hex: 0xE07B0E)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

func formatCurrency(_ value: Decimal) -> String {
    AppFormatter.formatCurrency(value)
}

func formatBtc(_ value: Decimal) -> String {
    "\(AppFormatter.formatBtc(value)) BTC"
}

func formatSats(_ btc: Decimal) -> String {
    AppFormatter.formatSats(AppFormatter.satsFromBtc(btc))
}

// MARK: - Formatting

enum AppFormatter {
    private static let satsPerBTC: Decimal = 100_000_000

    private static let wholeCurrencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        f.minimumFractionDigits = 0
        return f
    }()

    private static let centsCurrencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 2
        return f
    }()

    private static let satsFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.groupingSeparator = ","
        f.maximumFractionDigits = 0
        return f
    }()

    static func formatCurrency(_ value: Decimal) -> String {
        let mag = value.magnitude
        let fmt = mag >= 1000 ? wholeCurrencyFormatter : centsCurrencyFormatter
        return fmt.string(from: value as NSDecimalNumber) ?? "$0"
    }

    static func formatBtc(_ btc: Decimal) -> String {
        let mag = btc.magnitude
        let digits: Int
        if mag >= 1 { digits = 4 }
        else if mag >= Decimal(sign: .plus, exponent: -2, significand: 1) { digits = 5 }
        else { digits = 6 }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = digits
        f.maximumFractionDigits = digits
        return f.string(from: btc as NSDecimalNumber) ?? "0"
    }

    static func formatSats(_ sats: Decimal) -> String {
        satsFormatter.string(from: sats as NSDecimalNumber) ?? "0"
    }

    static func satsFromBtc(_ btc: Decimal) -> Decimal {
        btc * satsPerBTC
    }

    static func btcFromSats(_ sats: Decimal) -> Decimal {
        sats / satsPerBTC
    }

    static func formatAmount(sats: Decimal, unit: DisplayUnit, btcPrice: Decimal = 0) -> String {
        switch unit {
        case .sats:
            return formatSats(sats)
        case .btc:
            return formatBtc(btcFromSats(sats))
        case .usd:
            let usd = btcFromSats(sats) * btcPrice
            return formatCurrency(usd)
        }
    }
}

// MARK: - Glass Card Modifier

struct GlassCard: ViewModifier {
    @Environment(\.theme) var theme
    var padding: CGFloat = AppLayout.paddingDefault
    var radius: CGFloat = AppLayout.radiusLarge

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(theme.border, lineWidth: 1)
            )
    }
}

extension View {
    func glassCard(
        padding: CGFloat = AppLayout.paddingDefault,
        radius: CGFloat = AppLayout.radiusLarge
    ) -> some View {
        modifier(GlassCard(padding: padding, radius: radius))
    }
}
