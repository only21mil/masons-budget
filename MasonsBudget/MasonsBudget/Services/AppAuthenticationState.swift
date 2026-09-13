import Foundation

/// Ephemeral authorization for the lock screen and profile picker. No persisted trust.
struct AppAuthenticationState {
    enum Phase { case active, inactive, background }
    enum Purpose: Equatable { case unlock, switchProfile(FamilyMember) }
    enum Outcome: Equatable { case unlocked, switched(FamilyMember) }

    struct Attempt {
        let id: UUID
        let source: String
        let purpose: Purpose
        var successfulAt: TimeInterval?
    }

    private struct RecentUnlock {
        let source: String
        let at: TimeInterval
    }

    static let reuseDuration: TimeInterval = 15
    private(set) var profileRaw: String
    private(set) var lockEnabled: Bool
    private(set) var isUnlocked: Bool
    private(set) var phase: Phase = .inactive
    private(set) var attempt: Attempt?
    private var recentUnlock: RecentUnlock?

    init(profileRaw: String, lockEnabled: Bool) {
        self.profileRaw = profileRaw
        self.lockEnabled = lockEnabled
        isUnlocked = !lockEnabled
    }

    mutating func profileChanged(to raw: String) {
        guard raw != profileRaw else { return }
        invalidate()
        profileRaw = raw
    }

    mutating func setLockEnabled(_ enabled: Bool) {
        guard enabled != lockEnabled else { return }
        invalidate()
        lockEnabled = enabled
        isUnlocked = !enabled
    }

    mutating func lock() {
        invalidate()
        isUnlocked = !lockEnabled
    }

    mutating func invalidate() {
        attempt = nil
        recentUnlock = nil
    }

    mutating func transition(to phase: Phase) -> Outcome? {
        self.phase = phase
        switch phase {
        case .background:
            lock()
        case .inactive:
            // The system authentication UI can make the scene inactive. Keep only
            // the pending attempt, never a reusable grant from an earlier unlock.
            recentUnlock = nil
        case .active:
            if let pending = attempt, let at = pending.successfulAt {
                return commit(pending, at: at)
            }
        }
        return nil
    }

    mutating func begin(_ purpose: Purpose) -> UUID? {
        guard phase == .active, attempt == nil else { return nil }
        recentUnlock = nil
        switch purpose {
        case .unlock:
            guard lockEnabled, !isUnlocked, FamilyMember(rawValue: profileRaw) != nil else { return nil }
        case let .switchProfile(target):
            guard canSwitch(to: target) else { return nil }
        }
        let pending = Attempt(id: UUID(), source: profileRaw, purpose: purpose)
        attempt = pending
        return pending.id
    }

    mutating func complete(_ id: UUID, success: Bool, at: TimeInterval) -> Outcome? {
        guard var pending = attempt, pending.id == id, pending.source == profileRaw,
              pending.successfulAt == nil
        else { return nil }
        guard success, at.isFinite, at >= 0, phase != .background else {
            invalidate()
            return nil
        }
        guard phase == .active else {
            pending.successfulAt = at
            attempt = pending
            return nil
        }
        return commit(pending, at: at)
    }

    mutating func reuseUnlock(to target: FamilyMember, at now: TimeInterval) -> Bool {
        guard phase == .active, attempt == nil, canSwitch(to: target) else { return false }
        let grant = recentUnlock
        recentUnlock = nil // A switch attempt consumes the opportunity, even if expired.
        guard let grant, grant.source == profileRaw,
              let source = FamilyMember(rawValue: profileRaw), source.isAdult, target.isAdult,
              now.isFinite, now >= grant.at, now - grant.at < Self.reuseDuration
        else { return false }
        profileChanged(to: target.rawValue)
        return true
    }

    private func canSwitch(to target: FamilyMember) -> Bool {
        guard isUnlocked, let source = FamilyMember(rawValue: profileRaw) else { return false }
        return target != source && source.allowedSwitchTargets.contains(target)
    }

    private mutating func commit(_ pending: Attempt, at: TimeInterval) -> Outcome? {
        guard phase == .active, attempt?.id == pending.id, pending.source == profileRaw else { return nil }
        attempt = nil
        switch pending.purpose {
        case .unlock:
            guard lockEnabled, !isUnlocked else { return nil }
            isUnlocked = true
            if FamilyMember(rawValue: profileRaw)?.isAdult == true {
                recentUnlock = RecentUnlock(source: profileRaw, at: at)
            }
            return .unlocked
        case let .switchProfile(target):
            guard canSwitch(to: target) else { return nil }
            profileChanged(to: target.rawValue)
            return .switched(target)
        }
    }
}
