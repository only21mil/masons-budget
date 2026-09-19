import SwiftUI

// MARK: - Color Hex Extension

extension Color {
    init(hex: UInt) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
        )
    }

    init(hex: UInt, opacity: Double) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity,
        )
    }
}

// MARK: - Appearance Mode

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String {
        rawValue
    }

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

    var id: String {
        rawValue
    }

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
    /// Bitcoin text and line art: F7931A dark, 9E5104 light.
    let accent: Color
    /// Filled controls and cards: F7931A in both treatments, always under `onAccent`.
    let accentFill: Color
    /// Ink on `accentFill`: 050505 in both treatments.
    let onAccent: Color
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
        bg: LedgerPalette.terminalLedger.background,
        surface: LedgerPalette.terminalLedger.panel,
        surface2: LedgerPalette.terminalLedger.raisedPanel,
        elevated: LedgerPalette.terminalLedger.raisedPanel,
        border: LedgerPalette.terminalLedger.rowRule,
        borderStrong: LedgerPalette.terminalLedger.primaryRule,
        text: LedgerPalette.terminalLedger.primaryForeground,
        textMuted: LedgerPalette.terminalLedger.secondaryForeground,
        textFaint: LedgerPalette.terminalLedger.tertiaryForeground,
        accent: LedgerPalette.terminalLedger.accentForeground,
        accentFill: LedgerPalette.terminalLedger.accentFill,
        onAccent: LedgerPalette.terminalLedger.foregroundOnAccentFill,
        accentDeep: LedgerPalette.terminalLedger.accentFill,
        accentSoft: LedgerPalette.terminalLedger.accentSoft,
        accentSoft2: LedgerPalette.terminalLedger.accentFill.opacity(0.24),
        success: LedgerPalette.terminalLedger.gain,
        successSoft: LedgerPalette.terminalLedger.gain.opacity(0.18),
        warn: Color(hex: 0xF2C94C),
        warnSoft: Color(red: 0.949, green: 0.788, blue: 0.298, opacity: 0.18),
        danger: LedgerPalette.terminalLedger.loss,
        dangerSoft: LedgerPalette.terminalLedger.loss.opacity(0.18),
        info: Color(hex: 0x7AC4E5),
        infoSoft: Color(red: 0.478, green: 0.769, blue: 0.898, opacity: 0.16),
        plum: Color(hex: 0xC9A0DC),
        plumSoft: Color(red: 0.788, green: 0.627, blue: 0.863, opacity: 0.16),
        chartGrid: Color(red: 1.0, green: 0.925, blue: 0.784, opacity: 0.05),
    )

    static let light = ColorTokens(
        bg: LedgerPalette.daylightLedger.background,
        surface: LedgerPalette.daylightLedger.panel,
        surface2: LedgerPalette.daylightLedger.raisedPanel,
        elevated: LedgerPalette.daylightLedger.raisedPanel,
        border: LedgerPalette.daylightLedger.rowRule,
        borderStrong: LedgerPalette.daylightLedger.primaryRule,
        text: LedgerPalette.daylightLedger.primaryForeground,
        textMuted: LedgerPalette.daylightLedger.secondaryForeground,
        textFaint: LedgerPalette.daylightLedger.tertiaryForeground,
        accent: LedgerPalette.daylightLedger.accentForeground,
        accentFill: LedgerPalette.daylightLedger.accentFill,
        onAccent: LedgerPalette.daylightLedger.foregroundOnAccentFill,
        accentDeep: LedgerPalette.daylightLedger.accentFill,
        accentSoft: LedgerPalette.daylightLedger.accentSoft,
        accentSoft2: LedgerPalette.daylightLedger.accentFill.opacity(0.22),
        success: LedgerPalette.daylightLedger.gain,
        successSoft: LedgerPalette.daylightLedger.gain.opacity(0.14),
        warn: Color(hex: 0xB8860B),
        warnSoft: Color(red: 0.722, green: 0.525, blue: 0.043, opacity: 0.16),
        danger: LedgerPalette.daylightLedger.loss,
        dangerSoft: LedgerPalette.daylightLedger.loss.opacity(0.14),
        info: Color(hex: 0x2C6E8F),
        infoSoft: Color(red: 0.173, green: 0.431, blue: 0.561, opacity: 0.14),
        plum: Color(hex: 0x7A4F8A),
        plumSoft: Color(red: 0.478, green: 0.310, blue: 0.541, opacity: 0.14),
        chartGrid: Color(red: 0.078, green: 0.063, blue: 0.039, opacity: 0.06),
    )
}

extension EnvironmentValues {
    @Entry var theme: ColorTokens = .dark
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
            .ledgerFoundations()
    }
}

// MARK: - Typography

