import SwiftData
import SwiftUI

struct FamilyView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
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
                                .ledgerType(.kpiLabel)
                                .foregroundStyle(theme.textMuted)
                            Text(activeMember.displayName)
                                .ledgerType(.screenTitle)
                                .foregroundStyle(theme.text)
                        }
                        Spacer()
                        Button("SWITCH") { showProfileSwitcher = true }
                            .ledgerType(.button)
                            .foregroundStyle(theme.accent)
                            .buttonStyle(.plain)
                    }

                    Hairline()

                    Text(activeScopeMessage)
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.textMuted)
                }
                .glassCard(padding: 16, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                VStack(spacing: 0) {
                    scopeRow("FINANCE VISIBILITY", value: scope.finance)
                    Hairline()
                    scopeRow("PRIVATE TASKS", value: scope.tasks)
                    Hairline()
                    scopeRow("NET WORTH TOTAL", value: scope.netWorth)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                VStack(spacing: 0) {
                    ForEach(Array(FamilyMember.allCases.enumerated()), id: \.element.id) { index, member in
                        memberRow(member)
                        if index < FamilyMember.allCases.count - 1 {
                            Hairline(indent: 54)
                        }
                    }
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                VStack(alignment: .leading, spacing: 8) {
                    Text("HOUSEHOLD SCOPING")
                        .ledgerType(.sectionLabel)
                        .foregroundStyle(theme.accent)
                    Text("Victor and Rachel share one adult financial ledger. Adults can view kid data, but kid balances never roll into adult net worth. Mason and Maddox see only their own records.")
                        .ledgerType(.rowPrimary)
                        .foregroundStyle(theme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            Spacer()
            Text(value)
                .ledgerType(.rowMeta)
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
                        .ledgerType(.rowFigure)
                        .foregroundStyle(member == activeMember ? theme.accent : theme.textMuted),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(member.displayName)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(member.isAdult ? "Shared adult household" : "Isolated kid profile")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }
            Spacer()
            Text(member == activeMember ? "ACTIVE" : (activeMember.canSee(dataOwnedBy: member) ? "VISIBLE" : "PRIVATE"))
                .ledgerType(.chip)
                .foregroundStyle(member == activeMember ? theme.accent : theme.textFaint)
        }
        .padding(14)
    }
}

struct SettingsView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @AppStorage(ConvexSyncService.lastSyncKey) private var lastSync: Double = 0
    @Environment(\.theme) private var theme
    @AppStorage("appearance_mode") private var appearanceRaw = AppearanceMode.system.rawValue
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @AppStorage("has_completed_onboarding") private var hasCompletedOnboarding = false
    @AppStorage(LedgerPreference.scanlinesKey) private var scanlinesEnabled = LedgerPreference.scanlinesDefault
    @AppStorage(LedgerPreference.phosphorGlowKey) private var phosphorGlowEnabled = LedgerPreference.phosphorGlowDefault
    @AppStorage(LedgerPreference.reduceMotionKey) private var reduceMotion = LedgerPreference.reduceMotionDefault

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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                VStack(spacing: 0) {
                    LedgerToggle(
                        "APP LOCK",
                        detail: "Require device authentication when the app opens",
                        isOn: $appLockEnabled,
                    )
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
                                .ledgerType(.rowFigure)
                                .foregroundStyle(theme.text)
                            Spacer()
                        }
                        .padding(14)
                    }
                    .buttonStyle(.plain)
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                HStack {
                    Text("Last successful sync")
                        .ledgerType(.rowPrimary)
                    Spacer()
                    Text(lastSync > 0
                        ? Date(timeIntervalSince1970: lastSync).formatted(date: .abbreviated, time: .shortened)
                        : "Not synced yet")
                        .ledgerType(.rowMeta)
                        .foregroundStyle(theme.textMuted)
                }
                .glassCard()
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                ledgerEffectsCard

                VStack(spacing: 0) {
                    settingsLink("FAMILY", icon: "person.3.fill", destination: FamilyView())
                    Hairline(indent: 54)
                    settingsLink("AWARDS", icon: "medal.fill", destination: AwardsView())
                    Hairline(indent: 54)
                    settingsLink("SYNC SETUP", icon: "arrow.triangle.2.circlepath", destination: SyncSetupView())
                    Hairline(indent: 54)
                    settingsLink("EXPORT", icon: "square.and.arrow.up", destination: ExportView())
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                Text("Export keeps its existing format and behavior. Settings do not widen profile visibility or task-write authority.")
                    .ledgerType(.body)
                    .foregroundStyle(theme.textFaint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter + 4)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .navigationTitle("Settings")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// Texture and glow are preferences, not base layers. Scanlines default
    /// off for new installs; a saved choice is never overridden.
    private var ledgerEffectsCard: some View {
        VStack(spacing: 0) {
            LedgerToggle("SCANLINES", detail: "Terminal texture over the ledger", isOn: $scanlinesEnabled)
                .padding(14)
            Hairline()
            LedgerToggle("PHOSPHOR GLOW", detail: "Glow on the Bitcoin hero in the dark treatment", isOn: $phosphorGlowEnabled)
                .padding(14)
            Hairline()
            LedgerToggle("REDUCE MOTION", detail: "Land every ledger animation immediately", isOn: $reduceMotion)
                .padding(14)
        }
        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
    }

    private func settingsPicker(
        _ label: String,
        selection: Binding<String>,
        @ViewBuilder content: () -> some View,
    ) -> some View {
        HStack {
            Text(label)
                .ledgerType(.kpiLabel)
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
                    .ledgerType(.rowFigure)
                    .foregroundStyle(theme.text)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(AppFont.icon(size: 10, weight: .bold))
                    .foregroundStyle(theme.textMuted)
            }
            .padding(14)
        }
        .buttonStyle(.plain)
    }
}

struct AwardsView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) private var theme
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query private var allTransactions: [Transaction]
    @Query private var allTodos: [TodoItem]
    @Query private var allBuys: [BTCBuy]

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var visibleTransactions: [Transaction] {
        allTransactions.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }
    }

    private var visibleTodos: [TodoItem] {
        allTodos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) }
    }

    private var visibleBuys: [BTCBuy] {
        allBuys.filter {
            guard let owner = $0.ownerMember else { return false }
            return activeMember.sharesNetWorth(with: owner)
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
                        .ledgerType(.rowFigure)
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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(award.detail)
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
            }
            Spacer()
            Text(award.earned ? "EARNED" : "LOCKED")
                .ledgerType(.chip)
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
