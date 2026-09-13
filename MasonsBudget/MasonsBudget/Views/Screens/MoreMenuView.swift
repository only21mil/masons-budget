import SwiftData
import SwiftUI

struct MoreMenuView: View {
    @Environment(\.theme) var theme
    @Environment(CanonicalFinancialSourceStore.self) private var canonicalFinancials
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue
    @Query private var transactions: [Transaction]
    @Query private var todos: [TodoItem]
    @Query private var buys: [BTCBuy]
    @Query private var billPays: [BTCBillPay]

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var transactionCount: Int {
        transactions.filter { activeMember.canSee(dataOwnedBy: $0.ownerMember) }.count
    }

    private var taskCount: Int {
        todos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) && !$0.isDone }.count
    }

    private var buyCount: Int {
        buys.filter {
            guard let owner = $0.ownerMember else { return false }
            return activeMember.sharesNetWorth(with: owner)
        }.count
    }

    private var billPayCount: Int {
        billPays.filter { activeMember.sharesNetWorth(with: $0.ownerMember) }.count
    }

    private var awardCount: Int {
        var count = 0
        if transactionCount > 0 { count += 1 }
        if buyCount > 0 { count += 1 }
        let completed = todos.filter { activeMember.canAccessTodo(ownedBy: $0.ownerMember) && $0.isDone }.count
        if completed > 0 { count += 1 }
        if completed >= 10 { count += 1 }
        return count
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "More", eyebrow: "Explore") {
                    Text("\(AppleMoreScreen.allCases.count) ROUTES")
                        .ledgerType(.kpiSub)
                        .foregroundStyle(theme.accent)
                }

                menuSection("BITCOIN") {
                    moreRow(icon: "chart.xyaxis.line", label: "Price", destination: BitcoinPriceView())
                    Hairline(indent: 52)
                    moreRow(icon: "bolt.fill", label: "Activity", count: transactionCount, destination: ActivityView())
                    Hairline(indent: 52)
                    moreRow(icon: "bitcoinsign.circle.fill", label: "Bitcoin Buys", count: buyCount, destination: BTCBuysView())
                    Hairline(indent: 52)
                    moreRow(icon: "banknote.fill", label: "Bill Pay", count: billPayCount, destination: BTCBillPayView())
                    Hairline(indent: 52)
                    moreRow(icon: "arrow.left.arrow.right", label: "Transfer", destination: BitcoinTransferView())
                }

                menuSection("HOUSEHOLD") {
                    moreRow(icon: "target", label: "Net Worth", destination: NetWorthView())
                    Hairline(indent: 52)
                    moreRow(icon: "checklist", label: "Tasks", count: taskCount, destination: TasksView())
                    Hairline(indent: 52)
                    moreRow(icon: "person.3.fill", label: "Family", count: FamilyMember.allCases.count, destination: FamilyView())
                    Hairline(indent: 52)
                    moreRow(icon: "medal.fill", label: "Awards", count: awardCount, destination: AwardsView())
                }

                menuSection("TOOLS") {
                    moreRow(icon: "gearshape", label: "Settings", destination: SettingsView())
                    Hairline(indent: 52)
                    moreRow(icon: "arrow.triangle.2.circlepath", label: "Sync Setup", destination: SyncSetupView())
                    Hairline(indent: 52)
                    moreRow(icon: "square.and.arrow.up", label: "Export", destination: ExportView())
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    private func menuSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .ledgerType(.sectionLabel)
                .foregroundStyle(theme.textMuted)
                .padding(.horizontal, AppLayout.sectionPadding + 4)
            VStack(spacing: 0) { content() }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
        }
        .padding(.bottom, AppLayout.cardSpacing)
    }

    private func moreRow(icon: String, label: String, count: Int = 0, destination: some View) -> some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(AppFont.iconTiny)
                    .foregroundStyle(theme.accent)
                    .frame(width: 28)

                Text(label)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)

                Spacer()

                if let badge = MoreCountFormatter.badge(count) {
                    Text(badge)
                        .ledgerType(.chip)
                        .foregroundStyle(theme.accent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(theme.accentSoft)
                        .clipShape(Capsule())
                }

                Image(systemName: "chevron.right")
                    .font(AppFont.icon(size: 12, weight: .semibold))
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}

struct SyncSetupView: View {
    @Environment(\.theme) var theme
    @State private var pairingURL = ""
    @State private var baseURL = AppWritebackConfig.baseURL?.absoluteString ?? ""
    @State private var deviceID = AppWritebackConfig.deviceID
    // Write-only by design. The Keychain value is represented in view state only
    // by its presence and is never loaded back into this field.
    @State private var deviceTokenEntry = ""
    @State private var hasDeviceToken = AppWritebackConfig.hasDeviceToken
    @State private var statusMessage: String?
    @State private var isClaiming = false

    // Write-only by design. Never seeded from storage and cleared the moment it is
    // saved, so the stored read token cannot be read back out of the UI.
    @State private var readTokenEntry = ""
    @State private var hasReadToken = ConvexConfig.hasReadToken
    @State private var readTokenMessage: String?

