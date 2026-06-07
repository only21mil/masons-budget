import LocalAuthentication
import SwiftUI

struct ProfileSwitcherView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @AppStorage("appearance_mode") private var appearanceModeRaw = AppearanceMode.system.rawValue

    @State private var authError: String?

    private var appearanceMode: AppearanceMode {
        AppearanceMode(rawValue: appearanceModeRaw) ?? .system
    }

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
                    .padding(.horizontal, AppLayout.sectionPadding)

                    appearanceSection

                    if let authError {
                        Text(authError)
                            .font(AppFont.labelSmallRegular)
                            .foregroundStyle(theme.danger)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, AppLayout.sectionPadding)
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

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("APPEARANCE")
                .font(AppFont.labelSmallStrong)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)

            HStack(spacing: 6) {
                ForEach(AppearanceMode.allCases) { mode in
                    let isSelected = mode == appearanceMode
                    Button {
                        appearanceModeRaw = mode.rawValue
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: iconForMode(mode))
                                .font(AppFont.iconSmall)
                            Text(mode.label)
                                .font(AppFont.sectionHeaderMedium)
                        }
                        .foregroundStyle(isSelected ? .white : theme.text)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(isSelected ? theme.accent : theme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(isSelected ? theme.accent : theme.border, lineWidth: 1),
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, AppLayout.sectionPadding)
        }
    }

    private func iconForMode(_ mode: AppearanceMode) -> String {
        switch mode {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
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
                            .font(AppFont.headline)
                            .foregroundStyle(isAllowed ? theme.accent : theme.textMuted),
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(member.displayName)
                        .font(AppFont.bodyStrong)
                        .foregroundStyle(isAllowed ? theme.text : theme.textMuted)
                    Text(member.profileDescription)
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.textMuted)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(theme.accent)
                } else if !isAllowed {
                    Image(systemName: "lock.fill")
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.textMuted)
                } else {
                    Image(systemName: AppIcon.arrowRight)
                        .font(AppFont.labelSmallRegular)
                        .foregroundStyle(theme.textMuted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
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
