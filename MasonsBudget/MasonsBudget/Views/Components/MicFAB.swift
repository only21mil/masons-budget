import SwiftUI

struct MicFAB: View {
    let action: () -> Void
    @State private var isPulsing = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(AppTheme.accentColor.opacity(0.15))
                    .frame(width: 80, height: 80)
                    .scaleEffect(isPulsing ? 1.15 : 1.0)
                    .animation(
                        .easeInOut(duration: 1.8).repeatForever(autoreverses: true),
                        value: isPulsing
                    )

                Circle()
                    .fill(AppTheme.accentColor)
                    .frame(width: 64, height: 64)
                    .shadow(color: AppTheme.accentColor.opacity(0.5), radius: 16)

                Image(systemName: "mic.fill")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(.black)
            }
        }
        .buttonStyle(.plain)
        .padding(.bottom, 24)
        .onAppear { isPulsing = true }
    }
}

#Preview {
    ZStack {
        AppTheme.background.ignoresSafeArea()
        VStack {
            Spacer()
            MicFAB {}
        }
    }
}
