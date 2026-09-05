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
