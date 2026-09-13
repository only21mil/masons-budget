import SwiftUI

struct AmountView: View {
    let sats: Decimal
    let unit: DisplayUnit
    var role: LedgerTypeRole = .rowFigure
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

    /// The unit label is opaque: an explicit colour stays as given, accent
    /// amounts keep the accent, and everything else drops to the secondary
    /// tier. No alpha on text (contrast audit 2026-09-05).
    private var suffixColor: Color {
        color ?? (accent ? theme.accent : theme.textMuted)
    }

    private var formattedValue: String {
        let absSats = sats.magnitude
        return AppFormatter.formatAmount(sats: absSats, unit: unit, btcPrice: btcPrice)
    }

    private var unitSuffix: String {
        unit == .usd ? "" : unit.label
    }

    /// The unit label sits one tier below the figure: hero decimals under the
    /// price hero, KPI sub under hero and KPI figures, row meta under row figures.
    private var suffixRole: LedgerTypeRole {
        switch role {
        case .priceHero: .priceHeroDecimals
        case .heroNumeral, .amountInput, .kpiValue: .kpiSub
        default: .rowMeta
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text("\(signPrefix)\(unit.prefix)\(formattedValue)")
                .ledgerType(role)
                .foregroundStyle(displayColor)

            if !unitSuffix.isEmpty {
                Text(" \(unitSuffix)")
                    .ledgerType(suffixRole)
                    .foregroundStyle(suffixColor)
            }
        }
    }
}

struct RequiredFinancialSourceView: View {
    @Environment(\.theme) private var theme

    let title: String
    let message: String
    var onRetry: (() -> Void)?
    @State private var showSyncSetup = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            Text("Unavailable")
                .ledgerType(.kpiValue)
                .foregroundStyle(theme.text)
            Text(message)
                .ledgerType(.body)
                .foregroundStyle(theme.textMuted)
            Text("Open Sync Setup to check your household connection.")
                .ledgerType(.body)
                .foregroundStyle(theme.textMuted)
            HStack {
                if let onRetry {
                    Button("Retry", action: onRetry)
                        .frame(minHeight: 44)
                }
                Button("Open Sync Setup") { showSyncSetup = true }
                    .frame(minHeight: 44)
            }
            .ledgerType(.button)
            .foregroundStyle(theme.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .sheet(isPresented: $showSyncSetup) {
            NavigationStack { SyncSetupView() }
        }
    }
}
