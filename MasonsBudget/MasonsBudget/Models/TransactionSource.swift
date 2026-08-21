import Foundation

enum TransactionActivityType: String, CaseIterable, Identifiable {
    case spend
    case btcBillPay
    case btcBuy
    case income
    case transfer

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .spend: "Spend"
        case .btcBillPay: "Bill Pay"
        case .btcBuy: "BTC Buy"
        case .income: "Income"
        case .transfer: "Transfer"
        }
    }

    var noteLabel: String {
        switch self {
        case .spend: "Spend"
        case .btcBillPay: "BTC Bill Pay"
        case .btcBuy: "BTC Buy"
        case .income: "Income"
        case .transfer: "Transfer"
        }
    }
}

// MARK: - Payment-source catalogue
//
// Mirrors shared/domain/fixtures/payment-source-cases.json (contract a5c29efb,
// contractVersion 2) position for position: the `common` array order is the
// canonical picker order, and the fixture order must never drift from it.
// The `wire` is the value persisted and sent to the server; `label` is
// display-only. Unknown or retired wires on existing rows keep round-tripping
// — `sources(for:including:)` re-surfaces a legacy value instead of dropping it.

enum TransactionSourceClassification: Hashable {
    case bitcoinNative
    case fiatCard
    case billPay

    /// Carried over from the old `isBitcoinNative` flag: only bitcoin-native
    /// sources post sats alongside the fiat amount.
    var isBitcoinNative: Bool {
        self == .bitcoinNative
    }
}

struct TransactionSourceOption: Identifiable, Hashable {
    /// The wire value that is persisted and sent. Never renamed once shipped.
    let wire: String

    /// Display-only. Free to change without a migration.
    let label: String

    let classification: TransactionSourceClassification
    let supportedActivities: Set<TransactionActivityType>

    var isBitcoinNative: Bool {
        classification.isBitcoinNative
    }

    var id: String {
        wire
    }
}

enum TransactionSourceCatalog {
    static let none = ""

    static let common: [TransactionSourceOption] = [
        TransactionSourceOption(wire: "river", label: "River", classification: .bitcoinNative, supportedActivities: [.spend, .income, .transfer]),
        TransactionSourceOption(wire: "zeus_lightning", label: "Zeus Lightning", classification: .bitcoinNative, supportedActivities: [.spend, .income, .transfer]),
        TransactionSourceOption(wire: "zeus_on_chain", label: "Zeus On-chain", classification: .bitcoinNative, supportedActivities: [.spend, .income, .transfer]),
        TransactionSourceOption(wire: "strike", label: "Strike", classification: .bitcoinNative, supportedActivities: [.spend, .income, .transfer]),
        TransactionSourceOption(wire: "coinbase_card", label: "Coinbase Card", classification: .fiatCard, supportedActivities: [.spend]),
        TransactionSourceOption(wire: "aven", label: "Aven", classification: .fiatCard, supportedActivities: [.spend]),
        TransactionSourceOption(wire: "sofi_card", label: "SoFi Card", classification: .fiatCard, supportedActivities: [.spend]),
        TransactionSourceOption(wire: "capital_one_vx", label: "Capital One VX", classification: .fiatCard, supportedActivities: [.spend]),
        TransactionSourceOption(wire: "river_bitcoin_bill_pay", label: "River Bitcoin Bill Pay", classification: .billPay, supportedActivities: [.btcBillPay]),
    ]

    /// Options supporting an activity, in canonical picker order. A legacy or
    /// retired wire already stored on the row is re-inserted at the front so it
    /// still displays and round-trips instead of silently vanishing.
    static func sources(for activity: TransactionActivityType, including current: String? = nil) -> [TransactionSourceOption] {
        var options = common.filter { $0.supportedActivities.contains(activity) }

        if let current = current?.trimmingCharacters(in: .whitespacesAndNewlines),
           !current.isEmpty,
           !options.contains(where: { $0.wire == current })
        {
            options.insert(
                TransactionSourceOption(
                    wire: current,
                    label: current,
                    classification: .fiatCard,
                    supportedActivities: [activity]
                ),
                at: 0
            )
        }

        return options
    }

    /// Wire values for persistence, in canonical picker order.
    static func wires(for activity: TransactionActivityType, including current: String? = nil) -> [String] {
        sources(for: activity, including: current).map(\.wire)
    }

    /// Labels for display, in canonical picker order.
    static func labels(for activity: TransactionActivityType, including current: String? = nil) -> [String] {
        sources(for: activity, including: current).map(\.label)
    }

    /// Default wire for a new row of the given activity.
    static func defaultSource(for type: TransactionActivityType) -> String {
        switch type {
        case .spend: "sofi_card"
        case .btcBillPay: "river_bitcoin_bill_pay"
        case .income: "river"
        case .transfer: "river"
        case .btcBuy:
            // BTC buys are no longer a payment-source activity (they have their
            // own route/catalogue), so there is no default payment source.
            none
        }
    }
}