    private var canSave: Bool {
        Self.isValidPairingURL(baseURL) &&
            !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !deviceTokenEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canClaim: Bool {
        let trimmed = pairingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isClaiming && (Self.isValidPairingURL(trimmed) || (trimmed.isEmpty && !AppWritebackConfig.bundledPairingURLs.isEmpty))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                ScreenHeader(title: "Sync Setup", eyebrow: "Connect this device")

                VStack(spacing: 14) {
                    field("Pairing URL (optional)", text: $pairingURL)
                    Button {
                        claimPairing()
                    } label: {
                        HStack(spacing: 8) {
                            if isClaiming {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text(isClaiming ? "Pairing" : "Pair This Device")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canClaim)
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                VStack(spacing: 14) {
                    field("Writeback URL", text: $baseURL)
                    field("Device ID", text: $deviceID)
                    HStack(spacing: 8) {
                        Circle()
                            .fill(hasDeviceToken ? theme.success : theme.warn)
                            .frame(width: 8, height: 8)
                        Text(deviceTokenStatusText)
                            .ledgerType(.body)
                            .foregroundStyle(theme.textMuted)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                    secureField("Paste device token", text: $deviceTokenEntry)
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                HStack(spacing: 12) {
                    Button("Clear") {
                        AppWritebackConfig.clear()
                        baseURL = ""
                        deviceID = ""
                        deviceTokenEntry = ""
                        hasDeviceToken = false
                    }
                    .buttonStyle(.bordered)

                    Button("Save") {
                        let saved = AppWritebackConfig.save(
                            baseURL: baseURL,
                            deviceID: deviceID,
                            deviceToken: deviceTokenEntry,
                        )
                        deviceTokenEntry = ""
                        hasDeviceToken = AppWritebackConfig.hasDeviceToken
                        statusMessage = saved && hasDeviceToken
                            ? "Writeback settings saved."
                            : "Could not save the device token."
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                }
                .padding(.horizontal, AppLayout.sectionPadding)

                convexReadTokenCard
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)

                DisclosureGroup("Diagnostics") {
                    Text("Device pairing handles everyday changes. The administrator credential is retained here for compatibility.")
                        .ledgerType(.rowMeta)
                    ConvexSyncTokenCard()
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                if let statusMessage {
                    Text(statusMessage)
                        .ledgerType(.body)
                        .foregroundStyle(theme.textMuted)
                        .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .onAppear { hasDeviceToken = AppWritebackConfig.hasDeviceToken }
    }

    private func claimPairing() {
        isClaiming = true
        statusMessage = nil
        let rawURL = pairingURL
            .trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                #if os(iOS)
                    let deviceName = "Vogel Vault iOS"
                #else
                    let deviceName = "Vogel Vault macOS"
                #endif
                if rawURL.isEmpty {
                    try await AppWritebackClient().claimBundledPairing(deviceName: deviceName)
                } else {
                    try await AppWritebackClient().claimPairing(pairingURL: rawURL, deviceName: deviceName)
                }
                await MainActor.run {
                    baseURL = AppWritebackConfig.baseURL?.absoluteString ?? ""
                    deviceID = AppWritebackConfig.deviceID
                    deviceTokenEntry = ""
                    hasDeviceToken = AppWritebackConfig.hasDeviceToken
                    pairingURL = ""
                    statusMessage = "Device pairing saved."
                    isClaiming = false
                }
            } catch {
                await MainActor.run {
                    // Pairing responses can carry server-derived text (decoder
                    // details, errorData). Classify to an authored message and
                    // fall back to a fixed line instead of printing it.
                    let result = ConvexWriteResult.classify(error)
                    statusMessage = result.userMessage(operation: "Pairing")
                        ?? "Pairing could not be completed. Check the pairing URL and try again."
                    isClaiming = false
                }
            }
        }
    }

    private var deviceTokenStatusText: String {
        hasDeviceToken
            ? "A device token is stored on this device."
            : "No device token. App writeback is not configured."
    }

    /// Convex reads are fail-closed as of 2026-07-26, and the token they need lived in a
    /// UserDefaults key nothing could write — configuring a device meant attaching a
    /// debugger. This is the entry point. It writes through `ConvexConfig.setReadToken`
    /// only; the read path in `ConvexClient` is untouched.
    private var convexReadTokenCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Convex Read Token")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(theme.text)
                // The deployment host, never the token. The host is already public in the
                // repo; showing it is how you tell which deployment the token is for.
                Text(ConvexConfig.deploymentURL.host ?? "no deployment host")
                    .ledgerType(.body)
                    .foregroundStyle(theme.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                Circle()
                    .fill(hasReadToken ? theme.success : theme.warn)
                    .frame(width: 8, height: 8)
                Text(readTokenStatusText)
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            secureField("Paste read token", text: $readTokenEntry)

            HStack(spacing: 12) {
                // PasteButton rather than reading the pasteboard ourselves: the app never
                // touches clipboard contents it was not handed, and iOS raises no paste alert.
                PasteButton(payloadType: String.self) { pasted in
                    guard let token = pasted.first else { return }
                    readTokenEntry = token.trimmingCharacters(in: .whitespacesAndNewlines)
                }

                Spacer(minLength: 0)

                if hasReadToken {
                    Button("Remove") {
                        removeReadToken()
                    }
                    .buttonStyle(.bordered)
                }

                Button("Save") {
                    saveReadToken()
                }
                .buttonStyle(.borderedProminent)
                .disabled(readTokenEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let readTokenMessage {
                Text(readTokenMessage)
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
            }
        }
        // The view can be constructed long before it is shown, so re-derive on appear
        // rather than trusting the value captured at init.
        .onAppear { hasReadToken = ConvexConfig.hasReadToken }
    }

    private var readTokenStatusText: String {
        hasReadToken
            ? "A read token is stored on this device."
            : "No read token. Reads fail once the deployment enforces."
    }

    private func saveReadToken() {
        let trimmed = readTokenEntry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let saved = ConvexConfig.setReadToken(trimmed)
        readTokenEntry = ""
        hasReadToken = ConvexConfig.hasReadToken
        readTokenMessage = saved && hasReadToken
            ? "Read token saved. It is sent with the next refresh."
            : "Could not save the read token."
    }

    private func removeReadToken() {
        let removed = ConvexConfig.removeReadToken()
        readTokenEntry = ""
        hasReadToken = ConvexConfig.hasReadToken
        readTokenMessage = removed && !hasReadToken
            ? "Read token removed from this device."
            : "Could not remove the read token."
    }

    private func field(
        _ title: String,
        text: Binding<String>,
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            TextField(title, text: text)
                .autocorrectionDisabled()
                .ledgerType(.textInput)
                .foregroundStyle(theme.text)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func secureField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .ledgerType(.kpiLabel)
                .foregroundStyle(theme.textMuted)
            SecureField(title, text: text)
                .autocorrectionDisabled()
                .ledgerType(.textInput)
                .foregroundStyle(theme.text)
                .textFieldStyle(.roundedBorder)
        }
    }

    private static func isValidPairingURL(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased()
        else { return false }
        return scheme == "https" || host == "localhost" || host == "127.0.0.1"
    }
}

/// Shared credential control for iOS Sync Setup and the macOS settings surface.
///
/// The stored token is deliberately represented only as a Bool. Its value is
/// never loaded into view state or rendered back into a field.
struct ConvexSyncTokenCard: View {
    @Environment(\.theme) private var theme
    @State private var tokenEntry = ""
    @State private var hasToken = ConvexConfig.hasSyncToken
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Convex Sync Token")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(theme.text)
                Text(ConvexConfig.deploymentURL.host ?? "no deployment host")
                    .ledgerType(.body)
                    .foregroundStyle(theme.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                Circle()
                    .fill(hasToken ? theme.success : theme.warn)
                    .frame(width: 8, height: 8)
                Text(statusText)
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            VStack(alignment: .leading, spacing: 6) {
                Text("Paste sync token")
                    .ledgerType(.kpiLabel)
                    .foregroundStyle(theme.textMuted)
                SecureField("Paste sync token", text: $tokenEntry)
                    .autocorrectionDisabled()
                    .ledgerType(.textInput)
                    .foregroundStyle(theme.text)
                    .textFieldStyle(.roundedBorder)
            }

            HStack(spacing: 12) {
                PasteButton(payloadType: String.self) { pasted in
                    guard let token = pasted.first else { return }
                    tokenEntry = token.trimmingCharacters(in: .whitespacesAndNewlines)
                }

                Spacer(minLength: 0)

                if hasToken {
                    Button("Remove") {
                        removeToken()
                    }
                    .buttonStyle(.bordered)
                }

                Button("Save") {
                    saveToken()
                }
                .buttonStyle(.borderedProminent)
                .disabled(tokenEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let message {
                Text(message)
                    .ledgerType(.body)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .onAppear { hasToken = ConvexConfig.hasSyncToken }
    }

    private var statusText: String {
        hasToken
            ? "A sync token is stored on this device."
            : "No sync token. Transaction, Bitcoin, and budget writes will be rejected."
    }

    private func saveToken() {
        let trimmed = tokenEntry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let saved = ConvexConfig.setSyncToken(trimmed)
        tokenEntry = ""
        hasToken = ConvexConfig.hasSyncToken
        message = saved
            ? "Sync token saved. It is sent with the next write."
            : "Could not save the sync token."
    }

    private func removeToken() {
        let removed = ConvexConfig.removeSyncToken()
        tokenEntry = ""
        hasToken = ConvexConfig.hasSyncToken
        message = removed && !hasToken
            ? "Sync token removed from this device."
            : "Could not remove the sync token."
    }
}
