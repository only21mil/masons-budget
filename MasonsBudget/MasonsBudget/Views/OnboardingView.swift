import SwiftUI

struct OnboardingView: View {
    @Environment(\.dismiss) var dismiss
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @Environment(\.theme) var theme
    @State private var stepIndex = 0

    private var step: OnboardingStep {
        OnboardingStep.all[stepIndex]
    }

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()
            VStack(spacing: 24) {
                HStack(spacing: 6) {
                    ForEach(OnboardingStep.all.indices, id: \.self) { index in
                        Capsule()
                            .fill(index <= stepIndex ? theme.accent : theme.border)
                            .frame(height: 3)
                    }
                }
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.top, 18)

                Spacer()

                VStack(spacing: 20) {
                    Image(systemName: step.icon)
                        .font(AppFont.iconHero)
                        .foregroundStyle(theme.accent)

                    VStack(spacing: 10) {
                        Text(step.eyebrow)
                            .font(AppFont.monoMicroStrong)
                            .foregroundStyle(theme.accent)
                        Text(step.title)
                            .font(AppFont.largeNumber)
                            .foregroundStyle(theme.text)
                            .multilineTextAlignment(.center)
                        Text(step.message)
                            .font(AppFont.bodyRegular)
                            .foregroundStyle(theme.textMuted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 420)
                    }
                }
                .padding(.horizontal, 32)

                Spacer()

                Button {
                    advance()
                } label: {
                    Text(stepIndex == OnboardingStep.all.count - 1 ? "Open Vogel Vault" : "Continue")
                        .font(AppFont.bodyStrong)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusSmall))
                }
                .padding(.horizontal, AppLayout.sectionPadding)

                if stepIndex > 0 {
                    Button("Back") { stepIndex -= 1 }
                        .font(AppFont.labelLarge)
                        .foregroundStyle(theme.textMuted)
                        .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 28)
        }
    }

    private func advance() {
        if stepIndex < OnboardingStep.all.count - 1 {
            stepIndex += 1
        } else {
            hasCompletedOnboarding = true
            dismiss()
        }
    }
}
