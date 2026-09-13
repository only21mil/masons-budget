import SwiftUI
#if canImport(UIKit)
    import UIKit
#endif

// MARK: - Treatments and semantic color

enum LedgerTreatment: Sendable {
    case terminalLedger
    case daylightLedger

    init(colorScheme: ColorScheme) {
        self = colorScheme == .dark ? .terminalLedger : .daylightLedger
    }
}

enum LedgerSemanticForeground: Sendable {
    case primary
    case secondary
    case tertiary
    case accent
    case onAccentFill
    case gain
    case loss
}

struct LedgerPalette: Sendable {
    let background: Color
    let panel: Color
    let raisedPanel: Color
    let primaryRule: Color
    let rowRule: Color
    let primaryForeground: Color
    let secondaryForeground: Color
    let tertiaryForeground: Color
    let accentForeground: Color
    let accentFill: Color
    let accentSoft: Color
    let priceHeroDecimals: Color
    let foregroundOnAccentFill: Color
    let gain: Color
    let loss: Color
    let scanline: Color
    let toggleKnob: Color

    func foreground(_ semantic: LedgerSemanticForeground) -> Color {
        switch semantic {
        case .primary: primaryForeground
        case .secondary: secondaryForeground
        case .tertiary: tertiaryForeground
        case .accent: accentForeground
        case .onAccentFill: foregroundOnAccentFill
        case .gain: gain
        case .loss: loss
        }
    }
}

extension LedgerPalette {
    static let terminalLedger = LedgerPalette(
        background: Color(hex: 0x050505),
        panel: Color(hex: 0x0E0E0E),
        raisedPanel: Color(hex: 0x161616),
        primaryRule: Color(hex: 0xF5F2EA, opacity: 0.10),
        rowRule: Color(hex: 0xF5F2EA, opacity: 0.06),
        primaryForeground: Color(hex: 0xF5F2EA),
        // Opaque warm grey tiers for the Sats black treatment.
        secondaryForeground: Color(hex: 0xABA8A1),
        tertiaryForeground: Color(hex: 0x95928C),
        accentForeground: Color(hex: 0xF7931A),
        accentFill: Color(hex: 0xF7931A),
        accentSoft: Color(hex: 0xF7931A, opacity: 0.12),
        priceHeroDecimals: Color(hex: 0xF7931A, opacity: LedgerGlowToken.priceHeroDecimalOpacity),
        foregroundOnAccentFill: Color(hex: 0x050505),
        // Exact Display P3 encodings of oklch(0.74 0.155 158) and
        // oklch(0.70 0.155 28), preserving the handoff colors on Apple displays.
        gain: Color(.displayP3, red: 0.403_133_570, green: 0.771_433_512, blue: 0.540_537_773),
        loss: Color(.displayP3, red: 0.876_730_664, green: 0.480_479_274, blue: 0.422_105_613),
        scanline: Color.white.opacity(0.022),
        toggleKnob: Color(hex: 0xF5F2EA),
    )

    static let daylightLedger = LedgerPalette(
        background: Color(hex: 0xF4F3EE),
        panel: Color(hex: 0xEDEBE4),
        raisedPanel: .white,
        primaryRule: Color(hex: 0x141715, opacity: 0.14),
        rowRule: Color(hex: 0x141715, opacity: 0.08),
        primaryForeground: Color(hex: 0x141715),
        // Opaque tiers: 141715 blended over the background at 0.72 and 0.67.
        secondaryForeground: Color(hex: 0x505452),
        tertiaryForeground: Color(hex: 0x5C605D),
        // The lightest orange of this hue that clears 4.5:1 on panel for text.
        // Filled controls keep F7931A with dark ink.
        accentForeground: Color(hex: 0x9E5104),
        accentFill: Color(hex: 0xF7931A),
        // Same base as FOUNDATIONS and Android: the light text ink at 0.10.
        accentSoft: Color(hex: 0x9E5104, opacity: 0.10),
        priceHeroDecimals: Color(hex: 0x9E5104),
        foregroundOnAccentFill: Color(hex: 0x050505),
        // Exact Display P3 encodings of oklch(0.52 0.13 158) and
        // oklch(0.52 0.15 28). Both are inside Display P3.
        gain: Color(.displayP3, red: 0.189_090_905, green: 0.487_614_912, blue: 0.310_875_612),
        loss: Color(.displayP3, red: 0.633_874_142, green: 0.270_738_584, blue: 0.226_670_032),
        scanline: Color.black.opacity(0.012),
        toggleKnob: .white,
    )
}

