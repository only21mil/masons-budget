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
    case tasks
    case billPay
    case transfer
    case netWorth
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
    ]
}

enum MoreCountFormatter {
    static func badge(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count > 999 ? "999+" : String(count)
    }
}
