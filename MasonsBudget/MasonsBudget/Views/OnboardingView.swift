import SwiftUI

struct OnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("has_completed_onboarding") private var hasCompleted = false
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @State private var step = 0

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    /// Total steps vary by profile — kids skip the voice step
    private var totalSteps: Int {
        currentMember.showsFullBudget ? 3 : 3
    }

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                Group {
                    if currentMember.showsFullBudget {
                        // Adults: welcome → profile → voice → ready
                        switch step {
                        case 0: welcomeStep
                        case 1: profileStep
                        case 2: voiceStep
                        case 3: readyStep
                        default: EmptyView()
                        }
                    } else {
                        // Kids: welcome → profile → Bitcoin → ready
                        switch step {
                        case 0: welcomeStep
                        case 1: profileStep
                        case 2: bitcoinStep
                        case 3: readyStep
                        default: EmptyView()
                        }
                    }
                }
                .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                .animation(.easeInOut(duration: 0.4), value: step)

                Spacer()

                HStack(spacing: 16) {
                    if step > 0 {
                        Button("Back") {
                            step -= 1
                        }
                        .foregroundStyle(AppTheme.secondaryText)
                    }
                    Button(step < totalSteps ? "Next" : "Get Started") {
                        if step < totalSteps {
                            step += 1
                        } else {
                            completeOnboarding()
                        }
                    }
                    .font(.headline)
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(AppTheme.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.bottom, 40)
            }
        }
    }

    // MARK: - Steps

    private var welcomeStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.accentColor)

            Text("The Vogel Vault")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)

            Text("Family finance, Bitcoin stacking,\nand budgeting — all in one place.")
                .font(.body)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    private var profileStep: some View {
        VStack(spacing: 24) {
            Text("Who are you?")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            Text("Pick your profile. The app remembers\nyour choice on this device.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)

            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 16),
                GridItem(.flexible(), spacing: 16)
            ], spacing: 16) {
                ForEach(FamilyMember.allCases) { member in
                    ProfileCard(
                        member: member,
                        isSelected: selectedMember == member.rawValue
                    ) {
                        selectedMember = member.rawValue
                    }
                }
            }
            .padding(.horizontal, 32)
        }
    }

    private var voiceStep: some View {
        VStack(spacing: 24) {
            ZStack {
                Circle()
                    .fill(AppTheme.accentColor.opacity(0.15))
                    .frame(width: 120, height: 120)
                Image(systemName: "mic.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(AppTheme.accentColor)
            }

            Text("Speak Your Transactions")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            VStack(spacing: 12) {
                onboardingBullet("Tap the mic", "Use the floating mic button on the Dashboard")
                onboardingBullet("Say it naturally", "\"$45 at Costco on Strike\"")
                onboardingBullet("Confirm & save", "Review the parsed result and tap Save")
            }
            .padding(.horizontal, 24)
        }
    }

    private var bitcoinStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "bitcoinsign.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.accentColor)

            Text("Your Bitcoin Stack")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            VStack(spacing: 12) {
                onboardingBullet("Track your sats", "See your Strike, River, and cold storage balances")
                onboardingBullet("Watch it grow", "Your stack updates automatically when data syncs")
                onboardingBullet("Your own vault", "Private to your profile on this device")
            }
            .padding(.horizontal, 24)
        }
    }

    private var readyStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.positive)

            Text("You're All Set, \(currentMember.displayName)")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            if currentMember.showsFullBudget {
                Text("Tap the mic to log your first transaction.\nYour budget, net worth, and Bitcoin stack are ready.")
                    .font(.body)
                    .foregroundStyle(AppTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            } else {
                Text("Your Bitcoin stack is ready to view.\nCheck your sats anytime.")
                    .font(.body)
                    .foregroundStyle(AppTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    // MARK: - Helpers

    private func onboardingBullet(_ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(AppTheme.accentColor)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.primaryText)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            Spacer()
        }
    }

    private func completeOnboarding() {
        hasCompleted = true
        dismiss()
    }
}

// MARK: - Profile card

private struct ProfileCard: View {
    let member: FamilyMember
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 10) {
                Image(systemName: member.icon)
                    .font(.system(size: 32))
                    .foregroundStyle(isSelected ? .black : AppTheme.accentColor)

                Text(member.displayName)
                    .font(.headline)
                    .foregroundStyle(isSelected ? .black : AppTheme.primaryText)

                Text(member.profileDescription)
                    .font(.caption2)
                    .foregroundStyle(isSelected ? .black.opacity(0.7) : AppTheme.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 8)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .fill(isSelected ? AppTheme.accentColor : AppTheme.cardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                    .strokeBorder(isSelected ? AppTheme.accentColor : AppTheme.cardBorder, lineWidth: 1)
            )
        }
    }
}
