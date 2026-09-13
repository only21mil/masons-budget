import SwiftUI

struct OnboardingView: View {
    @Environment(\.dismiss) var dismiss
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @Environment(\.theme) var theme
    @State private var stepIndex = 0
    @State private var showSyncSetup = false

    private var step: OnboardingStep {
        OnboardingStep.all[stepIndex]
    }

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Text(OnboardingStep.progressLabel(for: stepIndex).uppercased())
                        .ledgerType(.screenSubtitle)
                        .foregroundStyle(theme.textMuted)

                    HStack(spacing: 6) {
                        ForEach(OnboardingStep.all.indices, id: \.self) { index in
                            Capsule()
                                .fill(index <= stepIndex ? theme.accent : theme.border)
                                .frame(height: 3)
                        }
                    }
                    .ledgerAnimation(.progressAndTheme, value: stepIndex)
                }
                .padding(.horizontal, AppLayout.sectionPadding)
                .padding(.top, 18)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(OnboardingStep.progressLabel(for: stepIndex))

                Spacer()

                VStack(spacing: 20) {
                    Image(systemName: step.icon)
                        .font(AppFont.iconHero)
                        .foregroundStyle(theme.accent)

                    VStack(spacing: 10) {
                        Text(step.eyebrow)
                            .ledgerType(.screenSubtitle)
                            .foregroundStyle(theme.accent)
                        Text(step.title)
                            .ledgerType(.screenTitle)
                            .foregroundStyle(theme.text)
                            .multilineTextAlignment(.center)
                        Text(step.message)
                            .ledgerType(.body)
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
                    Text(stepIndex == OnboardingStep.all.count - 1 ? "Open Sync Setup" : "Continue")
                        .ledgerType(.button)
                        .foregroundStyle(theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(theme.accentFill)
                        .clipShape(RoundedRectangle(cornerRadius: AppLayout.radiusSmall))
                }
                .padding(.horizontal, AppLayout.sectionPadding)

                if stepIndex == OnboardingStep.all.count - 1 {
                    Button("Set up later") { finish() }
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.textMuted)
                        .frame(minHeight: 44)
                }

                if stepIndex > 0 {
                    Button("Back") { stepIndex -= 1 }
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.textMuted)
                        .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 28)
        }
        .sheet(isPresented: $showSyncSetup, onDismiss: { finish() }) {
            NavigationStack {
                SyncSetupView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showSyncSetup = false }
                        }
                    }
            }
        }
    }

    private func finish() {
        hasCompletedOnboarding = true
        dismiss()
    }

    private func advance() {
        if stepIndex < OnboardingStep.all.count - 1 {
            stepIndex += 1
        } else {
            showSyncSetup = true
        }
    }
}
