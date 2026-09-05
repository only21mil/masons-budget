import SwiftUI

enum UnitToggleSize {
    case sm, lg

    var height: CGFloat {
        switch self {
        case .sm: 26
        case .lg: 32
        }
    }

    var horizontalPadding: CGFloat {
        switch self {
        case .sm: 8
        case .lg: 11
        }
    }

    /// Both sizes draw the chip role; the large control only gains height and padding.
    var role: LedgerTypeRole {
        .chip
    }
}

struct UnitToggleView: View {
    @Binding var unit: DisplayUnit
    var size: UnitToggleSize = .sm

    @Environment(\.theme) var theme

    var body: some View {
        HStack(spacing: 0) {
            ForEach(DisplayUnit.allCases) { u in
                Button {
                    unit = u
                } label: {
                    Text(u.label)
                        .ledgerType(size.role)
                        .foregroundStyle(unit == u ? .white : theme.textMuted)
                        .frame(height: size.height)
                        .padding(.horizontal, size.horizontalPadding)
                        .background(unit == u ? theme.accent : .clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show amounts in \(u.label)")
            }
        }
        .padding(2)
        .background(theme.surface2)
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(theme.border, lineWidth: 1),
        )
        .ledgerAnimation(.chipAndNavigation, value: unit)
    }
}