// MARK: - Density, rule, spacing, radius, and motion

enum LedgerRuleStyle: Sendable {
    case solid
    case dashed

    var dashPattern: [CGFloat] {
        switch self {
        case .solid: []
        case .dashed: [3, 3]
        }
    }
}

struct LedgerMetrics: Sendable {
    let ruleStyle: LedgerRuleStyle
    let screenGutter: CGFloat
    let rowVerticalPadding: CGFloat
    let screenTitleSize: CGFloat
    let rowPrimarySize: CGFloat

    static let cardPadding: CGFloat = 16
    static let sectionTopSpacing: CGFloat = 21
    static let sectionLabelBottomSpacing: CGFloat = 9
    static let denseRowVerticalPadding: CGFloat = 11
    static let categoryRowVerticalPadding: CGFloat = 13
    static let siblingChipSpacing: CGFloat = 6
    static let actionSpacing: CGFloat = 7
    static let chipRadius: CGFloat = 3
    static let cardRadius: CGFloat = 4
    static let toggleRadius: CGFloat = 12
    static let minimumHitTarget: CGFloat = 44
    static let stepperSize = CGSize(width: 30, height: 28)
    static let categoryStepperSize = CGSize(width: 34, height: 34)
    static let toggleSize = CGSize(width: 42, height: 24)

    static let terminalLedger = LedgerMetrics(
        ruleStyle: .solid,
        screenGutter: 20,
        rowVerticalPadding: 12,
        screenTitleSize: 26,
        rowPrimarySize: 12.5,
    )

    static let daylightLedger = LedgerMetrics(
        ruleStyle: .dashed,
        screenGutter: 22,
        rowVerticalPadding: 15,
        screenTitleSize: 29,
        rowPrimarySize: 13.5,
    )
}

/// Motion vocabulary from the handoff prototype and the 2026-09-05 motion
/// package. Every animated call site goes through `animation(reduceMotion:)`
/// so reduce motion lands every value immediately.
enum LedgerMotionToken: Equatable, Sendable {
    case chipAndNavigation
    case toggleAndButton
    case toggleKnob
    case progressAndTheme
    case rowReveal
    case pulse
    case skeletonBreathe
    case cursorBlink

    var duration: Double {
        switch self {
        case .chipAndNavigation, .rowReveal: 0.16
        case .toggleAndButton: 0.18
        case .toggleKnob: 0.20
        case .progressAndTheme: 0.30
        case .pulse: 0.60
        case .skeletonBreathe: 1.10
        case .cursorBlink: 1.10
        }
    }

    var timing: Timing {
        self == .cursorBlink ? .stepEnd : .ease
    }

    func animation(reduceMotion: Bool) -> Animation? {
        guard !reduceMotion, timing == .ease else { return nil }
        return .easeInOut(duration: duration)
    }

    enum Timing: Equatable, Sendable {
        case ease
        case stepEnd
    }

    /// Row reveal stagger: 0.02s per row, capped at index 7 so a long list
    /// finishes inside 0.4s.
    static let rowRevealStagger = 0.02
    static let rowRevealMaximumIndex = 7

    static func rowRevealDelay(index: Int) -> Double {
        Double(min(max(index, 0), rowRevealMaximumIndex)) * rowRevealStagger
    }
}

// MARK: - Glow, texture, and persisted effect preferences

enum LedgerGlowToken {
    /// Shadow alpha for phosphor glow. Android ships 0.30; no test pins parity,
    /// so Apple keeps the release value.
    static let opacity = 0.35
    static let priceHeroDecimalOpacity = 0.75
    static let restingRadius: CGFloat = 18
    static let pulseRadius: CGFloat = 32
}

/// UserDefaults keys for the ledger effect preferences. Defaults apply only
/// when the key is absent, so a saved choice always wins.
enum LedgerPreference {
    static let scanlinesKey = "ledger_scanlines_enabled"
    static let phosphorGlowKey = "ledger_phosphor_glow_enabled"
    static let reduceMotionKey = "ledger_reduce_motion"

