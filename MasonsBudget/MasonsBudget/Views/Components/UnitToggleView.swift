import SwiftUI

enum UnitToggleSize {
    case sm, lg

    var height: CGFloat {
        switch self {
        case .sm: 26
        case .lg: 32
        }
    }

    var fontSize: CGFloat {
        switch self {
        case .sm: 10.5
        case .lg: 12
        }
    }

    var horizontalPadding: CGFloat {
        switch self {
        case .sm: 8
        case .lg: 11
        }
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
                        .font(.system(size: size.fontSize, weight: .bold))
                        .tracking(0.04 * size.fontSize)
                        .foregroundStyle(unit == u ? .white : theme.textMuted)
                        .frame(height: size.height)
                        .padding(.horizontal, size.horizontalPadding)
                        .background(unit == u ? theme.accent : .clear)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(theme.surface2)
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(theme.border, lineWidth: 1)
        )
    }
}
