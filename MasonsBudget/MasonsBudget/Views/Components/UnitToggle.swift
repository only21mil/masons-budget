import SwiftUI

struct UnitToggle: View {
    @Binding var unit: BitcoinDisplayUnit

    var body: some View {
        HStack(spacing: 0) {
            ForEach(BitcoinDisplayUnit.allCases) { option in
                Button {
                    withAnimation(.easeInOut(duration: AppTheme.durationFast)) {
                        unit = option
                    }
                } label: {
                    Text(option.label)
                        .font(.system(size: 10.5, weight: .bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(unit == option ? AppTheme.accentColor : .clear)
                        )
                        .foregroundStyle(unit == option ? .white : AppTheme.secondaryText)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(
            Capsule()
                .fill(AppTheme.surface2)
                .overlay(Capsule().strokeBorder(AppTheme.cardBorder, lineWidth: 1))
        )
    }
}
