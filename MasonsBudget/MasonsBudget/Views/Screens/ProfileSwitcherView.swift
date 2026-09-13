import LocalAuthentication
import SwiftUI

struct ProfileSwitcherView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @State private var authError: String?

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppLayout.cardSpacing) {
                    ScreenHeader(title: "Profiles", eyebrow: "Family vault")

                    VStack(spacing: 0) {
                        ForEach(FamilyMember.allCases) { member in
                            profileRow(member)
                            if member != FamilyMember.allCases.last {
                                Hairline(indent: 60)
                            }
                        }
                    }
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)


                    if let authError {
                        Text(authError)
                            .ledgerType(.body)
                            .foregroundStyle(theme.danger)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    }
                }
                .padding(.bottom, 100)
            }
            .background(theme.bg)
            .navigationTitle("Switch Profile")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .foregroundStyle(theme.accent)
                    }
                }
        }
    }

    private func profileRow(_ member: FamilyMember) -> some View {
        let isSelected = member == activeMember
        let isAllowed = activeMember.allowedSwitchTargets.contains(member)

        return Button {
            select(member)
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(isAllowed ? theme.accentSoft : theme.surface2)
                    .frame(width: 40, height: 40)
                    .overlay(
                        Text(String(member.displayName.prefix(1)))
                            .ledgerType(.rowFigure)
                            .foregroundStyle(isAllowed ? theme.accent : theme.textMuted),
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(member.displayName)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(isAllowed ? theme.text : theme.textMuted)
                    Text(member.profileDescription)
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(theme.accent)
                } else if !isAllowed {
                    Image(systemName: "lock.fill")
                        .font(AppFont.icon(size: 12, weight: .regular))
                        .foregroundStyle(theme.textMuted)
                } else {
                    Image(systemName: AppIcon.arrowRight)
                        .font(AppFont.icon(size: 12, weight: .regular))
                        .foregroundStyle(theme.textMuted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, ledgerTokens.metrics.rowVerticalPadding)
        }
        .buttonStyle(.plain)
        .disabled(!isAllowed || isSelected)
    }

    private func select(_ member: FamilyMember) {
        guard activeMember.allowedSwitchTargets.contains(member), member != activeMember else { return }
        guard activeMember.requiresAuthToSwitch else {
            selectedMemberRaw = member.rawValue
            dismiss()
            return
        }

        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            authError = "Authentication is required before switching profiles."
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Switch Vogel Vault profile") { success, _ in
            DispatchQueue.main.async {
                if success {
                    selectedMemberRaw = member.rawValue
                    authError = nil
                    dismiss()
                } else {
                    authError = "Authentication failed. Try again to switch profiles."
                }
            }
        }
    }
}
