import SwiftUI
import XCTest

final class LedgerAdoptionTests: XCTestCase {
    func testCompatibilityThemeReadsAcceptedLedgerPalettes() {
        XCTAssertEqual(ColorTokens.dark.bg, LedgerPalette.terminalLedger.background)
        XCTAssertEqual(ColorTokens.dark.surface, LedgerPalette.terminalLedger.panel)
        XCTAssertEqual(ColorTokens.dark.text, LedgerPalette.terminalLedger.primaryForeground)
        XCTAssertEqual(ColorTokens.dark.accent, LedgerPalette.terminalLedger.accentForeground)

        XCTAssertEqual(ColorTokens.light.bg, LedgerPalette.daylightLedger.background)
        XCTAssertEqual(ColorTokens.light.surface, LedgerPalette.daylightLedger.panel)
        XCTAssertEqual(ColorTokens.light.text, LedgerPalette.daylightLedger.primaryForeground)
        XCTAssertEqual(ColorTokens.light.accent, LedgerPalette.daylightLedger.accentForeground)
    }
}
