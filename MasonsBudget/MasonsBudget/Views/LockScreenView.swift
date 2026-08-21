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
                    .font(AppFont.title)
                    .foregroundStyle(theme.text)
                Button("Unlock") { authenticate() }
                    .font(AppFont.bodyStrong)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(theme.accent)
                    .clipShape(Capsule())

                if let authError {
                    Text(authError)
                        .font(AppFont.caption)
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

        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            isUnlocked = true
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
