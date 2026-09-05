import SwiftUI
import XCTest

/// Pins the first ledger motion wave: token durations, reduce-motion gating,
/// the hero numeral settle, the phosphor pulse guard, skeleton opacities, row
/// reveal stagger, the 42x24 toggle geometry, and the haptic trigger.
final class LedgerMotionTests: XCTestCase {
    func testMotionTokenDurations() {
        XCTAssertEqual(LedgerMotionToken.chipAndNavigation.duration, 0.16)
        XCTAssertEqual(LedgerMotionToken.toggleAndButton.duration, 0.18)
        XCTAssertEqual(LedgerMotionToken.toggleKnob.duration, 0.20)
        XCTAssertEqual(LedgerMotionToken.progressAndTheme.duration, 0.30)
        XCTAssertEqual(LedgerMotionToken.rowReveal.duration, 0.16)
        XCTAssertEqual(LedgerMotionToken.pulse.duration, 0.60)
        XCTAssertEqual(LedgerMotionToken.skeletonBreathe.duration, 1.10)
        XCTAssertEqual(LedgerMotionToken.cursorBlink.duration, 1.10)
    }

    func testEveryTokenIsSkippedUnderReduceMotion() {
        let tokens: [LedgerMotionToken] = [
            .chipAndNavigation, .toggleAndButton, .toggleKnob, .progressAndTheme,
            .rowReveal, .pulse, .skeletonBreathe, .cursorBlink,
        ]
        for token in tokens {
            XCTAssertNil(token.animation(reduceMotion: true), "\(token)")
        }
        for token in tokens where token.timing == .ease {
            XCTAssertNotNil(token.animation(reduceMotion: false), "\(token)")
        }
        XCTAssertNil(LedgerMotionToken.cursorBlink.animation(reduceMotion: false), "step-end has no curve")
    }

    func testPhosphorPulseSchedule() {
        XCTAssertEqual(LedgerPhosphorPulse.riseSeconds + LedgerPhosphorPulse.fallSeconds, LedgerMotionToken.pulse.duration, accuracy: 0.0001)
        XCTAssertEqual(LedgerGlowToken.restingRadius, 18)
        XCTAssertEqual(LedgerGlowToken.pulseRadius, 32)
    }

    func testPhosphorPulseOnlyOnDarkWithGlowAndMotion() {
        XCTAssertTrue(LedgerPhosphorPulse.isAllowed(reduceMotion: false, treatment: .terminalLedger, glowEnabled: true))
        XCTAssertFalse(LedgerPhosphorPulse.isAllowed(reduceMotion: true, treatment: .terminalLedger, glowEnabled: true))
        XCTAssertFalse(LedgerPhosphorPulse.isAllowed(reduceMotion: false, treatment: .daylightLedger, glowEnabled: true))
        XCTAssertFalse(LedgerPhosphorPulse.isAllowed(reduceMotion: false, treatment: .terminalLedger, glowEnabled: false))
    }

    func testPhosphorPulseLeavesRadiusAloneWhenSkipped() {
        var radius = LedgerGlowToken.restingRadius
        let binding = Binding(get: { radius }, set: { radius = $0 })
        LedgerPhosphorPulse.run(radius: binding, reduceMotion: true, treatment: .terminalLedger, glowEnabled: true)
        XCTAssertEqual(radius, LedgerGlowToken.restingRadius)
        LedgerPhosphorPulse.run(radius: binding, reduceMotion: false, treatment: .daylightLedger, glowEnabled: true)
        XCTAssertEqual(radius, LedgerGlowToken.restingRadius)
    }

    func testNumeralSettleInterpolatesTheValueAndReformats() {
        var settle = LedgerNumeralSettle(value: 100) { String(format: "%.0f", $0) }
        XCTAssertEqual(settle.animatableData, 100)
        settle.animatableData = 150.4
        XCTAssertEqual(settle.value, 150.4, accuracy: 0.0001)
        XCTAssertEqual(settle.format(settle.value), "150")
    }

    func testSkeletonBreathesBetweenPointFourFiveAndPointEightOrHoldsPointSix() {
        XCTAssertEqual(LedgerSkeleton.opacity(reduceMotion: false, breathingIn: false), 0.45)
        XCTAssertEqual(LedgerSkeleton.opacity(reduceMotion: false, breathingIn: true), 0.8)
        XCTAssertEqual(LedgerSkeleton.opacity(reduceMotion: true, breathingIn: false), 0.6)
        XCTAssertEqual(LedgerSkeleton.opacity(reduceMotion: true, breathingIn: true), 0.6)
    }

    func testRowRevealStaggerCapsAtIndexSeven() {
        XCTAssertEqual(LedgerMotionToken.rowRevealDelay(index: 0), 0)
        XCTAssertEqual(LedgerMotionToken.rowRevealDelay(index: 3), 0.06, accuracy: 0.0001)
        XCTAssertEqual(LedgerMotionToken.rowRevealDelay(index: 7), 0.14, accuracy: 0.0001)
        XCTAssertEqual(LedgerMotionToken.rowRevealDelay(index: 40), 0.14, accuracy: 0.0001)
        XCTAssertEqual(LedgerMotionToken.rowRevealDelay(index: -2), 0)
    }

    func testLedgerToggleGeometry() {
        XCTAssertEqual(LedgerMetrics.toggleSize, CGSize(width: 42, height: 24))
        XCTAssertEqual(LedgerToggleGeometry.knobDiameter, 18)
        XCTAssertEqual(LedgerToggleGeometry.knobInset, 3)
        XCTAssertEqual(LedgerToggleGeometry.knobTravel, 18)
    }

    func testProgressFractionIsClamped() {
        XCTAssertEqual(LedgerProgressBar.clamped(-0.2), 0)
        XCTAssertEqual(LedgerProgressBar.clamped(0.42), 0.42)
        XCTAssertEqual(LedgerProgressBar.clamped(1.7), 1)
        XCTAssertEqual(LedgerProgressBar.clamped(.nan), 0)
    }

    func testHapticTriggerReplaysTheSameKind() {
        var trigger = LedgerHapticTrigger()
        XCTAssertNil(trigger.kind)
        trigger.fire(.success)
        let first = trigger
        trigger.fire(.success)
        XCTAssertEqual(trigger.kind, .success)
        XCTAssertNotEqual(first, trigger, "a repeated kind still changes the trigger")
        trigger.fire(.error)
        XCTAssertEqual(trigger.kind, .error)
        XCTAssertEqual(trigger.count, 3)
    }
}
