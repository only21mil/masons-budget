import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct SettingsTab: View {
    @Query private var transactions: [Transaction]
    @Query private var btcAccounts: [BTCAccount]
    @Query private var holdingAccounts: [HoldingAccount]
    @Query private var categories: [BudgetCategory]
    @Query private var snapshots: [MonthlyBudgetSnapshot]
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue
    @AppStorage("app_lock_enabled") private var appLockEnabled = true
    @ObservedObject private var folderManager = MC2FolderManager.shared
    @Environment(\.modelContext) private var modelContext
    @State private var showFolderPicker = false
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
                        Label("iCloud", systemImage: folderManager.isAccessible ? "checkmark.icloud.fill" : "icloud")
                        Spacer()
                        SyncBadge(status: folderManager.isAccessible ? .synced : .disconnected)
                    }
                    if folderManager.isAccessible {
                        HStack {
                            Label("MC2 Folder", systemImage: "folder.fill")
                                .foregroundStyle(AppTheme.primaryText)
                            Spacer()
                            Text(folderManager.folderDisplayPath)
                                .font(.caption)
                                .foregroundStyle(AppTheme.positive)
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
                    if folderManager.isAccessible {
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
                    } else {
                        Button {
                            folderManager.autoConnectICloud()
                        } label: {
                            Label("Reconnect iCloud", systemImage: "arrow.clockwise")
                        }
                    }
                    Button {
                        showFolderPicker = true
                    } label: {
                        Label("Choose Folder Manually", systemImage: "folder.badge.gearshape")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    if folderManager.isAccessible {
                        Button(role: .destructive) {
                            folderManager.clearBookmark()
                        } label: {
                            Label("Disconnect", systemImage: "folder.badge.minus")
                                .font(.caption)
                        }
                    }
                } header: {
                    Text("Data & Sync")
                } footer: {
                    Text("Data syncs automatically via iCloud Drive. Use \"Choose Folder Manually\" to override the default location.")
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
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .sheet(isPresented: $showFolderPicker) {
                MC2FolderPicker { url in
                    folderManager.saveBookmark(for: url)
                }
            }
            #else
            .fileImporter(
                isPresented: $showFolderPicker,
                allowedContentTypes: [.folder],
                allowsMultipleSelection: false
            ) { result in
                if case .success(let urls) = result, let url = urls.first {
                    folderManager.saveBookmark(for: url)
                }
            }
            #endif
        }
    }

    private func syncNow() async {
        guard let url = folderManager.folderURL, folderManager.isAccessible else { return }
        isSyncing = true
        let reader = MC2Reader(baseURL: url)
        let sync = MC2SyncService(reader: reader, context: modelContext)
        await sync.syncAll()
        isSyncing = false
    }
}

#Preview {
    SettingsTab()
}
