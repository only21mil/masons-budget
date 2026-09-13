import Combine
import LocalAuthentication
import SwiftUI

/// Owns LAContext so a dismissed view or interrupted scene cannot commit a late result.
@MainActor
final class AppAuthenticationSession: ObservableObject {
    @Published private(set) var state: AppAuthenticationState
    @Published private(set) var error: String?
    private var context: LAContext?
    private var completion: (() -> Void)?
    private let defaults: UserDefaults

    var isUnlocked: Bool { state.isUnlocked }
    var isAuthenticating: Bool { state.attempt != nil }
    var isActive: Bool { state.phase == .active }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        state = AppAuthenticationState(
            profileRaw: defaults.string(forKey: "selected_family_member") ?? FamilyMember.victor.rawValue,
            lockEnabled: defaults.object(forKey: "app_lock_enabled") as? Bool ?? true,
        )
    }

    func profileChanged(to raw: String) {
        guard raw != state.profileRaw else { return }
        cancelAuthentication()
        state.profileChanged(to: raw)
    }

    func setLockEnabled(_ enabled: Bool) {
        guard enabled != state.lockEnabled else { return }
        cancelAuthentication()
        state.setLockEnabled(enabled)
    }

    func transition(to phase: ScenePhase) {
        reconcileProfile()
        let outcome: AppAuthenticationState.Outcome?
        switch phase {
        case .active: outcome = state.transition(to: .active)
        case .inactive: outcome = state.transition(to: .inactive)
        case .background: outcome = state.transition(to: .background)
        @unknown default:
            lock()
            return
        }
        if phase == .background { cancelAuthentication() }
        apply(outcome)
    }

    func lock() {
        cancelAuthentication()
        _ = state.transition(to: .background)
    }

    func cancelAuthentication() {
        state.invalidate()
        context?.invalidate()
        context = nil
        completion = nil
        error = nil
    }

    func cancelPendingAuthentication() {
        if isAuthenticating { cancelAuthentication() }
    }

    func unlock() {
        authenticate(.unlock)
    }

    func select(_ member: FamilyMember, completion: @escaping () -> Void) {
        reconcileProfile()
        guard state.phase == .active, !isAuthenticating, state.isUnlocked,
              let source = FamilyMember(rawValue: state.profileRaw),
              source != member, source.allowedSwitchTargets.contains(member)
        else { return }
        if state.reuseUnlock(to: member, at: ProcessInfo.processInfo.systemUptime) {
            defaults.set(member.rawValue, forKey: "selected_family_member")
            error = nil
            completion()
            return
        }
        authenticate(.switchProfile(member), completion: completion)
    }

    private func reconcileProfile() {
        profileChanged(to: defaults.string(forKey: "selected_family_member") ?? FamilyMember.victor.rawValue)
    }

    private func authenticate(_ purpose: AppAuthenticationState.Purpose, completion: (() -> Void)? = nil) {
        reconcileProfile()
        guard let id = state.begin(purpose) else { return }
        error = nil
        self.completion = completion
        let context = LAContext()
        self.context = context
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            cancelAuthentication()
            error = "Authentication is unavailable. Set a device passcode or biometrics to continue."
            return
        }
        let reason = purpose == .unlock ? "Unlock Vogel Vault" : "Switch Vogel Vault profile"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] success, _ in
            let at = ProcessInfo.processInfo.systemUptime
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.reconcileProfile()
                guard self.state.attempt?.id == id else { return }
                let outcome = self.state.complete(id, success: success, at: at)
                if !success {
                    self.cancelAuthentication()
                    self.error = "Authentication failed. Try again to continue."
                } else {
                    self.apply(outcome)
                }
            }
        }
    }

    private func apply(_ outcome: AppAuthenticationState.Outcome?) {
        guard let outcome else { return }
        if case let .switched(member) = outcome {
            defaults.set(member.rawValue, forKey: "selected_family_member")
        }
        context = nil
        error = nil
        let finished = completion
        completion = nil
        finished?()
    }
}
