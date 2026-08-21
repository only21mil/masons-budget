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

struct TransactionSourceOption: Identifiable, Hashable {
    let name: String
    let provider: String
    let supportedTypes: Set<TransactionActivityType>
    let isBitcoinNative: Bool

    var id: String {
        name
    }
}

enum TransactionSourceCatalog {
    static let none = ""

    static let common: [TransactionSourceOption] = [
        TransactionSourceOption(name: "Aven Card", provider: "Aven", supportedTypes: [.spend], isBitcoinNative: false),
        TransactionSourceOption(name: "Coinbase One Card", provider: "Coinbase", supportedTypes: [.spend], isBitcoinNative: false),
        TransactionSourceOption(name: "Gemini Card", provider: "Gemini", supportedTypes: [.spend], isBitcoinNative: false),
        TransactionSourceOption(name: "SoFi Card", provider: "SoFi", supportedTypes: [.spend], isBitcoinNative: false),
        TransactionSourceOption(name: "SoFi", provider: "SoFi", supportedTypes: [.spend, .income], isBitcoinNative: false),
        TransactionSourceOption(name: "Cash App", provider: "Cash App", supportedTypes: [.spend, .btcBuy, .income], isBitcoinNative: true),
        TransactionSourceOption(name: "River", provider: "River", supportedTypes: [.spend, .btcBuy, .income, .transfer], isBitcoinNative: true),
        TransactionSourceOption(name: "River Bill Pay", provider: "River", supportedTypes: [.btcBillPay], isBitcoinNative: true),
        TransactionSourceOption(name: "River BTC Buy", provider: "River", supportedTypes: [.btcBuy], isBitcoinNative: true),
        TransactionSourceOption(name: "Strike", provider: "Strike", supportedTypes: [.spend, .btcBillPay, .btcBuy, .income, .transfer], isBitcoinNative: true),
        TransactionSourceOption(name: "Strike Bill Pay", provider: "Strike", supportedTypes: [.btcBillPay], isBitcoinNative: true),
        TransactionSourceOption(name: "Strike BTC Buy", provider: "Strike", supportedTypes: [.btcBuy], isBitcoinNative: true),
        TransactionSourceOption(name: "Coldcard", provider: "Coldcard", supportedTypes: [.transfer], isBitcoinNative: true),
    ]

    static func sources(for type: TransactionActivityType, including current: String? = nil) -> [String] {
        var names = common
            .filter { $0.supportedTypes.contains(type) }
            .map(\.name)

        if let current = current?.trimmingCharacters(in: .whitespacesAndNewlines),
           !current.isEmpty,
           !names.contains(current)
        {
            names.insert(current, at: 0)
        }

        return names
    }

    static func defaultSource(for type: TransactionActivityType) -> String {
        switch type {
        case .spend: "SoFi Card"
        case .btcBillPay: "River Bill Pay"
        case .btcBuy: "River BTC Buy"
        case .income: "River"
        case .transfer: "River"
        }
    }
}
