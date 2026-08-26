import SwiftUI

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
        background: Color(hex: 0x0A0D0C),
        panel: Color(hex: 0x0C100E),
        raisedPanel: Color(hex: 0x111614),
        primaryRule: Color(hex: 0xD6EEE0, opacity: 0.10),
        rowRule: Color(hex: 0xD6EEE0, opacity: 0.06),
        primaryForeground: Color(hex: 0xE8EFE9),
        secondaryForeground: Color(hex: 0xE8EFE9, opacity: 0.56),
        tertiaryForeground: Color(hex: 0xE8EFE9, opacity: 0.36),
        accentForeground: Color(hex: 0xF7931A),
        accentFill: Color(hex: 0xF7931A),
        accentSoft: Color(hex: 0xF7931A, opacity: 0.12),
        foregroundOnAccentFill: Color(hex: 0x0A0D0C),
        // Exact Display P3 encodings of oklch(0.74 0.155 158) and
        // oklch(0.70 0.155 28), preserving the handoff colors on Apple displays.
        gain: Color(.displayP3, red: 0.403_133_570, green: 0.771_433_512, blue: 0.540_537_773),
        loss: Color(.displayP3, red: 0.876_730_664, green: 0.480_479_274, blue: 0.422_105_613),
        scanline: Color.white.opacity(0.022),
        toggleKnob: Color(hex: 0xE8EFE9),
    )

    static let daylightLedger = LedgerPalette(
        background: Color(hex: 0xF4F3EE),
        panel: Color(hex: 0xEDEBE4),
        raisedPanel: .white,
        primaryRule: Color(hex: 0x141715, opacity: 0.14),
        rowRule: Color(hex: 0x141715, opacity: 0.08),
        primaryForeground: Color(hex: 0x141715),
        secondaryForeground: Color(hex: 0x141715, opacity: 0.60),
        tertiaryForeground: Color(hex: 0x141715, opacity: 0.42),
        accentForeground: Color(hex: 0xC96A05),
        accentFill: Color(hex: 0xF7931A),
        accentSoft: Color(hex: 0xC96A05, opacity: 0.10),
        foregroundOnAccentFill: Color(hex: 0x0A0D0C),
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

enum LedgerMotionToken: Equatable, Sendable {
    case chipAndNavigation
    case toggleAndButton
    case toggleKnob
    case progressAndTheme
    case cursorBlink

    var duration: Double {
        switch self {
        case .chipAndNavigation: 0.16
        case .toggleAndButton: 0.18
        case .toggleKnob: 0.20
        case .progressAndTheme: 0.30
        case .cursorBlink: 1.10
        }
    }

    var timing: Timing {
        self == .cursorBlink ? .stepEnd : .cssEase
    }

    func animation(reduceMotion: Bool) -> Animation? {
        guard !reduceMotion, timing == .cssEase else { return nil }
        return .timingCurve(0.25, 0.10, 0.25, 1.00, duration: duration)
    }

    enum Timing: Equatable, Sendable {
        case cssEase
        case stepEnd
    }
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

enum LedgerTypeRole: Sendable {
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
    func specification(metrics: LedgerMetrics) -> LedgerTypeSpecification {
        switch self {
        case .screenTitle:
            .init(size: metrics.screenTitleSize, weight: .semibold, trackingEm: -0.02,
                  relativeTo: .largeTitle, lineHeight: 1, uppercase: false, tabularFigures: false)
        case .drilldownTitle:
            .init(size: 24, weight: .semibold, trackingEm: -0.02,
                  relativeTo: .title, lineHeight: 1.15, uppercase: false, tabularFigures: false)
        case .screenSubtitle:
            .init(size: 9.5, weight: .regular, trackingEm: 0.18,
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
            .init(size: 9, weight: .medium, trackingEm: 0.16,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .kpiValue:
            .init(size: 20, weight: .medium, trackingEm: 0,
                  relativeTo: .title3, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .kpiSub:
            .init(size: 9, weight: .regular, trackingEm: 0.06,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .sectionLabel:
            .init(size: 9.5, weight: .semibold, trackingEm: 0.18,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .rowPrimary:
            .init(size: metrics.rowPrimarySize, weight: .regular, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: false)
        case .rowMeta:
            .init(size: 9.5, weight: .regular, trackingEm: 0.05,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .rowFigure:
            .init(size: 12.5, weight: .medium, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1, uppercase: false, tabularFigures: true)
        case .chip:
            .init(size: 10.5, weight: .semibold, trackingEm: 0.08,
                  relativeTo: .caption, lineHeight: 1, uppercase: true, tabularFigures: true)
        case .tabLabel:
            .init(size: 8.5, weight: .semibold, trackingEm: 0.10,
                  relativeTo: .caption2, lineHeight: 1, uppercase: true, tabularFigures: false)
        case .body:
            .init(size: 10.5, weight: .regular, trackingEm: 0,
                  relativeTo: .body, lineHeight: 1.85, uppercase: false, tabularFigures: false)
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

    func body(content: Content) -> some View {
        content
            .environment(\.ledgerTokens, LedgerTokens(treatment: .init(colorScheme: colorScheme)))
            .environment(\.ledgerEffects, LedgerEffectsPolicy(
                reduceMotion: reduceMotion,
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

    func ledgerType(_ role: LedgerTypeRole) -> some View {
        modifier(LedgerTypeModifier(role: role))
    }
}

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

    @Environment(\.ledgerTokens) private var tokens

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(LedgerMetrics.cardPadding)
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

    var body: some View {
        if isEnabled, allowsEffects {
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

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled, allowsEffects {
            content.shadow(color: tokens.colors.accentForeground.opacity(0.35), radius: radius)
        } else {
            content
        }
    }

    private var allowsEffects: Bool {
        effects.allowsTextureAndGlow && !reduceMotion && !reduceTransparency
    }
}

extension View {
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
