import SwiftUI

enum BitcoinDisplayUnit: String, CaseIterable, Identifiable {
    case btc
    case sats
    case usd

    var id: String { rawValue }

    var label: String {
        switch self {
        case .btc: "BTC"
        case .sats: "SATS"
        case .usd: "USD"
        }
    }
}

struct BitcoinAmountView: View {
    let btc: Decimal
    let unit: BitcoinDisplayUnit
    var liveBTCPrice: Decimal? = BTCPriceService.storedPrice
    var font: Font = AppTheme.monoData
    var color: Color = AppTheme.primaryText

    var body: some View {
        Text(formatted)
            .font(font)
            .foregroundStyle(color)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }

    private var formatted: String {
        switch unit {
        case .btc:
            return formatBtc(btc)
        case .sats:
            return "\(formatSats(btc)) sats"
        case .usd:
            guard let liveBTCPrice, liveBTCPrice > 0 else {
                return formatCurrency(btc * AppTheme.fallbackBTCPrice)
            }
            return formatCurrency(btc * liveBTCPrice)
        }
    }
}

struct BitcoinUnitPicker: View {
    @Binding var unit: BitcoinDisplayUnit

    var body: some View {
        Picker("Bitcoin unit", selection: $unit) {
            ForEach(BitcoinDisplayUnit.allCases) { option in
                Text(option.label).tag(option)
            }
        }
        .pickerStyle(.segmented)
        .tint(AppTheme.accentColor)
    }
}
