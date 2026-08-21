import XCTest

@testable import VogelVaultCorePlaceholder

// VogelVaultCore carried only VoiceParser; voice entry is removed, so this
// suite keeps `swift test` executable (a package with no tests errors out)
// and CI's cheapest-signal job stays green. Drop the target, this suite and
// the CI job together when the workflow is next touched.
final class PlaceholderTests: XCTestCase {
    func testPlaceholderTargetCompiles() {
        // The placeholder target's reason to exist is compilation itself.
        XCTAssertTrue(true)
    }
}
