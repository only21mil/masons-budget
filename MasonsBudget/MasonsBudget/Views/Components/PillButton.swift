import SwiftUI

struct PillButton: View {
    let label: String
    let isActive: Bool
    var accent: Bool = false
    let action: () -> Void

    @Environment(\.theme) var theme

    var body: some View {
        Button(action: action) {
            Text(label)
                .ledgerType(.chip)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget)
                .foregroundStyle(foregroundColor)
                .background(backgroundColor)
                .clipShape(Capsule())
                .ledgerAnimation(.chipAndNavigation, value: isActive)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private var foregroundColor: Color {
        guard isActive else { return theme.textMuted }
        return accent ? theme.onAccent : theme.surface
    }

    private var backgroundColor: Color {
        guard isActive else { return .clear }
        return accent ? theme.accentFill : theme.text
    }
}
