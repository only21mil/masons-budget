import SwiftData
import SwiftUI

/// Account destinations presented from the tab header avatar.
struct MoreMenuView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var showProfileSwitcher = false

    var body: some View {
        List {
            Button("Switch profile", systemImage: "person.crop.circle") { showProfileSwitcher = true }
            destination("Settings", icon: "gearshape") { SettingsView() }
            destination("Family", icon: "person.3.fill") { FamilyView() }
            destination("Awards", icon: "medal.fill") { AwardsView() }
            destination("Sync Setup", icon: "arrow.triangle.2.circlepath") { SyncSetupView() }
            destination("Export", icon: "square.and.arrow.up") { ExportView() }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .foregroundStyle(theme.text)
        .navigationTitle("Profile and settings")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .sheet(isPresented: $showProfileSwitcher) { ProfileSwitcherView() }
    }

    private func destination(_ title: String, icon: String, @ViewBuilder content: @escaping () -> some View) -> some View {
        NavigationLink {
            LedgerDrilldown(title: title, content: content)
        } label: { Label(title, systemImage: icon) }
        .listRowBackground(theme.surface)
    }
}

struct SyncSetupView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

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
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

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
                            ? "Connection settings saved."
                            : "Could not save the device token."
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                }
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                convexReadTokenCard
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                DisclosureGroup("Diagnostics") {
                    Text("Device pairing handles everyday changes. The administrator credential is retained here for compatibility.")
                        .ledgerType(.rowMeta)
                    ConvexSyncTokenCard()
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, ledgerTokens.metrics.screenGutter)

                if let statusMessage {
                    Text(statusMessage)
                        .ledgerType(.body)
                        .foregroundStyle(theme.textMuted)
                        .padding(.horizontal, ledgerTokens.metrics.screenGutter)
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
            : "Connect this device to save changes."
    }

    /// Convex reads are fail-closed as of 2026-07-26, and the token they need lived in a
    /// UserDefaults key nothing could write — configuring a device meant attaching a
    /// debugger. This is the entry point. It writes through `ConvexConfig.setReadToken`
    /// only; the read path in `ConvexClient` is untouched.
    private var convexReadTokenCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Read access token")
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
            : "No read token. Connect this device to load your data."
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
                .textFieldStyle(.plain)
                .padding(12)
                .frame(minHeight: LedgerMetrics.minimumHitTarget)
                .background(theme.surface2)
                .overlay(RoundedRectangle(cornerRadius: LedgerMetrics.cardRadius).stroke(theme.border, lineWidth: 1))
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
                .textFieldStyle(.plain)
                .padding(12)
                .frame(minHeight: LedgerMetrics.minimumHitTarget)
                .background(theme.surface2)
                .overlay(RoundedRectangle(cornerRadius: LedgerMetrics.cardRadius).stroke(theme.border, lineWidth: 1))
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
                Text("Administrator sync token")
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
                    .textFieldStyle(.plain)
                .padding(12)
                .frame(minHeight: LedgerMetrics.minimumHitTarget)
                .background(theme.surface2)
                .overlay(RoundedRectangle(cornerRadius: LedgerMetrics.cardRadius).stroke(theme.border, lineWidth: 1))
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
