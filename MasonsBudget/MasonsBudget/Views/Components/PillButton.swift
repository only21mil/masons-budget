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
                .font(.system(size: 13, weight: .semibold))
                .tracking(-0.01 * 13)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .foregroundStyle(foregroundColor)
                .background(backgroundColor)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var foregroundColor: Color {
        guard isActive else { return theme.textMuted }
        return accent ? .white : theme.surface
    }

    private var backgroundColor: Color {
        guard isActive else { return .clear }
        return accent ? theme.accent : theme.text
    }
}
