import SwiftUI

struct OnboardingView: View {
    @Environment(\.dismiss) var dismiss
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @Environment(\.theme) var theme

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()
            VStack(spacing: 32) {
                Spacer()

                Image(systemName: "bitcoinsign.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(theme.accent)

                VStack(spacing: 8) {
                    Text("Vogel Vault")
                        .font(AppFont.title)
                        .foregroundStyle(theme.text)
                    Text("Your family Bitcoin & budget dashboard")
                        .font(AppFont.body)
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                Button {
                    hasCompletedOnboarding = true
                    dismiss()
                } label: {
                    Text("Get Started")
                        .font(AppFont.bodyStrong)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusSmall))
                }
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 40)
        }
    }
}
