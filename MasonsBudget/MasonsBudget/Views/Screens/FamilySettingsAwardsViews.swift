import SwiftData
import SwiftUI

struct FamilyView: View {
    @Environment(\.theme) private var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @State private var showProfileSwitcher = false

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var scope: FamilyScopePresentation {
        FamilyScopePresentation.forMember(activeMember)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Family", eyebrow: "Visibility scope")

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("ACTIVE PROFILE")
                                .font(AppFont.monoMicroStrong)
                                .foregroundStyle(theme.textMuted)
                            Text(activeMember.displayName)
                                .font(AppFont.title)
                                .foregroundStyle(theme.text)
                        }
                        Spacer()
                        Button("SWITCH") { showProfileSwitcher = true }
                            .font(AppFont.monoMicroStrong)
                            .foregroundStyle(theme.accent)
                            .buttonStyle(.plain)
                    }

                    Hairline()

                    Text(activeScopeMessage)
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                }
                .glassCard(padding: 16, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    scopeRow("FINANCE VISIBILITY", value: scope.finance)
                    Hairline()
                    scopeRow("PRIVATE TASKS", value: scope.tasks)
                    Hairline()
                    scopeRow("NET WORTH TOTAL", value: scope.netWorth)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    ForEach(Array(FamilyMember.allCases.enumerated()), id: \.element.id) { index, member in
                        memberRow(member)
                        if index < FamilyMember.allCases.count - 1 {
                            Hairline(indent: 54)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(alignment: .leading, spacing: 8) {
                    Text("HOUSEHOLD SCOPING")
                        .font(AppFont.monoMicroStrong)
                        .foregroundStyle(theme.accent)
                    Text("Victor and Rachel share one adult financial ledger. Adults can view kid data, but kid balances never roll into adult net worth. Mason and Maddox see only their own records.")
                        .font(AppFont.labelRegular)
                        .foregroundStyle(theme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Family")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .sheet(isPresented: $showProfileSwitcher) {
                ProfileSwitcherView()
            }
    }

    private var activeScopeMessage: String {
        activeMember.isAdult
            ? "Household finances and child oversight are visible. Tasks stay private to \(activeMember.displayName), and adult net worth remains adult-only."
            : "Only \(activeMember.displayName)'s finances, tasks, and net worth are visible. Adult and sibling data remain outside this profile."
    }

    private func scopeRow(_ label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(theme.textMuted)
            Spacer()
            Text(value)
                .font(AppFont.smallRegular)
                .foregroundStyle(theme.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(14)
    }

    private func memberRow(_ member: FamilyMember) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9)
                .fill(member == activeMember ? theme.accentSoft : theme.surface2)
                .frame(width: 38, height: 38)
                .overlay(
                    Text(String(member.displayName.prefix(1)))
                        .font(AppFont.labelStrong)
                        .foregroundStyle(member == activeMember ? theme.accent : theme.textMuted),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(member.displayName)
                    .font(AppFont.bodyStrong)
                    .foregroundStyle(theme.text)
                Text(member.isAdult ? "Shared adult household" : "Isolated kid profile")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
            Spacer()
            Text(member == activeMember ? "ACTIVE" : (activeMember.canSee(dataOwnedBy: member) ? "VISIBLE" : "PRIVATE"))
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(member == activeMember ? theme.accent : theme.textFaint)
        }
        .padding(14)
    }
}

struct SettingsView: View {
    @Environment(\.theme) private var theme
    @AppStorage("appearance_mode") private var appearanceRaw = AppearanceMode.system.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Settings", eyebrow: "Apple client")

                VStack(spacing: 0) {
                    settingsPicker("APPEARANCE", selection: $appearanceRaw) {
                        ForEach(AppearanceMode.allCases) { mode in
                            Text(mode.label).tag(mode.rawValue)
                        }
                    }
                    Hairline()
                    settingsPicker("DISPLAY UNIT", selection: $displayUnitRaw) {
                        ForEach(DisplayUnit.allCases) { unit in
                            Text(unit.label).tag(unit.rawValue)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    Toggle(isOn: $appLockEnabled) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("APP LOCK")
                                .font(AppFont.monoMicroStrong)
                                .foregroundStyle(theme.text)
                            Text("Require device authentication when the app opens")
                                .font(AppFont.smallRegular)
                                .foregroundStyle(theme.textMuted)
                        }
                    }
                    .tint(theme.accent)
                    .padding(14)

                    Hairline()

                    Button {
                        hasCompletedOnboarding = false
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "arrow.counterclockwise")
                                .foregroundStyle(theme.accent)
                                .frame(width: 28)
                            Text("REPLAY ONBOARDING")
                                .font(AppFont.monoCaptionStrong)
                                .foregroundStyle(theme.text)
                            Spacer()
                        }
                        .padding(14)
                    }
                    .buttonStyle(.plain)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 0) {
                    settingsLink("FAMILY", icon: "person.3.fill", destination: FamilyView())
                    Hairline(indent: 54)
                    settingsLink("SYNC SETUP", icon: "arrow.triangle.2.circlepath", destination: SyncSetupView())
                    Hairline(indent: 54)
                    settingsLink("EXPORT", icon: "square.and.arrow.up", destination: ExportView())
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                Text("Export keeps its existing format and behavior. Settings do not widen profile visibility or task-write authority.")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textFaint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AppLayout.sectionPadding + 4)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Settings")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func settingsPicker(
        _ label: String,
        selection: Binding<String>,
        @ViewBuilder content: () -> some View,
    ) -> some View {
        HStack {
            Text(label)
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(theme.textMuted)
            Spacer()
            Picker(label, selection: selection, content: content)
                .labelsHidden()
        }
        .padding(14)
    }

    private func settingsLink(_ label: String, icon: String, destination: some View) -> some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .foregroundStyle(theme.accent)
                    .frame(width: 28)
                Text(label)
                    .font(AppFont.monoCaptionStrong)
                    .foregroundStyle(theme.text)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(AppFont.microStrong)
                    .foregroundStyle(theme.textMuted)
            }
            .padding(14)
        }
        .buttonStyle(.plain)
    }
}