    /// Scanlines are a texture preference, not a base layer: off for new installs.
    static let scanlinesDefault = false
    static let phosphorGlowDefault = true
    static let reduceMotionDefault = false
}

// MARK: - Source Code Pro typography

enum LedgerFontWeight: Int, CaseIterable, Sendable {
    case light = 300
    case regular = 400
    case medium = 500
    case semibold = 600
    case bold = 700

    var postScriptName: String {
        switch self {
        case .light: "SourceCodePro-Light"
        case .regular: "SourceCodePro-Regular"
        case .medium: "SourceCodePro-Medium"
        case .semibold: "SourceCodePro-Semibold"
        case .bold: "SourceCodePro-Bold"
        }
    }
}

enum LedgerTypeRole: CaseIterable, Sendable {
    case screenTitle
    case drilldownTitle
    case screenSubtitle
    case heroNumeral
    case priceHero
    case priceHeroDecimals
    case kpiLabel
    case kpiValue
    case kpiSub
    case sectionLabel
    case rowPrimary
    case rowMeta
    case rowFigure
    case chip
    case tabLabel
    case body
    case button
    case amountInput
    case textInput
}

struct LedgerTypeSpecification: Sendable {
    let size: CGFloat
    let weight: LedgerFontWeight
    let trackingEm: CGFloat
    let relativeTo: Font.TextStyle
    let lineHeight: CGFloat
    let uppercase: Bool
    let tabularFigures: Bool

    var font: Font {
        .custom(weight.postScriptName, size: size, relativeTo: relativeTo)
    }

    var tracking: CGFloat {
        size * trackingEm
    }

    var lineSpacing: CGFloat {
        max(0, size * (lineHeight - 1))
    }
}

extension LedgerTypeRole {
    /// Type floor from the 2026-09-05 contrast audit: nothing under 11pt, nothing
    /// under weight 500 on a tier colour, uppercase tracking at most 0.10em.
    static let minimumSize: CGFloat = 11
    static let maximumTrackingEm: CGFloat = 0.10

