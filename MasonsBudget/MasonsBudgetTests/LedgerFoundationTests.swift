import SwiftUI
import XCTest

/// Pins the ledger tokens from the 2026-09-05 contrast audit: opaque ink tiers,
/// the light Bitcoin text ink, the price hero decimals, the type floor, and the
/// persisted effect preferences.
final class LedgerFoundationTests: XCTestCase {
    private let dark = LedgerPalette.terminalLedger
    private let light = LedgerPalette.daylightLedger

    func testAccessibleControlFloorAndReduceMotion() {
        XCTAssertGreaterThanOrEqual(LedgerMetrics.minimumHitTarget, 44)
        for token in [LedgerMotionToken.chipAndNavigation, .toggleAndButton, .toggleKnob, .rowReveal] {
            XCTAssertNil(token.animation(reduceMotion: true))
            XCTAssertNotNil(token.animation(reduceMotion: false))
        }
    }

    // MARK: - Colour tokens

    func testSatsBlackSurfacesAndRules() {
        XCTAssertEqual(dark.background, Color(hex: 0x050505))
        XCTAssertEqual(dark.panel, Color(hex: 0x0E0E0E))
        XCTAssertEqual(dark.raisedPanel, Color(hex: 0x161616))
        XCTAssertEqual(dark.primaryRule, Color(hex: 0xF5F2EA, opacity: 0.10))
        XCTAssertEqual(dark.rowRule, Color(hex: 0xF5F2EA, opacity: 0.06))
        XCTAssertEqual(dark.toggleKnob, Color(hex: 0xF5F2EA))
    }

    func testInkTiersAreOpaque() {
        XCTAssertEqual(dark.secondaryForeground, Color(hex: 0xABA8A1))
        XCTAssertEqual(dark.tertiaryForeground, Color(hex: 0x95928C))
        XCTAssertEqual(light.secondaryForeground, Color(hex: 0x505452))
        XCTAssertEqual(light.tertiaryForeground, Color(hex: 0x5C605D))
    }

    func testForegroundInksMatchAcceptedTreatments() {
        XCTAssertEqual(dark.primaryForeground, Color(hex: 0xF5F2EA))
        XCTAssertEqual(light.primaryForeground, Color(hex: 0x141715))
    }

