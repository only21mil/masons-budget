import SwiftUI
import SwiftData

struct SettingsTab: View {
    @Query private var transactions: [Transaction]
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var categories: [BudgetCategory]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @ObservedObject private var folderManager = MC2FolderManager.shared
    @State private var showFolderPicker = false

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
                // MARK: - Profile
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(AppTheme.accentColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(FamilyMember(rawValue: selectedMember)?.displayName ?? "Select")
                                .font(.headline)
                                .foregroundStyle(AppTheme.primaryText)
                            Text("Family member profile")
                                .font(.caption)
                                .foregroundStyle(AppTheme.tertiaryText)
                        }
                    }
                    .padding(.vertical, 4)

                    Picker("Family Member", selection: $selectedMember) {
                        ForEach(FamilyMember.allCases, id: \.rawValue) { member in
                            Text(member.displayName).tag(member.rawValue)
                        }
                    }
                } header: {
                    Text("Profile")
                }

                // MARK: - MC2 Sync
                Section {
                    Button {
                        showFolderPicker = true
                    } label: {
                        HStack {
                            Label("MC2 Folder", systemImage: "folder.badge.gearshape")
                                .foregroundStyle(AppTheme.primaryText)
                            Spacer()
                            Text(folderManager.isAccessible ? folderManager.folderDisplayPath : "Select…")
                                .font(.caption)
                                .foregroundStyle(folderManager.isAccessible ? AppTheme.positive : AppTheme.accentColor)
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.tertiaryText)
                        }
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
                    HStack {
                        Label("iCloud", systemImage: "icloud")
                        Spacer()
                        SyncBadge(status: folderManager.isAccessible ? .synced : .disconnected)
                    }
                    if folderManager.isAccessible {
                        Button(role: .destructive) {
                            folderManager.clearBookmark()
                        } label: {
                            Label("Unlink MC2 Folder", systemImage: "folder.badge.minus")
                                .font(.caption)
                        }
                    }
                } header: {
                    Text("Data & Sync")
                } footer: {
                    Text("Select the MC2 mission-control folder on iCloud Drive to sync budgets, transactions, and net worth data.")
                }

                // MARK: - Preferences
                Section {
                    Label("Appearance", systemImage: "paintbrush")
                    Label("Notifications", systemImage: "bell.badge")
                    Label("Voice Input", systemImage: "mic")
                } header: {
                    Text("Preferences")
                }

                // MARK: - About
                Section {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("0.1.0")
                            .foregroundStyle(AppTheme.tertiaryText)
                    }
                } header: {
                    Text("About")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Settings")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .sheet(isPresented: $showFolderPicker) {
                MC2FolderPicker { url in
                    folderManager.saveBookmark(for: url)
                }
            }
        }
    }
}

#Preview {
    SettingsTab()
}
