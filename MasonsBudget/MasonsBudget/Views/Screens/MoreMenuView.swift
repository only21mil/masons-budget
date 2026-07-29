import SwiftUI

struct MoreMenuView: View {
    @Environment(\.theme) var theme

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "More", eyebrow: "Explore")

                VStack(spacing: 0) {
                    moreRow(icon: "target", label: "Net Worth", destination: NetWorthView())
                    Hairline(indent: 52)
                    moreRow(icon: "bolt.fill", label: "Activity", destination: ActivityView())
                    Hairline(indent: 52)
                    moreRow(icon: "bitcoinsign.circle.fill", label: "Bitcoin Buys", destination: BTCBuysView())
                    Hairline(indent: 52)
                    moreRow(icon: "banknote.fill", label: "Bill Pay", destination: BTCBillPayView())
                    Hairline(indent: 52)
                    moreRow(icon: "arrow.triangle.2.circlepath", label: "Sync Setup", destination: SyncSetupView())
                    Hairline(indent: 52)
                    moreRow(icon: "square.and.arrow.up", label: "Export", destination: ExportView())
                }
                .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
    }

    private func moreRow(icon: String, label: String, destination: some View) -> some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(AppFont.iconTiny)
                    .foregroundStyle(theme.accent)
                    .frame(width: 28)

                Text(label)
                    .font(AppFont.bodyStrong)
                    .foregroundStyle(theme.text)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(AppFont.labelSmall)
                    .foregroundStyle(theme.textMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}

private struct SyncSetupView: View {
    @Environment(\.theme) var theme
    @State private var pairingURL = ""
    @State private var baseURL = AppWritebackConfig.baseURL?.absoluteString ?? ""
    @State private var deviceID = AppWritebackConfig.deviceID
    @State private var deviceToken = AppWritebackConfig.deviceToken
    @State private var statusMessage: String?
    @State private var isClaiming = false

    // Write-only by design. Never seeded from storage and cleared the moment it is
    // saved, so the stored read token cannot be read back out of the UI.
    @State private var readTokenEntry = ""
    @State private var hasReadToken = !ConvexConfig.readToken.isEmpty
    @State private var readTokenMessage: String?

    private var canSave: Bool {
        Self.isValidPairingURL(baseURL) &&
            !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !deviceToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canClaim: Bool {
        let trimmed = pairingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isClaiming && (Self.isValidPairingURL(trimmed) || (trimmed.isEmpty && !AppWritebackConfig.bundledPairingURLs.isEmpty))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                ScreenHeader(title: "Sync Setup", eyebrow: "Convex Writeback")

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
                    secureField("Device Token", text: $deviceToken)
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                HStack(spacing: 12) {
                    Button("Clear") {
                        AppWritebackConfig.clear()
                        baseURL = ""
                        deviceID = ""
                        deviceToken = ""
                    }
                    .buttonStyle(.bordered)

                    Button("Save") {
                        AppWritebackConfig.save(
                            baseURL: baseURL,
                            deviceID: deviceID,
                            deviceToken: deviceToken,
                        )
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                }
                .padding(.horizontal, AppLayout.sectionPadding)

                convexReadTokenCard
                    .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)

                if let statusMessage {
                    Text(statusMessage)
                        .font(AppFont.smallRegular)
                        .foregroundStyle(theme.textMuted)
                        .padding(.horizontal, AppLayout.sectionPadding)
                }
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
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
                    deviceToken = AppWritebackConfig.deviceToken
                    pairingURL = ""
                    statusMessage = "Device pairing saved."
                    isClaiming = false
                }
            } catch {
                await MainActor.run {
                    statusMessage = error.localizedDescription
                    isClaiming = false
                }
            }
        }
    }

    /// Convex reads are fail-closed as of 2026-07-26, and the token they need lived in a
    /// UserDefaults key nothing could write — configuring a device meant attaching a
    /// debugger. This is the entry point. It writes through `ConvexConfig.setReadToken`
    /// only; the read path in `ConvexClient` is untouched.
    private var convexReadTokenCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Convex Read Token")
                    .font(AppFont.headline)
                    .foregroundStyle(theme.text)
                // The deployment host, never the token. The host is already public in the
                // repo; showing it is how you tell which deployment the token is for.
                Text(ConvexConfig.deploymentURL.host ?? "no deployment host")
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                Circle()
                    .fill(hasReadToken ? theme.success : theme.warn)
                    .frame(width: 8, height: 8)
                Text(readTokenStatusText)
                    .font(AppFont.smallRegular)
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
                    .font(AppFont.smallRegular)
                    .foregroundStyle(theme.textMuted)
            }
        }
        // The view can be constructed long before it is shown, so re-derive on appear
        // rather than trusting the value captured at init.
        .onAppear { hasReadToken = !ConvexConfig.readToken.isEmpty }
    }

    private var readTokenStatusText: String {
        hasReadToken
            ? "A read token is stored on this device."
            : "No read token. Reads fail once the deployment enforces."
    }

    private func saveReadToken() {
        let trimmed = readTokenEntry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        ConvexConfig.setReadToken(trimmed)
        readTokenEntry = ""
        // Re-read the store instead of assuming the write landed, and keep the result a
        // Bool: the stored token is never held in view state or rendered.
        hasReadToken = !ConvexConfig.readToken.isEmpty
        readTokenMessage = hasReadToken
            ? "Read token saved. It is sent with the next refresh."
            : "Could not save the read token."
    }

    private func removeReadToken() {
        ConvexConfig.setReadToken("")
        readTokenEntry = ""
        hasReadToken = !ConvexConfig.readToken.isEmpty
        readTokenMessage = hasReadToken
            ? "Could not remove the read token."
            : "Read token removed from this device."
    }

    private func field(
        _ title: String,
        text: Binding<String>,
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(AppFont.labelSmallStrong)
                .foregroundStyle(theme.textMuted)
            TextField(title, text: text)
                .autocorrectionDisabled()
                .font(AppFont.body)
                .foregroundStyle(theme.text)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func secureField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(AppFont.labelSmallStrong)
                .foregroundStyle(theme.textMuted)
            SecureField(title, text: text)
                .autocorrectionDisabled()
                .font(AppFont.body)
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
