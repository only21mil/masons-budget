import SwiftUI

struct RangePicker: View {
    enum Range: String, CaseIterable {
        case oneMonth = "1M"
        case threeMonths = "3M"
        case sixMonths = "6M"
        case oneYear = "1Y"
        case all = "All"
    }

    @Binding var selected: Range

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Range.allCases, id: \.self) { range in
                Button {
                    withAnimation(AppTheme.entryAnimation) {
                        selected = range
                    }
                } label: {
                    Text(range.rawValue)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(selected == range ? .black : AppTheme.secondaryText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(
                            selected == range
                                ? AnyShapeStyle(AppTheme.accentColor)
                                : AnyShapeStyle(Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .background(AppTheme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
        )
    }
}

#Preview {
    @Previewable @State var range: RangePicker.Range = .threeMonths
    RangePicker(selected: $range)
        .padding()
        .background(AppTheme.background)
}
