import Foundation

enum ApplePrimaryScreen: String, CaseIterable, Identifiable {
    case bitcoin
    case budget
    case today
    case retirement
    case more

    var id: String {
        rawValue
    }
}

enum AppleMoreScreen: String, CaseIterable, Identifiable {
    case price
    case activity
    case bitcoinBuys
    case billPay
    case transfer
    case netWorth
    case tasks
    case family
    case awards
    case settings
    case sync
    case export

    var id: String {
        rawValue
    }
}

enum PaymentRailPresentation: String, CaseIterable {
    case bolt = "Bolt"
    case chain = "Chain"

    var icon: String {
        switch self {
        case .bolt: "bolt.fill"
        case .chain: "link"
        }
    }

    init(activityRail: TransactionSourceCatalog.ActivityRail) {
        switch activityRail {
        case .lightning: self = .bolt
        case .onChain: self = .chain
        }
    }

    static func forCard(_ card: String?) -> PaymentRailPresentation? {
        TransactionSourceCatalog.activityRail(forCard: card).map(PaymentRailPresentation.init)
    }
}

struct FamilyScopePresentation: Equatable {
    let finance: String
    let tasks: String
    let netWorth: String

    static func forMember(_ member: FamilyMember) -> FamilyScopePresentation {
        if member.isAdult {
            return FamilyScopePresentation(
                finance: "Adult household + child oversight",
                tasks: "\(member.displayName) only",
                netWorth: "Adult household only",
            )
        }

        return FamilyScopePresentation(
            finance: "\(member.displayName) only",
            tasks: "\(member.displayName) only",
            netWorth: "\(member.displayName) only",
        )
    }
}

enum RiverBillPayFeePolicy {
    static let guidance = "Enter the exact fee shown by River. Vogel Vault does not infer a fee from the payment amount."

    static func fee(forAmount _: Decimal, manualFee: Decimal?) -> Decimal? {
        manualFee
    }
}

struct OnboardingStep: Equatable {
    let eyebrow: String
    let title: String
    let message: String
    let icon: String

    static let all: [OnboardingStep] = [
        OnboardingStep(
            eyebrow: "01 · LEDGER",
            title: "See the whole stack",
            message: "Track Bitcoin, spending, retirement, and tasks without mixing household and kid balances.",
            icon: "bitcoinsign.circle.fill",
        ),
        OnboardingStep(
            eyebrow: "02 · FAMILY",
            title: "One household, scoped views",
            message: "Victor and Rachel share the adult ledger. Mason and Maddox stay isolated in their own profiles.",
            icon: "person.3.fill",
        ),
        OnboardingStep(
            eyebrow: "03 · READY",
            title: "Work from today",
            message: "Review money out, finish tasks, and move through the Bitcoin ledger from one daily view.",
            icon: "checkmark.circle.fill",
        ),
        OnboardingStep(
            eyebrow: "04 · CONNECT",
            title: "Connect your household",
            message: "Open Sync Setup to connect this device and load your household data.",
            icon: "arrow.triangle.2.circlepath",
        ),
    ]

    static func progressLabel(for index: Int) -> String {
        let boundedIndex = min(max(index, 0), all.count - 1)
        return "Step \(boundedIndex + 1) of \(all.count)"
    }
}

enum MoreCountFormatter {
    static func badge(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count > 999 ? "999+" : String(count)
    }
}
