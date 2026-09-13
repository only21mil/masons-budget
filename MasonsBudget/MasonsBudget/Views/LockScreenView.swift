import SwiftUI

struct LockScreenView: View {
    @EnvironmentObject private var authentication: AppAuthenticationSession
    @Environment(\.theme) var theme
    @State private var attemptedAutomaticUnlock = false

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()
            VStack(spacing: 24) {
                Image(systemName: "lock.shield.fill")
                    .font(AppFont.iconXL)
                    .foregroundStyle(theme.accent)
                Text("Vogel Vault")
                    .ledgerType(.screenTitle)
                    .foregroundStyle(theme.text)
                Button("Unlock") {
                    attemptedAutomaticUnlock = true
                    authentication.unlock()
                }
                    .disabled(authentication.isAuthenticating || !authentication.isActive)
                    .ledgerType(.button)
                    .foregroundStyle(theme.onAccent)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(theme.accentFill)
                    .clipShape(Capsule())

                if let authError = authentication.error {
                    Text(authError)
                        .ledgerType(.body)
                        .foregroundStyle(theme.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
        }
        .onAppear { unlockOnFirstActiveAppearance() }
        .onChange(of: authentication.isActive) { _, active in
            if active { unlockOnFirstActiveAppearance() }
        }
        .onDisappear { authentication.cancelPendingAuthentication() }
    }

    private func unlockOnFirstActiveAppearance() {
        guard authentication.isActive, !attemptedAutomaticUnlock else { return }
        attemptedAutomaticUnlock = true
        authentication.unlock()
    }
}
