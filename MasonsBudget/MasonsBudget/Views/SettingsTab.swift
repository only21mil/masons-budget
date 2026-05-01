import SwiftUI
import SwiftData

struct SettingsTab: View {
    @Query private var transactions: [Transaction]
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var categories: [BudgetCategory]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @Environment(\.modelContext) private var modelContext
    @State private var isSyncing = false

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var hasAnyData: Bool {
        !transactions.isEmpty || !btcAccounts.isEmpty || !holdingAccounts.isEmpty
    }

    private var lastSyncText: String {
        let ts = UserDefaults.standard.double(forKey: MC2SyncService.lastSyncKey)
        guard ts > 0 else { return "Never" }
        let date = Date(timeIntervalSince1970: ts)
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    private var syncError: String? {
        UserDefaults.standard.string(forKey: MC2SyncService.lastSyncErrorKey)
    }

    private var dataSummary: String {
        var parts: [String] = []
        if !transactions.isEmpty { parts.append("\(transactions.count) txns") }
        if !btcAccounts.isEmpty { parts.append("\(btcAccounts.count) BTC accts") }
        if !holdingAccounts.isEmpty { parts.append("\(holdingAccounts.count) holdings") }
        if !categories.isEmpty { parts.append("\(categories.count) categories") }
        return parts.isEmpty ? "No data" : parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: currentMember.icon)
                            .font(.system(size: 44))
                            .foregroundStyle(AppTheme.accentColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(currentMember.displayName)
                                .font(.headline)
                                .foregroundStyle(AppTheme.primaryText)
                            Text(currentMember.profileDescription)
                                .font(.caption)
                                .foregroundStyle(AppTheme.tertiaryText)
                        }
                    }
                    .padding(.vertical, 4)

                    Picker("Family Member", selection: $selectedMember) {
                        ForEach(FamilyMember.allCases) { member in
                            Text(member.displayName).tag(member.rawValue)
                        }
                    }
                } header: {
                    Text("Profile")
                }

                Section {
                    HStack {
                        Label("Convex Cloud", systemImage: ConvexConfig.isConfigured ? "cloud.fill" : "cloud")
                        Spacer()
                        SyncBadge(status: ConvexConfig.isConfigured ? .synced : .disconnected)
                    }
                    HStack {
                        Label("Last Sync", systemImage: "arrow.triangle.2.circlepath")
                        Spacer()
                        Text(lastSyncText)
                            .font(.caption)
                            .foregroundStyle(lastSyncText == "Never" ? AppTheme.tertiaryText : AppTheme.positive)
                    }
                    HStack {
                        Label("Data", systemImage: "cylinder.split.1x2")
                        Spacer()
                        Text(dataSummary)
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    if let error = syncError {
                        HStack {
                            Label("Errors", systemImage: "exclamationmark.triangle")
                            Spacer()
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(AppTheme.negative)
                                .lineLimit(2)
                        }
                    }
                    Button {
                        Task { await syncNow() }
                    } label: {
                        HStack {
                            Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                            Spacer()
                            if isSyncing {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!ConvexConfig.isConfigured)
                } header: {
                    Text("Data & Sync")
                } footer: {
                    Text("Data syncs automatically from the cloud every 15 seconds. Tap \"Sync Now\" to refresh immediately.")
                }

                Section {
                    NavigationLink {
                        CategoryManagementView()
                    } label: {
                        Label("Budget Categories", systemImage: "list.bullet.rectangle")
                            .foregroundStyle(AppTheme.primaryText)
                    }
                } header: {
                    Text("Budget")
                }

                Section {
                    Toggle(isOn: $appLockEnabled) {
                        Label("Face ID / Passcode Lock", systemImage: "faceid")
                    }
                    .tint(AppTheme.accentColor)
                    Label("Notifications", systemImage: "bell.badge")
                    Label("Voice Input", systemImage: "mic")
                } header: {
                    Text("Security & Preferences")
                }

                Section {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("0.2.0")
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                } header: {
                    Text("About")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Settings")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    private func syncNow() async {
        isSyncing = true
        let sync = MC2SyncService(context: modelContext)
        await sync.syncAll()
        isSyncing = false
    }
}

#Preview {
    SettingsTab()
}
