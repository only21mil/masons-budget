import SwiftUI
import XCTest

/// Pins the ledger tokens from the 2026-09-05 contrast audit: opaque ink tiers,
/// the light Bitcoin text ink, the price hero decimals, the type floor, and the
/// persisted effect preferences.
final class LedgerFoundationTests: XCTestCase {
    private let dark = LedgerPalette.terminalLedger
    private let light = LedgerPalette.daylightLedger

    // MARK: - Colour tokens

    func testInkTiersAreOpaque() {
        XCTAssertEqual(dark.secondaryForeground, Color(hex: 0xA3ABA6))
        XCTAssertEqual(dark.tertiaryForeground, Color(hex: 0x8F9792))
        XCTAssertEqual(light.secondaryForeground, Color(hex: 0x505452))
        XCTAssertEqual(light.tertiaryForeground, Color(hex: 0x5C605D))
    }

    func testForegroundInksAreUnchanged() {
        XCTAssertEqual(dark.primaryForeground, Color(hex: 0xE8EFE9))
        XCTAssertEqual(light.primaryForeground, Color(hex: 0x141715))
    }

    func testBitcoinTextSplitsFromFill() {
        XCTAssertEqual(dark.accentForeground, Color(hex: 0xF7931A))
        XCTAssertEqual(dark.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(light.accentForeground, Color(hex: 0x9E5104))
        XCTAssertEqual(light.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(light.foregroundOnAccentFill, Color(hex: 0x0A0D0C))
    }

    func testPriceHeroDecimalsUseAccentAtSeventyFivePercentOnDarkAndOpaqueOnLight() {
        XCTAssertEqual(LedgerGlowToken.priceHeroDecimalOpacity, 0.75)
        XCTAssertEqual(dark.priceHeroDecimals, Color(hex: 0xF7931A, opacity: 0.75))
        XCTAssertEqual(light.priceHeroDecimals, Color(hex: 0x9E5104))
    }

    func testCompatibilityThemeReadsTheOpaqueTiers() {
        XCTAssertEqual(ColorTokens.dark.textMuted, Color(hex: 0xA3ABA6))
        XCTAssertEqual(ColorTokens.dark.textFaint, Color(hex: 0x8F9792))
        XCTAssertEqual(ColorTokens.light.textMuted, Color(hex: 0x505452))
        XCTAssertEqual(ColorTokens.light.textFaint, Color(hex: 0x5C605D))
        XCTAssertEqual(ColorTokens.light.accent, Color(hex: 0x9E5104))
        XCTAssertEqual(ColorTokens.light.accentDeep, Color(hex: 0xF7931A))
    }

    func testCompatibilityThemeExposesTheFillAndItsInk() {
        XCTAssertEqual(ColorTokens.dark.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.light.accentFill, Color(hex: 0xF7931A))
        XCTAssertEqual(ColorTokens.dark.onAccent, Color(hex: 0x0A0D0C))
        XCTAssertEqual(ColorTokens.light.onAccent, Color(hex: 0x0A0D0C))
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

    /// The swipe delete action draws the page colour on the loss fill.
    func testPageInkClearsAAOnTheLossFill() {
        for tokens in [ColorTokens.dark, ColorTokens.light] {
            XCTAssertGreaterThanOrEqual(contrast(tokens.bg, on: tokens.danger), 4.5)
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
            (.chip, 11, .semibold, 0.06),
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
            .rowFigure: (12.5, .medium), .chip: (11, .semibold), .tabLabel: (11, .semibold),
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
            XCTAssertEqual(specification.size, 11, "\(role)")
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

    /// Source-level guard: views draw only ledger roles and SF Symbol glyphs.
    /// Runs when the test bundle sits next to the checkout; skips otherwise.
    func testViewsDrawOnlyLedgerRolesAndIconGlyphs() throws {
        var offenders: [String] = []
        var roleSites = 0
        for source in try viewSources() {
            for (index, line) in source.lines.enumerated() {
                roleSites += line.components(separatedBy: ".ledgerType(").count - 1
                let usesAppFont = line.contains("AppFont.") && !line.contains("AppFont.icon")
                let usesRawFont = line.contains(".font(") && !line.contains(".font(AppFont.icon")
                if usesAppFont || usesRawFont {
                    offenders.append("\(source.file):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
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
