import SwiftUI
import LocalAuthentication

struct LockScreenView: View {
    @Binding var isUnlocked: Bool
    @State private var authError: String?
    @State private var showError = false

    private var biometryIcon: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        default: return "lock.fill"
        }
    }

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(AppTheme.accentColor)

                Text("The Vogel Vault")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(AppTheme.primaryText)

                Text("Tap to unlock")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText)

                Spacer()

                Button {
                    authenticate()
                } label: {
                    Label("Unlock", systemImage: biometryIcon)
                        .font(.headline)
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppTheme.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                }
                .padding(.horizontal, AppTheme.horizontalPadding)

                if showError, let authError {
                    Text(authError)
                        .font(.caption)
                        .foregroundStyle(AppTheme.negative)
                        .padding(.horizontal)
                }

                Spacer()
                    .frame(height: 60)
            }
        }
        .onAppear {
            authenticate()
        }
    }

    private func authenticate() {
        let context = LAContext()
        var error: NSError?

        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock The Vogel Vault"
            ) { success, authenticationError in
                DispatchQueue.main.async {
                    if success {
                        withAnimation(.easeOut(duration: 0.3)) {
                            isUnlocked = true
                        }
                    } else {
                        // Fall back to device passcode
                        authenticateWithPasscode()
                    }
                }
            }
        } else if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            // No biometrics — use device passcode
            authenticateWithPasscode()
        } else {
            // No auth available — unlock directly
            isUnlocked = true
        }
    }

    private func authenticateWithPasscode() {
        let context = LAContext()
        context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: "Unlock The Vogel Vault"
        ) { success, error in
            DispatchQueue.main.async {
                if success {
                    withAnimation(.easeOut(duration: 0.3)) {
                        isUnlocked = true
                    }
                } else {
                    authError = "Authentication failed. Tap to try again."
                    showError = true
                }
            }
        }
    }
}
