import SwiftUI

struct QuickActionButton: View {
    let title: String
    let icon: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(color.gradient)
                    )
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.primaryText)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .glassCard()
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    HStack(spacing: 14) {
        QuickActionButton(title: "Add\nTransaction", icon: "plus.circle.fill", color: AppTheme.accentColor) {}
        QuickActionButton(title: "View\nSpending", icon: "list.bullet.rectangle.fill", color: AppTheme.secondaryAccent) {}
    }
    .padding()
    .background(AppTheme.background)
}
