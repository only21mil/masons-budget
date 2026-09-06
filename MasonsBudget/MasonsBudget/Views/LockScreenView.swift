import LocalAuthentication
import SwiftUI

struct LockScreenView: View {
    @Binding var isUnlocked: Bool
    @Environment(\.theme) var theme
    @State private var authError: String?

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
                Button("Unlock") { authenticate() }
                    .ledgerType(.button)
                    .foregroundStyle(theme.onAccent)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(theme.accentFill)
                    .clipShape(Capsule())

                if let authError {
                    Text(authError)
                        .ledgerType(.body)
                        .foregroundStyle(theme.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
        }
        .onAppear { authenticate() }
    }

    private func authenticate() {
        let context = LAContext()
        var error: NSError?

        // Fail closed: a device with no passcode/biometrics configured (or an
        // LA lockdown) must stay locked, matching ProfileSwitcherView's
        // convention — unlocking here would expose every credential surface.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            authError = "This device has no screen lock configured. Set a passcode or biometrics in Settings to unlock Vogel Vault."
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Vogel Vault") { success, _ in
            DispatchQueue.main.async {
                if success {
                    authError = nil
                    isUnlocked = true
                } else {
                    authError = "Authentication failed. Tap unlock to try again."
                }
            }
        }
    }
}
