import SwiftUI
import UniformTypeIdentifiers

struct OnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("has_completed_onboarding") private var hasCompleted = false
    @ObservedObject private var folderManager = MC2FolderManager.shared
    @State private var showFolderPicker = false
    @State private var step = 0

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                Group {
                    switch step {
                    case 0: welcomeStep
                    case 1: voiceStep
                    case 2: icloudStep
                    case 3: readyStep
                    default: EmptyView()
                    }
                }
                .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                .animation(.easeInOut(duration: 0.4), value: step)

                Spacer()

                HStack(spacing: 16) {
                    if step > 0 {
                        Button("Back") { step -= 1 }
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Button(step < 3 ? "Next" : "Get Started") {
                        if step < 3 {
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
        #if os(iOS)
        .sheet(isPresented: $showFolderPicker) {
            MC2FolderPicker { url in
                folderManager.saveBookmark(for: url)
            }
        }
        #else
        .fileImporter(
            isPresented: $showFolderPicker,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                folderManager.saveBookmark(for: url)
            }
        }
        #endif
    }

    private var welcomeStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "bitcoinsign.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.accentColor)

            Text("Mason's Budget")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.primaryText)

            Text("A voice-first budget tracker for the whole family.\nBitcoin native. Private. Simple.")
                .font(.body)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)
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
                onboardingBullet("Say it naturally", "\"$45 at Costco on Aven\"")
                onboardingBullet("Confirm & save", "Review the parsed result and tap Save")
            }
            .padding(.horizontal, 24)
        }
    }

    private var icloudStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "icloud.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.secondaryAccent)

            Text("Connect Your Data")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            VStack(spacing: 12) {
                onboardingBullet("iCloud Drive", "Your data stays private in your iCloud")
                onboardingBullet("No banks linked", "Manual + voice entry only — no Plaid, no data sharing")
                onboardingBullet("MC2 sync", "Pick your MC2 folder to sync budgets, net worth, and transactions")
            }
            .padding(.horizontal, 24)

            Button {
                showFolderPicker = true
            } label: {
                Label("Select MC2 Folder", systemImage: "folder.badge.plus")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.accentColor)
            }
        }
    }

    private var readyStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(AppTheme.positive)

            Text("You're All Set")
                .font(.title2.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)

            Text("Tap the mic to log your first transaction.\nYour budget, net worth, and Bitcoin stack are ready.")
                .font(.body)
                .foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

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