    func specification(metrics: LedgerMetrics) -> LedgerTypeSpecification {
        switch self {
        case .screenTitle:
            .init(size: metrics.screenTitleSize, weight: .semibold, trackingEm: -0.02,
                  relativeTo: .largeTitle, lineHeight: 1, uppercase: false, tabularFigures: false)
        case .drilldownTitle:
            .init(size: 24, weight: .semibold, trackingEm: -0.02,
                  relativeTo: .title, lineHeight: 1.15, uppercase: false, tabularFigures: false)
        case .screenSubtitle:
            .init(size: 11, weight: .medium, trackingEm: 0.10,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .heroNumeral:
            .init(size: 28, weight: .semibold, trackingEm: -0.03,
                  relativeTo: .title, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .priceHero:
            .init(size: 38, weight: .semibold, trackingEm: -0.03,
                  relativeTo: .largeTitle, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .priceHeroDecimals:
            .init(size: 20, weight: .semibold, trackingEm: -0.03,
                  relativeTo: .title3, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .kpiLabel:
            .init(size: 11, weight: .medium, trackingEm: 0.10,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .kpiValue:
            .init(size: 20, weight: .medium, trackingEm: 0,
                  relativeTo: .title3, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .kpiSub:
            .init(size: 11, weight: .medium, trackingEm: 0.04,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .sectionLabel:
            .init(size: 11, weight: .semibold, trackingEm: 0.10,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .rowPrimary:
            .init(size: metrics.rowPrimarySize, weight: .regular, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: false)
        case .rowMeta:
            .init(size: 11, weight: .medium, trackingEm: 0.03,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .rowFigure:
            .init(size: 12.5, weight: .medium, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .chip:
            .init(size: 12.5, weight: .semibold, trackingEm: 0.06,
                  relativeTo: .caption, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .tabLabel:
            .init(size: 11, weight: .semibold, trackingEm: 0.06,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .body:
            .init(size: 12, weight: .regular, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1.5, uppercase: false, tabularFigures: false)
        case .button:
            .init(size: 11, weight: .semibold, trackingEm: 0.10,
                  relativeTo: .callout, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .amountInput:
            .init(size: 28, weight: .medium, trackingEm: 0,
                  relativeTo: .title, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .textInput:
            .init(size: 15, weight: .regular, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: false)
        }
    }
}

// MARK: - Environment and text application

struct LedgerTokens: Sendable {
    let treatment: LedgerTreatment
    let colors: LedgerPalette
    let metrics: LedgerMetrics

    init(treatment: LedgerTreatment) {
        self.treatment = treatment
        switch treatment {
        case .terminalLedger:
            colors = .terminalLedger
            metrics = .terminalLedger
        case .daylightLedger:
            colors = .daylightLedger
            metrics = .daylightLedger
        }
    }
}

struct LedgerEffectsPolicy: Sendable {
    let reduceMotion: Bool
    let reduceTransparency: Bool

    var allowsTextureAndGlow: Bool {
        !reduceMotion && !reduceTransparency
    }
}

extension EnvironmentValues {
    @Entry var ledgerTokens = LedgerTokens(treatment: .terminalLedger)
    @Entry var ledgerEffects = LedgerEffectsPolicy(reduceMotion: false, reduceTransparency: false)
}

private struct LedgerFoundationsModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(LedgerPreference.reduceMotionKey) private var prefersReducedMotion = LedgerPreference.reduceMotionDefault

    func body(content: Content) -> some View {
        content
            .environment(\.ledgerTokens, LedgerTokens(treatment: .init(colorScheme: colorScheme)))
            .environment(\.ledgerEffects, LedgerEffectsPolicy(
                reduceMotion: reduceMotion || prefersReducedMotion,
                reduceTransparency: reduceTransparency,
            ))
    }
}

private struct LedgerTypeModifier: ViewModifier {
    let role: LedgerTypeRole

    @Environment(\.ledgerTokens) private var tokens

    func body(content: Content) -> some View {
        let specification = role.specification(metrics: tokens.metrics)
        content
            .font(specification.font)
            .tracking(specification.tracking)
            .lineSpacing(specification.lineSpacing)
            .textCase(specification.uppercase ? .uppercase : nil)
            .modifier(LedgerTabularFigureModifier(isEnabled: specification.tabularFigures))
    }
}

private struct LedgerTabularFigureModifier: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.monospacedDigit()
        } else {
            content
        }
    }
}

extension View {
    /// Installs theme, density, and accessibility policy without changing a route.
    func ledgerFoundations() -> some View {
        modifier(LedgerFoundationsModifier())
    }

    /// Draws text with a ledger type role: Source Code Pro at the role's size,
    /// weight, tracking, and leading, uppercase where the role is, and tabular
    /// figures where the role is. Every text call site in the app uses this;
    /// `AppFont` keeps only SF Symbol glyph sizes.
    func ledgerType(_ role: LedgerTypeRole) -> some View {
        modifier(LedgerTypeModifier(role: role))
    }
}

// MARK: - System chrome

/// Type for the bars the system draws. Tab labels and the More badge take
/// their roles from the table; inline navigation titles and bar buttons have
/// no role of their own, so their faces are pinned here on the same floor.
enum LedgerChromeSpec {
    static let tabLabel = LedgerTypeRole.tabLabel.specification(metrics: .terminalLedger)
    static let badge = LedgerTypeRole.chip.specification(metrics: .terminalLedger)
    static let largeTitle = LedgerTypeRole.drilldownTitle.specification(metrics: .terminalLedger)
    static let inlineTitle = LedgerTypeSpecification(
        size: 15, weight: .semibold, trackingEm: -0.01,
        relativeTo: .headline, lineHeight: 1, uppercase: false, tabularFigures: false,
    )
    static let barButton = LedgerTypeSpecification(
        size: 13, weight: .medium, trackingEm: 0,
        relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: false,
    )
}

#if canImport(UIKit)
    /// Installs the ledger palette and Source Code Pro on UIKit's tab bar and
    /// navigation bar so the chrome matches the screens: panel bar over a rule
    /// hairline, tier ink on unselected items, the accent on the selected one,
    /// and the More badge as a Bitcoin fill under dark ink. Colours resolve per
    /// interface style, so a forced appearance follows the window.
    enum LedgerChrome {
        static func color(_ token: KeyPath<LedgerPalette, Color>) -> UIColor {
            UIColor { traits in
                let palette: LedgerPalette = traits.userInterfaceStyle == .dark ? .terminalLedger : .daylightLedger
                return UIColor(palette[keyPath: token])
            }
        }

        static func font(_ specification: LedgerTypeSpecification, style: UIFont.TextStyle) -> UIFont {
            let face = UIFont(name: specification.weight.postScriptName, size: specification.size)
                ?? UIFont.systemFont(ofSize: specification.size)
            return UIFontMetrics(forTextStyle: style).scaledFont(for: face)
        }

        static func attributes(
            _ specification: LedgerTypeSpecification,
            style: UIFont.TextStyle,
            ink: KeyPath<LedgerPalette, Color>,
        ) -> [NSAttributedString.Key: Any] {
            [
                .font: font(specification, style: style),
                .kern: specification.tracking,
                .foregroundColor: color(ink),
            ]
        }

        @MainActor
        static func install() {
            let tabItem = UITabBarItemAppearance()
            tabItem.normal.iconColor = color(\.tertiaryForeground)
            tabItem.normal.titleTextAttributes = attributes(LedgerChromeSpec.tabLabel, style: .caption2, ink: \.tertiaryForeground)
            tabItem.selected.iconColor = color(\.accentForeground)
            tabItem.selected.titleTextAttributes = attributes(LedgerChromeSpec.tabLabel, style: .caption2, ink: \.accentForeground)
            for state in [tabItem.normal, tabItem.selected] {
                state.badgeBackgroundColor = color(\.accentFill)
                state.badgeTextAttributes = attributes(LedgerChromeSpec.badge, style: .caption2, ink: \.foregroundOnAccentFill)
            }

            let tabBar = UITabBarAppearance()
            tabBar.configureWithOpaqueBackground()
            tabBar.backgroundColor = color(\.panel)
            tabBar.shadowColor = color(\.primaryRule)
            tabBar.stackedLayoutAppearance = tabItem
            tabBar.inlineLayoutAppearance = tabItem
            tabBar.compactInlineLayoutAppearance = tabItem
            UITabBar.appearance().standardAppearance = tabBar
            UITabBar.appearance().scrollEdgeAppearance = tabBar

            let barButton = UIBarButtonItemAppearance(style: .plain)
            barButton.normal.titleTextAttributes = attributes(LedgerChromeSpec.barButton, style: .body, ink: \.accentForeground)

            let navigationBar = UINavigationBarAppearance()
            navigationBar.configureWithOpaqueBackground()
            navigationBar.backgroundColor = color(\.background)
            navigationBar.shadowColor = color(\.rowRule)
            navigationBar.titleTextAttributes = attributes(LedgerChromeSpec.inlineTitle, style: .headline, ink: \.primaryForeground)
            navigationBar.largeTitleTextAttributes = attributes(LedgerChromeSpec.largeTitle, style: .largeTitle, ink: \.primaryForeground)
            navigationBar.buttonAppearance = barButton
            navigationBar.backButtonAppearance = barButton
            navigationBar.doneButtonAppearance = barButton
            UINavigationBar.appearance().standardAppearance = navigationBar
            UINavigationBar.appearance().scrollEdgeAppearance = navigationBar
            UINavigationBar.appearance().compactAppearance = navigationBar
            UINavigationBar.appearance().tintColor = color(\.accentForeground)
        }
    }
#endif

// MARK: - Reusable non-screen foundations

struct LedgerRule: View {
    var level: Level = .primary

    @Environment(\.ledgerTokens) private var tokens

    enum Level: Sendable {
        case primary
        case row
    }

    var body: some View {
        Canvas { context, size in
            var path = Path()
            path.move(to: CGPoint(x: 0, y: 0.5))
            path.addLine(to: CGPoint(x: size.width, y: 0.5))
            context.stroke(
                path,
                with: .color(level == .primary ? tokens.colors.primaryRule : tokens.colors.rowRule),
                style: StrokeStyle(lineWidth: 1, dash: tokens.metrics.ruleStyle.dashPattern),
            )
        }
        .frame(height: 1)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct LedgerPanel<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    @Environment(\.ledgerTokens) private var tokens

    init(padding: CGFloat = LedgerMetrics.cardPadding, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(tokens.colors.panel)
            .clipShape(RoundedRectangle(cornerRadius: LedgerMetrics.cardRadius))
            .overlay {
                RoundedRectangle(cornerRadius: LedgerMetrics.cardRadius)
                    .stroke(
                        tokens.colors.primaryRule,
                        style: StrokeStyle(lineWidth: 1, dash: tokens.metrics.ruleStyle.dashPattern),
                    )
            }
    }
}

struct LedgerTextureOverlay: View {
    var isEnabled = true

    @Environment(\.ledgerTokens) private var tokens
    @Environment(\.ledgerEffects) private var effects
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(LedgerPreference.scanlinesKey) private var scanlinesEnabled = LedgerPreference.scanlinesDefault

    var body: some View {
        if isEnabled, scanlinesEnabled, allowsEffects {
            Canvas { context, size in
                for y in stride(from: CGFloat.zero, through: size.height, by: 3) {
                    context.fill(
                        Path(CGRect(x: 0, y: y, width: size.width, height: 1)),
                        with: .color(tokens.colors.scanline),
                    )
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private var allowsEffects: Bool {
        effects.allowsTextureAndGlow && !reduceMotion && !reduceTransparency
    }
}

private struct LedgerGlowModifier: ViewModifier {
    let isEnabled: Bool
    let radius: CGFloat

    @Environment(\.ledgerTokens) private var tokens
    @Environment(\.ledgerEffects) private var effects
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(LedgerPreference.phosphorGlowKey) private var glowEnabled = LedgerPreference.phosphorGlowDefault

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled, glowEnabled, allowsEffects {
            content.shadow(color: tokens.colors.accentFill.opacity(LedgerGlowToken.opacity), radius: radius)
        } else {
            content
        }
    }

    /// Phosphor glow belongs to the Terminal Ledger treatment only.
    private var allowsEffects: Bool {
        tokens.treatment == .terminalLedger && effects.allowsTextureAndGlow && !reduceMotion && !reduceTransparency
    }
}

extension View {
    /// Phosphor glow for hero numerals. Off in Daylight, under reduce motion or
    /// reduce transparency, and when the glow preference is off.
    func ledgerGlow(isEnabled: Bool = true, radius: CGFloat = 8) -> some View {
        modifier(LedgerGlowModifier(isEnabled: isEnabled, radius: radius))
    }
}

// MARK: - Horizon and proposed category glyphs

// Horizon keeps the handoff's 24-unit geometry verbatim. Its mark uses the
// 0.435 transform and clears the 7.333-unit safe radius. The three rules remain
// full bleed. Never inset them or derive a small-size replacement.

enum HorizonMarkInk: Sendable {
    case semanticAccent
    case bitcoinOrange
    case monochrome
}

struct HorizonMarkView: View {
    static let minimumReadableSize: CGFloat = 24
    static let settingsSize: CGFloat = 40
    static let splashSize: CGFloat = 80

    var size: CGFloat
    var ink: HorizonMarkInk = .semanticAccent

    @Environment(\.ledgerTokens) private var tokens

    var body: some View {
        Image("HorizonMark")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(1, contentMode: .fit)
            .foregroundStyle(color)
            .frame(width: max(size, Self.minimumReadableSize), height: max(size, Self.minimumReadableSize))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch ink {
        case .semanticAccent: tokens.colors.accentForeground
        case .bitcoinOrange: Color(hex: 0xF7931A)
        case .monochrome: tokens.colors.primaryForeground
        }
    }
}

struct HorizonAppIconView: View {
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color(hex: 0x0A0D0C)
                HorizonMarkView(size: min(geometry.size.width, geometry.size.height), ink: .bitcoinOrange)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

enum LedgerCategoryGlyph: String, Sendable {
    case car = "LedgerCarGlyph"
    case pet = "LedgerPetGlyph"

    init?(categoryName: String) {
        switch categoryName {
        case "Auto & Transport": self = .car
        case "Pets": self = .pet
        default: return nil
        }
    }
}

struct LedgerCategoryGlyphView: View {
    let glyph: LedgerCategoryGlyph
    var size: CGFloat = 15

    @Environment(\.ledgerTokens) private var tokens

    var body: some View {
        Image(glyph.rawValue)
            .renderingMode(.template)
            .resizable()
            .aspectRatio(1, contentMode: .fit)
            .foregroundStyle(tokens.colors.accentForeground)
            .frame(width: size, height: size)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