    func testBitcoinTextSplitsFromFill() {
        XCTAssertEqual(dark.accentForeground, Color(hex: 0xF7931A))
        XCTAssertEqual(dark.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(light.accentForeground, Color(hex: 0x9E5104))
        XCTAssertEqual(light.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(light.foregroundOnAccentFill, Color(hex: 0x050505))
    }

    func testPriceHeroDecimalsUseAccentAtSeventyFivePercentOnDarkAndOpaqueOnLight() {
        XCTAssertEqual(LedgerGlowToken.priceHeroDecimalOpacity, 0.75)
        XCTAssertEqual(dark.priceHeroDecimals, Color(hex: 0xF7931A, opacity: 0.75))
        XCTAssertEqual(light.priceHeroDecimals, Color(hex: 0x9E5104))
    }

    func testCompatibilityThemeReadsTheOpaqueTiers() {
        XCTAssertEqual(ColorTokens.dark.textMuted, Color(hex: 0xABA8A1))
        XCTAssertEqual(ColorTokens.dark.textFaint, Color(hex: 0x95928C))
        XCTAssertEqual(ColorTokens.light.textMuted, Color(hex: 0x505452))
        XCTAssertEqual(ColorTokens.light.textFaint, Color(hex: 0x5C605D))
        XCTAssertEqual(ColorTokens.light.accent, Color(hex: 0x9E5104))
        XCTAssertEqual(ColorTokens.light.accentDeep, Color(hex: 0xF7931A))
    }

    func testCompatibilityThemeExposesTheFillAndItsInk() {
        XCTAssertEqual(ColorTokens.dark.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.light.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.dark.onAccent, Color(hex: 0x050505))
        XCTAssertEqual(ColorTokens.light.onAccent, Color(hex: 0x050505))
    }

    func testAccentSoftTintsFromEachTreatmentsTextInk() {
        XCTAssertEqual(dark.accentSoft, Color(hex: 0xF7931A, opacity: 0.12))
        XCTAssertEqual(light.accentSoft, Color(hex: 0x9E5104, opacity: 0.10))
    }

    // MARK: - Contrast

    /// WCAG 2 contrast from the resolved linear sRGB components.
    private func contrast(_ ink: Color, on fill: Color) -> Double {
        func luminance(_ color: Color) -> Double {
            let resolved = color.resolve(in: EnvironmentValues())
            return 0.2126 * Double(resolved.linearRed)
                + 0.7152 * Double(resolved.linearGreen)
                + 0.0722 * Double(resolved.linearBlue)
        }
        let lighter = max(luminance(ink), luminance(fill))
        let darker = min(luminance(ink), luminance(fill))
        return (lighter + 0.05) / (darker + 0.05)
    }

    func testInkOnAccentFillClearsAAInBothTreatments() {
        for palette in [dark, light] {
            XCTAssertGreaterThanOrEqual(contrast(palette.foregroundOnAccentFill, on: palette.accentFill), 4.5)
        }
        for tokens in [ColorTokens.dark, ColorTokens.light] {
            XCTAssertGreaterThanOrEqual(contrast(tokens.onAccent, on: tokens.accentFill), 4.5)
        }
    }

    /// The swipe delete action and the Bill Pay card draw the page colour on
    /// the loss and plum fills.
    func testPageInkClearsAAOnTheLossAndPlumFills() {
        for tokens in [ColorTokens.dark, ColorTokens.light] {
            XCTAssertGreaterThanOrEqual(contrast(tokens.bg, on: tokens.danger), 4.5)
            XCTAssertGreaterThanOrEqual(contrast(tokens.bg, on: tokens.plum), 4.5)
        }
    }

    func testPriceHeroSplitsWholeDollarsFromCents() throws {
        let reference = NumberFormatter()
        reference.numberStyle = .currency
        reference.currencyCode = "USD"
        reference.minimumFractionDigits = 2
        reference.maximumFractionDigits = 2
        let separator = try XCTUnwrap(reference.currencyDecimalSeparator)
        for raw in ["112345.67", "950.5", "0", "1000000"] {
            let value = try XCTUnwrap(Decimal(string: raw))
            let parts = AppFormatter.priceHeroParts(value)
            let full = try XCTUnwrap(reference.string(from: value as NSDecimalNumber))
            XCTAssertEqual(parts.integer + parts.decimals, full, raw)
            XCTAssertTrue(parts.decimals.hasPrefix(separator), raw)
            XCTAssertEqual(parts.decimals.count, separator.count + 2, raw)
        }
    }

    func testGlowKeepsReleaseAlpha() {
        XCTAssertEqual(LedgerGlowToken.opacity, 0.35)
        XCTAssertEqual(LedgerGlowToken.restingRadius, 18)
        XCTAssertEqual(LedgerGlowToken.pulseRadius, 32)
    }

    // MARK: - Type floor

    private func spec(_ role: LedgerTypeRole) -> LedgerTypeSpecification {
        role.specification(metrics: .terminalLedger)
    }

    func testTypeFloorRoles() {
        let expected: [(LedgerTypeRole, CGFloat, LedgerFontWeight, CGFloat)] = [
            (.tabLabel, 11, .semibold, 0.06),
            (.kpiLabel, 11, .medium, 0.10),
            (.kpiSub, 11, .medium, 0.04),
            (.rowMeta, 11, .medium, 0.03),
            (.screenSubtitle, 11, .medium, 0.10),
            (.sectionLabel, 11, .semibold, 0.10),
            (.chip, 12.5, .semibold, 0.06),
        ]
        for (role, size, weight, tracking) in expected {
            let specification = spec(role)
            XCTAssertEqual(specification.size, size, "\(role) size")
            XCTAssertEqual(specification.weight, weight, "\(role) weight")
            XCTAssertEqual(specification.trackingEm, tracking, accuracy: 0.0001, "\(role) tracking")
            XCTAssertTrue(specification.uppercase, "\(role) stays uppercase")
        }
    }

    func testBodyIsTwelvePointWithEighteenPointLeading() {
        let body = spec(.body)
        XCTAssertEqual(body.size, 12)
        XCTAssertEqual(body.weight, .regular)
        XCTAssertEqual(body.size * body.lineHeight, 18, accuracy: 0.0001)
        XCTAssertEqual(body.lineSpacing, 6, accuracy: 0.0001)
    }

    func testNothingUnderElevenPointsOrOverTenPercentTracking() {
        let roles: [LedgerTypeRole] = [
            .screenTitle, .drilldownTitle, .screenSubtitle, .heroNumeral, .priceHero, .priceHeroDecimals,
            .kpiLabel, .kpiValue, .kpiSub, .sectionLabel, .rowPrimary, .rowMeta, .rowFigure, .chip,
            .tabLabel, .body, .button, .amountInput, .textInput,
        ]
        for metrics in [LedgerMetrics.terminalLedger, LedgerMetrics.daylightLedger] {
            for role in roles {
                let specification = role.specification(metrics: metrics)
                XCTAssertGreaterThanOrEqual(specification.size, LedgerTypeRole.minimumSize, "\(role)")
                XCTAssertLessThanOrEqual(specification.trackingEm, LedgerTypeRole.maximumTrackingEm, "\(role)")
            }
        }
    }

    func testRolesAboveTheFloorAreUnchanged() {
        XCTAssertEqual(spec(.button).size, 11)
        XCTAssertEqual(spec(.button).trackingEm, 0.10)
        XCTAssertEqual(spec(.rowFigure).size, 12.5)
        XCTAssertEqual(spec(.kpiValue).size, 20)
        XCTAssertEqual(spec(.heroNumeral).size, 28)
        XCTAssertEqual(spec(.priceHero).size, 38)
        XCTAssertEqual(spec(.priceHeroDecimals).size, 20)
        XCTAssertEqual(spec(.rowPrimary).size, 12.5)
        XCTAssertEqual(LedgerTypeRole.rowPrimary.specification(metrics: .daylightLedger).size, 13.5)
    }

    // MARK: - Role adoption

    func testEveryRoleResolvesToItsFaceSizeAndWeight() throws {
        let expected: [LedgerTypeRole: (CGFloat, LedgerFontWeight)] = [
            .screenTitle: (26, .semibold), .drilldownTitle: (24, .semibold), .screenSubtitle: (11, .medium),
            .heroNumeral: (28, .semibold), .priceHero: (38, .semibold), .priceHeroDecimals: (20, .semibold),
            .kpiLabel: (11, .medium), .kpiValue: (20, .medium), .kpiSub: (11, .medium),
            .sectionLabel: (11, .semibold), .rowPrimary: (12.5, .regular), .rowMeta: (11, .medium),
            .rowFigure: (12.5, .medium), .chip: (12.5, .semibold), .tabLabel: (11, .semibold),
            .body: (12, .regular), .button: (11, .semibold), .amountInput: (28, .medium), .textInput: (15, .regular),
        ]
        XCTAssertEqual(Set(expected.keys), Set(LedgerTypeRole.allCases))
        for role in LedgerTypeRole.allCases {
            let (size, weight) = try XCTUnwrap(expected[role])
            let specification = spec(role)
            XCTAssertEqual(specification.size, size, "\(role) size")
            XCTAssertEqual(specification.weight, weight, "\(role) weight")
            XCTAssertEqual(
                specification.font,
                Font.custom(weight.postScriptName, size: size, relativeTo: specification.relativeTo),
                "\(role) face",
            )
        }
    }

    func testTierColouredRolesSitOnTheFloorAtMediumOrSemibold() {
        let tierRoles: [LedgerTypeRole] = [.rowMeta, .kpiLabel, .kpiSub, .sectionLabel, .tabLabel, .chip, .screenSubtitle]
        for role in tierRoles {
            let specification = spec(role)
            XCTAssertEqual(specification.size, role == .chip ? 12.5 : 11, "\(role)")
            XCTAssertTrue([.medium, .semibold].contains(specification.weight), "\(role) weight \(specification.weight)")
        }
    }

    func testTabularRolesCarryMonospacedDigits() {
        let tabular = Set(LedgerTypeRole.allCases.filter { spec($0).tabularFigures })
        XCTAssertEqual(
            tabular,
            [.heroNumeral, .priceHero, .priceHeroDecimals, .kpiValue, .kpiSub, .rowMeta, .rowFigure, .chip, .amountInput],
        )
    }

    // MARK: - Source scans

    private var projectRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("MasonsBudget")
    }

    /// Every Swift file under Views/ as lines. Skips when the test bundle does
    /// not sit next to the checkout.
    private func viewSources() throws -> [(file: String, lines: [String])] {
        let viewsRoot = projectRoot.appendingPathComponent("Views")
        var sources: [(file: String, lines: [String])] = []
        if let enumerator = FileManager.default.enumerator(at: viewsRoot, includingPropertiesForKeys: nil) {
            for case let url as URL in enumerator where url.pathExtension == "swift" {
                let source = try String(contentsOf: url, encoding: .utf8)
                sources.append((url.lastPathComponent, source.components(separatedBy: "\n")))
            }
        }
        guard !sources.isEmpty else {
            throw XCTSkip("Source tree not available at \(viewsRoot.path)")
        }
        return sources
    }

    /// The unit suffix is opaque: the secondary tier, the accent, or the
    /// caller's colour. Alpha text undercut the opaque tiers.
    func testAmountSuffixDrawsOpaqueInk() throws {
        let amount = try XCTUnwrap(viewSources().first { $0.file == "AmountView.swift" })
        XCTAssertFalse(amount.lines.contains { $0.contains(".opacity(") }, "AmountView must not composite alpha text")
        XCTAssertTrue(amount.lines.contains { $0.contains("accent ? theme.accent : theme.textMuted") })
    }

    /// The price hero draws its cents with the decimals role and token.
    func testPriceHeroDrawsTheDecimalsToken() throws {
        let price = try XCTUnwrap(viewSources().first { $0.file == "BitcoinOverviewView.swift" })
        XCTAssertTrue(price.lines.contains { $0.contains(".ledgerType(.priceHeroDecimals)") })
        XCTAssertTrue(price.lines.contains { $0.contains("tokens.colors.priceHeroDecimals") })
        XCTAssertTrue(price.lines.contains { $0.contains(".ledgerGlow(radius: glowRadius)") })
    }

    /// Source-level guard: no view paints `.white`. Ink on a fill comes from
    /// the palette (`theme.onAccent`, or the page colour on loss and plum) so
    /// both treatments clear 4.5:1 instead of white on orange at 2.3:1.
    func testViewsNeverDrawWhiteInk() throws {
        let white = try Regex(#"\.white\b"#)
        var offenders: [String] = []
        for source in try viewSources() {
            for (index, line) in source.lines.enumerated() where line.contains(white) {
                offenders.append("\(source.file):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertTrue(offenders.isEmpty, "Views must not paint .white:\n" + offenders.joined(separator: "\n"))
    }

    /// Source-level guard: views draw only ledger roles and SF Symbol glyphs.
    /// Runs when the test bundle sits next to the checkout; skips otherwise.
    func testViewsDrawOnlyLedgerRolesAndIconGlyphs() throws {
        var offenders: [String] = []
        var roleSites = 0
        for source in try viewSources() {
            var previousLine = ""
            for (index, line) in source.lines.enumerated() {
                roleSites += line.components(separatedBy: ".ledgerType(").count - 1
                let usesAppFont = line.contains("AppFont.") && !line.contains("AppFont.icon")
                // A glyph size may only follow an Image; text of any kind takes a role.
                let fontOffGlyph = line.contains(".font(") && !line.contains("Image(") && !previousLine.contains("Image(")
                if usesAppFont || fontOffGlyph {
                    offenders.append("\(source.file):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
                }
                if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    previousLine = line
                }
            }
        }
        XCTAssertTrue(offenders.isEmpty, "Text must draw through .ledgerType:\n" + offenders.joined(separator: "\n"))
        XCTAssertGreaterThanOrEqual(roleSites, 280, "role call sites")

        let theme = try String(contentsOf: projectRoot.appendingPathComponent("Theme/AppTheme.swift"), encoding: .utf8)
        let appFont = theme.components(separatedBy: "enum AppFont {")[1].components(separatedBy: "\n}")[0]
        for line in appFont.components(separatedBy: "\n") where line.contains("static ") {
            XCTAssertTrue(line.contains("icon"), "AppFont keeps glyph sizes only: \(line.trimmingCharacters(in: .whitespaces))")
        }
    }

    /// The numeric keypad draws its digits on the amount input role, not a glyph size.
    func testKeypadDigitsDrawTheAmountInputRole() throws {
        let addTransaction = try XCTUnwrap(viewSources().first { $0.file == "AddTransactionView.swift" })
        let amountInputSites = addTransaction.lines.filter { $0.contains(".ledgerType(.amountInput)") }.count
        XCTAssertGreaterThanOrEqual(amountInputSites, 2, "amount field and keypad")
        XCTAssertFalse(addTransaction.lines.contains { $0.contains("AppFont.iconLarge") })
    }

    // MARK: - System chrome

    func testChromeSpecsSitOnTheTypeFloor() {
        XCTAssertEqual(LedgerChromeSpec.tabLabel.size, 11)
        XCTAssertEqual(LedgerChromeSpec.tabLabel.weight, .semibold)
        XCTAssertEqual(LedgerChromeSpec.tabLabel.trackingEm, 0.06, accuracy: 0.0001)
        XCTAssertTrue(LedgerChromeSpec.tabLabel.uppercase)
        XCTAssertEqual(LedgerChromeSpec.badge.size, 12.5)
        XCTAssertEqual(LedgerChromeSpec.badge.weight, .semibold)
        XCTAssertEqual(LedgerChromeSpec.inlineTitle.size, 15)
        XCTAssertEqual(LedgerChromeSpec.inlineTitle.weight, .semibold)
        XCTAssertEqual(LedgerChromeSpec.largeTitle.size, 24)
        XCTAssertEqual(LedgerChromeSpec.largeTitle.weight, .semibold)
        XCTAssertEqual(LedgerChromeSpec.barButton.size, 13)
        XCTAssertEqual(LedgerChromeSpec.barButton.weight, .medium)
        let specifications = [
            LedgerChromeSpec.tabLabel, LedgerChromeSpec.badge, LedgerChromeSpec.inlineTitle,
            LedgerChromeSpec.largeTitle, LedgerChromeSpec.barButton,
        ]
        for specification in specifications {
            XCTAssertGreaterThanOrEqual(specification.size, LedgerTypeRole.minimumSize)
            XCTAssertLessThanOrEqual(specification.trackingEm, LedgerTypeRole.maximumTrackingEm)
            XCTAssertTrue(specification.font == Font.custom(specification.weight.postScriptName, size: specification.size, relativeTo: specification.relativeTo))
        }
    }

    #if canImport(UIKit)
        func testTabCaptionsPreserveStandardSizingAndStopGrowingAtAccessibilitySizes() {
            var sizes: [CGFloat] = []
            for category in [UIContentSizeCategory.large, .extraExtraExtraLarge, .accessibilityLarge, .accessibilityExtraExtraExtraLarge] {
                UITraitCollection(preferredContentSizeCategory: category).performAsCurrent {
                    let attributes = LedgerChrome.tabTitleAttributes(ink: \.accentForeground)
                    guard let font = attributes[.font] as? UIFont else {
                        XCTFail("Tab title must retain its font")
                        return
                    }
                    XCTAssertEqual(font.fontName, LedgerChromeSpec.tabLabel.weight.postScriptName)
                    sizes.append(font.pointSize)
                }
            }
            XCTAssertEqual(sizes.count, 4)
            guard sizes.count == 4 else { return }
            XCTAssertEqual(sizes[0], LedgerChromeSpec.tabLabel.size, accuracy: 0.01)
            XCTAssertGreaterThan(sizes[1], sizes[0])
            XCTAssertEqual(sizes[2], sizes[1], accuracy: 0.01)
            XCTAssertEqual(sizes[3], sizes[1], accuracy: 0.01)
        }

        private func components(_ color: UIColor, style: UIUserInterfaceStyle) -> (UInt, UInt, UInt) {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            return (UInt((red * 255).rounded()), UInt((green * 255).rounded()), UInt((blue * 255).rounded()))
        }

        func testChromeColoursFollowTheInterfaceStyle() {
            XCTAssertEqual(components(LedgerChrome.color(\.accentFill), style: .dark).0, 0xF7)
            XCTAssertEqual(components(LedgerChrome.color(\.accentFill), style: .light).0, 0xF7)
            XCTAssertEqual(components(LedgerChrome.color(\.foregroundOnAccentFill), style: .dark).0, 0x05)
            XCTAssertEqual(components(LedgerChrome.color(\.foregroundOnAccentFill), style: .light).0, 0x05)
            XCTAssertEqual(components(LedgerChrome.color(\.accentForeground), style: .dark).0, 0xF7)
            XCTAssertEqual(components(LedgerChrome.color(\.accentForeground), style: .light).0, 0x9E)
            XCTAssertEqual(components(LedgerChrome.color(\.panel), style: .dark).1, 0x0E)
            XCTAssertEqual(components(LedgerChrome.color(\.panel), style: .light).1, 0xEB)
        }
    #endif

    func testStaticWeightsMapToBundledFaces() {
        XCTAssertEqual(LedgerFontWeight.allCases.map(\.rawValue), [300, 400, 500, 600, 700])
        XCTAssertEqual(LedgerFontWeight.medium.postScriptName, "SourceCodePro-Medium")
        XCTAssertEqual(LedgerFontWeight.semibold.postScriptName, "SourceCodePro-Semibold")
    }

    // MARK: - Effect preferences

    func testScanlinesDefaultOffWithoutOverridingASavedPreference() throws {
        let suiteName = "LedgerFoundationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertFalse(LedgerPreference.scanlinesDefault)
        XCTAssertNil(defaults.object(forKey: LedgerPreference.scanlinesKey))
        XCTAssertEqual(
            defaults.object(forKey: LedgerPreference.scanlinesKey) as? Bool ?? LedgerPreference.scanlinesDefault,
            false,
        )

        defaults.set(true, forKey: LedgerPreference.scanlinesKey)
        XCTAssertEqual(
            defaults.object(forKey: LedgerPreference.scanlinesKey) as? Bool ?? LedgerPreference.scanlinesDefault,
            true,
        )
    }

    func testEffectPreferenceKeysAndDefaults() {
        XCTAssertEqual(LedgerPreference.scanlinesKey, "ledger_scanlines_enabled")
        XCTAssertEqual(LedgerPreference.phosphorGlowKey, "ledger_phosphor_glow_enabled")
        XCTAssertEqual(LedgerPreference.reduceMotionKey, "ledger_reduce_motion")
        XCTAssertTrue(LedgerPreference.phosphorGlowDefault)
        XCTAssertFalse(LedgerPreference.reduceMotionDefault)
    }

    func testTextureAndGlowFollowAccessibilityPolicy() {
        XCTAssertTrue(LedgerEffectsPolicy(reduceMotion: false, reduceTransparency: false).allowsTextureAndGlow)
        XCTAssertFalse(LedgerEffectsPolicy(reduceMotion: true, reduceTransparency: false).allowsTextureAndGlow)
        XCTAssertFalse(LedgerEffectsPolicy(reduceMotion: false, reduceTransparency: true).allowsTextureAndGlow)
    }
}
