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
    @State private var baseURL = MC2MobileWritebackConfig.baseURL?.absoluteString ?? ""
    @State private var deviceID = MC2MobileWritebackConfig.deviceID
    @State private var deviceToken = MC2MobileWritebackConfig.deviceToken
    @State private var statusMessage: String?
    @State private var isClaiming = false

    private var canSave: Bool {
        Self.isValidPairingURL(baseURL) &&
            !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !deviceToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canClaim: Bool {
        let trimmed = pairingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return !isClaiming && (Self.isValidPairingURL(trimmed) || (trimmed.isEmpty && !MC2MobileWritebackConfig.bundledPairingURLs.isEmpty))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                ScreenHeader(title: "Sync Setup", eyebrow: "MC2")

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
                    field("MC2 URL", text: $baseURL)
                    field("Device ID", text: $deviceID)
                    secureField("Device Token", text: $deviceToken)
                }
                .glassCard(padding: 14, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)

                HStack(spacing: 12) {
                    Button("Clear") {
                        MC2MobileWritebackConfig.clear()
                        baseURL = ""
                        deviceID = ""
                        deviceToken = ""
                    }
                    .buttonStyle(.bordered)

                    Button("Save") {
                        MC2MobileWritebackConfig.save(
                            baseURL: baseURL,
                            deviceID: deviceID,
                            deviceToken: deviceToken,
                        )
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                }
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
                    try await MC2MobileWritebackClient().claimBundledPairing(deviceName: deviceName)
                } else {
                    try await MC2MobileWritebackClient().claimPairing(pairingURL: rawURL, deviceName: deviceName)
                }
                await MainActor.run {
                    baseURL = MC2MobileWritebackConfig.baseURL?.absoluteString ?? ""
                    deviceID = MC2MobileWritebackConfig.deviceID
                    deviceToken = MC2MobileWritebackConfig.deviceToken
                    pairingURL = ""
                    statusMessage = "MC2 pairing saved."
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