struct AwardsView: View {
    @Environment(\.theme) private var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query private var allTransactions: [Transaction]
    @Query private var allTodos: [TodoItem]
    @Query private var allBuys: [BTCBuy]

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var visibleTransactions: [Transaction] {
        allTransactions.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }
    }

    private var visibleTodos: [TodoItem] {
        allTodos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
    }

    private var visibleBuys: [BTCBuy] {
        allBuys.filter {
            guard let owner = $0.ownerMember else { return false }
            return activeMember.canSee(dataOwnedBy: owner)
        }
    }

    private var awards: [LedgerAward] {
        [
            LedgerAward(title: "First entry", detail: "Record one ledger transaction", icon: "list.bullet.rectangle", earned: !visibleTransactions.isEmpty),
            LedgerAward(title: "Stacking", detail: "Log a Bitcoin buy", icon: "bitcoinsign.circle.fill", earned: !visibleBuys.isEmpty),
            LedgerAward(title: "Clear the board", detail: "Complete a task", icon: "checkmark.circle.fill", earned: visibleTodos.contains(where: \.isDone)),
            LedgerAward(title: "Ten clean closes", detail: "Complete ten tasks", icon: "flag.checkered", earned: visibleTodos.filter(\.isDone).count >= 10),
        ]
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppLayout.cardSpacing) {
                ScreenHeader(title: "Awards", eyebrow: "Ledger progress") {
                    Text("\(awards.filter(\.earned).count)/\(awards.count)")
                        .font(AppFont.monoCaptionStrong)
                        .foregroundStyle(theme.accent)
                }

                VStack(spacing: 0) {
                    ForEach(Array(awards.enumerated()), id: \.element.title) { index, award in
                        awardRow(award)
                        if index < awards.count - 1 {
                            Hairline(indent: 58)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Awards")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func awardRow(_ award: LedgerAward) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(award.earned ? theme.accentSoft : theme.surface2)
                .frame(width: 42, height: 42)
                .overlay(
                    Image(systemName: award.icon)
                        .font(AppFont.iconSmall)
                        .foregroundStyle(award.earned ? theme.accent : theme.textFaint),
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(award.title)
                    .font(AppFont.bodyStrong)
                    .foregroundStyle(theme.text)
                Text(award.detail)
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
            Spacer()
            Text(award.earned ? "EARNED" : "LOCKED")
                .font(AppFont.monoMicroStrong)
                .foregroundStyle(award.earned ? theme.success : theme.textFaint)
        }
        .padding(14)
    }
}

private struct LedgerAward {
    let title: String
    let detail: String
    let icon: String
    let earned: Bool
}
