import Foundation
import XCTest

final class AppAuthenticationStateTests: XCTestCase {
    private func active(_ member: FamilyMember = .victor, locked: Bool = true) -> AppAuthenticationState {
        var state = AppAuthenticationState(profileRaw: member.rawValue, lockEnabled: locked)
        _ = state.transition(to: .active)
        return state
    }

    private func unlocked(_ member: FamilyMember = .victor, at: TimeInterval = 100) -> AppAuthenticationState {
        var state = active(member)
        let id = state.begin(.unlock)!
        XCTAssertEqual(state.complete(id, success: true, at: at), .unlocked)
        return state
    }

    func testImmediateAdultSwitchConsumesGrantWithoutRefreshingIt() {
        var state = unlocked()
        XCTAssertTrue(state.reuseUnlock(to: .rachel, at: 114.999))
        XCTAssertEqual(state.profileRaw, "rachel")
        XCTAssertFalse(state.reuseUnlock(to: .victor, at: 115))
        let id = state.begin(.switchProfile(.victor))!
        XCTAssertEqual(state.complete(id, success: true, at: 116), .switched(.victor))
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 117))
    }

    func testExpiryAndClockRegressionFailClosed() {
        for time in [115.0, 116, 99, .infinity, .nan] {
            var state = unlocked()
            XCTAssertFalse(state.reuseUnlock(to: .rachel, at: time))
            XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        }
    }

    func testDisabledLockAndRelaunchNeverHaveGrant() {
        var disabled = active(locked: false)
        XCTAssertTrue(disabled.isUnlocked)
        XCTAssertFalse(disabled.reuseUnlock(to: .rachel, at: 101))
        XCTAssertNil(disabled.begin(.unlock))
        var relaunched = active()
        XCTAssertFalse(relaunched.isUnlocked)
        XCTAssertFalse(relaunched.reuseUnlock(to: .rachel, at: 101))
    }

    func testChildrenCannotGainAnyOtherTargetEvenAfterSuccessfulUnlock() {
        for child in [FamilyMember.mason, .maddox] {
            for target in FamilyMember.allCases {
                var state = unlocked(child)
                XCTAssertFalse(state.reuseUnlock(to: target, at: 101))
                XCTAssertNil(state.begin(.switchProfile(target)))
            }
        }
    }

    func testAdultToChildRequiresPromptAndDiscardsGrant() {
        var state = unlocked(.rachel)
        XCTAssertFalse(state.reuseUnlock(to: .mason, at: 101))
        XCTAssertFalse(state.reuseUnlock(to: .victor, at: 102))
        let id = state.begin(.switchProfile(.mason))!
        XCTAssertEqual(state.complete(id, success: true, at: 103), .switched(.mason))
        XCTAssertNil(state.begin(.switchProfile(.rachel)))
    }

    func testFailedCancelledAndSupersededCallbacksDoNotUnlock() {
        var state = active()
        let failed = state.begin(.unlock)!
        XCTAssertNil(state.complete(failed, success: false, at: 100))
        XCTAssertFalse(state.isUnlocked)
        XCTAssertNil(state.complete(failed, success: true, at: 101))
        let cancelled = state.begin(.unlock)!
        state.invalidate()
        let replacement = state.begin(.unlock)!
        XCTAssertNil(state.complete(cancelled, success: true, at: 102))
        XCTAssertFalse(state.isUnlocked)
        XCTAssertEqual(state.complete(replacement, success: true, at: 103), .unlocked)
    }

    func testUnrelatedInactiveTransitionInvalidatesGrant() {
        var state = unlocked()
        _ = state.transition(to: .inactive)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        XCTAssertNil(state.begin(.switchProfile(.rachel)))
        _ = state.transition(to: .active)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 102))
    }

    func testOwnBiometricInactiveSuccessWaitsForActiveAndKeepsOriginalClock() {
        var state = active()
        let id = state.begin(.unlock)!
        _ = state.transition(to: .inactive)
        XCTAssertNil(state.complete(id, success: true, at: 100))
        XCTAssertFalse(state.isUnlocked)
        XCTAssertEqual(state.transition(to: .active), .unlocked)
        XCTAssertTrue(state.reuseUnlock(to: .rachel, at: 101))

        var delayed = active()
        let delayedID = delayed.begin(.unlock)!
        _ = delayed.transition(to: .inactive)
        _ = delayed.complete(delayedID, success: true, at: 100)
        XCTAssertEqual(delayed.transition(to: .active), .unlocked)
        XCTAssertFalse(delayed.reuseUnlock(to: .rachel, at: 115))
    }

    func testOwnBiometricCanCompleteAfterActiveReturns() {
        var state = active()
        let id = state.begin(.unlock)!
        _ = state.transition(to: .inactive)
        XCTAssertNil(state.transition(to: .active))
        XCTAssertFalse(state.isUnlocked)
        XCTAssertEqual(state.complete(id, success: true, at: 100), .unlocked)
        XCTAssertTrue(state.reuseUnlock(to: .rachel, at: 101))
    }

    func testRealBackgroundRejectsOwnBiometricPendingAndDeferredSuccess() {
        for successBeforeBackground in [false, true] {
            var state = active()
            let id = state.begin(.unlock)!
            _ = state.transition(to: .inactive)
            if successBeforeBackground { _ = state.complete(id, success: true, at: 100) }
            _ = state.transition(to: .background)
            XCTAssertNil(state.complete(id, success: true, at: 101))
            XCTAssertNil(state.transition(to: .active))
            XCTAssertNil(state.complete(id, success: true, at: 102))
            XCTAssertFalse(state.isUnlocked)
            XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 103))
        }
    }

    func testBackgroundAndDeviceLockInvalidateAlreadyUnlockedState() {
        var state = unlocked()
        _ = state.transition(to: .background)
        XCTAssertFalse(state.isUnlocked)
        _ = state.transition(to: .active)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        state = unlocked()
        state.lock()
        XCTAssertFalse(state.isUnlocked)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
    }

    func testProfileABACannotRestoreGrantOrPendingUnlock() {
        var state = unlocked()
        state.profileChanged(to: "rachel")
        state.profileChanged(to: "victor")
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        state = active()
        let id = state.begin(.unlock)!
        state.profileChanged(to: "rachel")
        state.profileChanged(to: "victor")
        XCTAssertNil(state.complete(id, success: true, at: 100))
        XCTAssertFalse(state.isUnlocked)
    }

    func testProfileABAAndBackgroundRejectLateSwitchResults() {
        var state = active(locked: false)
        let id = state.begin(.switchProfile(.rachel))!
        state.profileChanged(to: "mason")
        state.profileChanged(to: "victor")
        XCTAssertNil(state.complete(id, success: true, at: 100))
        XCTAssertEqual(state.profileRaw, "victor")
        let next = state.begin(.switchProfile(.rachel))!
        _ = state.transition(to: .inactive)
        XCTAssertNil(state.complete(next, success: true, at: 101))
        XCTAssertEqual(state.profileRaw, "victor")
        _ = state.transition(to: .background)
        _ = state.transition(to: .active)
        XCTAssertNil(state.complete(next, success: true, at: 102))
        XCTAssertEqual(state.profileRaw, "victor")
    }

    func testDeferredSwitchCommitsOnceOnlyWhenActive() {
        var state = active(locked: false)
        let id = state.begin(.switchProfile(.rachel))!
        XCTAssertNil(state.begin(.switchProfile(.mason)))
        _ = state.transition(to: .inactive)
        XCTAssertNil(state.complete(id, success: true, at: 100))
        XCTAssertEqual(state.profileRaw, "victor")
        XCTAssertEqual(state.transition(to: .active), .switched(.rachel))
        XCTAssertNil(state.complete(id, success: true, at: 101))
        XCTAssertFalse(state.reuseUnlock(to: .victor, at: 102))
    }

    func testFailedOrCancelledSwitchCannotChangeProfile() {
        var state = unlocked()
        let failed = state.begin(.switchProfile(.rachel))!
        XCTAssertNil(state.complete(failed, success: false, at: 100))
        XCTAssertEqual(state.profileRaw, "victor")
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        let cancelled = state.begin(.switchProfile(.rachel))!
        state.invalidate()
        XCTAssertNil(state.complete(cancelled, success: true, at: 102))
        XCTAssertEqual(state.profileRaw, "victor")
    }

    func testDuplicateDeferredSuccessCannotExtendReuseClock() {
        var state = active()
        let id = state.begin(.unlock)!
        _ = state.transition(to: .inactive)
        XCTAssertNil(state.complete(id, success: true, at: 100))
        XCTAssertNil(state.complete(id, success: true, at: 110))
        XCTAssertEqual(state.transition(to: .active), .unlocked)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 115))
    }

    func testLockPreferenceChangesAndUnknownProfilesFailClosed() {
        var state = unlocked()
        state.setLockEnabled(false)
        XCTAssertFalse(state.reuseUnlock(to: .rachel, at: 101))
        state.setLockEnabled(true)
        XCTAssertFalse(state.isUnlocked)
        let id = state.begin(.unlock)!
        state.setLockEnabled(false)
        state.setLockEnabled(true)
        XCTAssertNil(state.complete(id, success: true, at: 102))
        state.profileChanged(to: "unknown")
        XCTAssertNil(state.begin(.unlock))
        XCTAssertNil(state.begin(.switchProfile(.victor)))
    }
}
