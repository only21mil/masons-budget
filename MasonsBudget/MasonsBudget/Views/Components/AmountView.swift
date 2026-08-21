import SwiftUI

struct AmountView: View {
    let sats: Decimal
    let unit: DisplayUnit
    var size: CGFloat = 17
    var weight: Font.Weight = .semibold
    var color: Color?
    var showSign: Bool = false
    var accent: Bool = false
    var btcPrice: Decimal = 0

    @Environment(\.theme) var theme

    private var isNegative: Bool {
        sats < 0
    }

    private var isPositive: Bool {
        sats > 0
    }

    private var signPrefix: String {
        if showSign {
            return isNegative ? "\u{2212}" : isPositive ? "+" : ""
        }
        return isNegative ? "\u{2212}" : ""
    }

    private var displayColor: Color {
        color ?? (accent ? theme.accent : theme.text)
    }

    private var formattedValue: String {
        let absSats = sats.magnitude
        return AppFormatter.formatAmount(sats: absSats, unit: unit, btcPrice: btcPrice)
    }

    private var unitSuffix: String {
        unit == .usd ? "" : unit.label
    }

    var body: some View {
        HStack(spacing: 0) {
            Text("\(signPrefix)\(unit.prefix)\(formattedValue)")
                .font(AppFont.mono(size: size, weight: weight))
                .foregroundStyle(displayColor)

            if !unitSuffix.isEmpty {
                Text(" \(unitSuffix)")
                    .font(AppFont.mono(size: size * 0.62, weight: .medium))
                    .foregroundStyle(displayColor.opacity(0.55))
            }
        }
        .monospacedDigit()
    }
}

struct RequiredFinancialSourceView: View {
    @Environment(\.theme) private var theme

    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(AppFont.sectionHeaderMedium)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
            Text("Unavailable")
                .font(AppFont.mediumNumberMono)
                .foregroundStyle(theme.text)
            Text(message)
                .font(AppFont.smallRegular)
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}