/// SF Symbol glyph sizes. Text never uses these; every text call site draws a
/// `LedgerTypeRole` through `.ledgerType(_:)`, which owns face, size, weight,
/// tracking, leading, case, and tabular figures.
enum AppFont {
    static let iconHero = Font.system(size: 64)
    static let iconDisplay = Font.system(size: 56)
    static let iconXL = Font.system(size: 48)
    static let iconLarge = Font.system(size: 26)
    static let iconMedium = Font.system(size: 20)
    static let iconSmall = Font.system(size: 18)
    static let iconTiny = Font.system(size: 16)

    static func icon(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.system(size: size, weight: weight)
    }
}

// MARK: - Layout Constants

enum AppLayout {
    static let radiusLarge: CGFloat = 20
    static let radiusMedium: CGFloat = 16
    static let radiusSmall: CGFloat = 14

    static let paddingHero: CGFloat = 20
    static let paddingDefault: CGFloat = 16
    static let paddingCompact: CGFloat = 14

    static let sectionPadding: CGFloat = 18
    static let cardSpacing: CGFloat = 14
    static let gridSpacing: CGFloat = 10

    static let sidebarWidth: CGFloat = 220
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

    /// The price hero as two runs: the whole dollars, and the separator plus
    /// cents, so the decimals can take the `priceHeroDecimals` role and colour.
    /// Always carries cents, unlike `formatCurrency` above 1000.
    static func priceHeroParts(_ value: Decimal) -> (integer: String, decimals: String) {
        let text = centsCurrencyFormatter.string(from: value as NSDecimalNumber) ?? "$0.00"
        let separator = centsCurrencyFormatter.currencyDecimalSeparator ?? "."
        guard let range = text.range(of: separator, options: .backwards) else { return (text, "") }
        return (String(text[..<range.lowerBound]), String(text[range.lowerBound...]))
    }

    // MARK: - Month grouping (shared by the buys and bill-pay lists)

    private static let monthFormatterLock = NSLock()
    private static var monthFormatters: [String: DateFormatter] = [:]

    /// Cached per format string and locale. View-only (MainActor) callers plus the lock
    /// keep this safe; DateFormatter construction is too expensive to repeat.
    static func monthFormatter(for format: String, locale: Locale = Locale(identifier: "en_US_POSIX")) -> DateFormatter {
        monthFormatterLock.lock()
        defer { monthFormatterLock.unlock() }
        let key = locale.identifier + ":" + format
        if let cached = monthFormatters[key] { return cached }
        let f = DateFormatter()
        f.locale = locale
        f.calendar = locale.calendar
        f.timeZone = .autoupdatingCurrent
        f.dateFormat = format
        monthFormatters[key] = f
        return f
    }

    /// Groups items into month buckets keyed by a formatted month heading,
    /// newest month first. Replaces the byte-identical per-view copies.
    static func groupedByMonth<T>(
        _ items: [T],
        by date: (T) -> Date,
        format: String = "MMMM yyyy",
    ) -> [(String, [T])] {
        let formatter = monthFormatter(for: format)
        var map: [String: [T]] = [:]
        for item in items {
            map[formatter.string(from: date(item)), default: []].append(item)
        }
        let sortedKeys = map.keys.sorted { k1, k2 in
            let d1 = map[k1]?.first.map(date) ?? .distantPast
            let d2 = map[k2]?.first.map(date) ?? .distantPast
            return d1 > d2
        }
        return sortedKeys.compactMap { key in
            guard let bucket = map[key], !bucket.isEmpty else { return nil }
            return (key, bucket)
        }
    }

    static func formatBtc(_ btc: Decimal) -> String {
        let mag = btc.magnitude
        let digits = if mag >= 1 { 4 }
        else if mag >= Decimal(sign: .plus, exponent: -2, significand: 1) { 5 }
        else { 6 }
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
    // Preserve legacy call sites while the shared panel owns radius and rules.
    var padding: CGFloat = AppLayout.paddingDefault
    var radius: CGFloat = AppLayout.radiusLarge

    func body(content: Content) -> some View {
        LedgerPanel(padding: padding) { content }
    }
}

extension View {
    func glassCard(
        padding: CGFloat = AppLayout.paddingDefault,
        radius: CGFloat = AppLayout.radiusLarge,
    ) -> some View {
        modifier(GlassCard(padding: padding, radius: radius))
    }
}

/// Screen-time source. The standalone design-packet target pins time; app builds
/// always use the wall clock. This flag is never enabled on application targets.
enum LedgerClock {
    static var now: Date {
        #if MAC_DESIGN_PACKET
            Date(timeIntervalSince1970: 1_800_000_000)
        #else
            Date()
        #endif
    }
}
