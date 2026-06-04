import SwiftUI

struct MissionControlSyncSettingsView: View {
    @Environment(\.theme) private var theme

    @State private var serverURL = MissionControlServerConfig.defaultBaseURLString
    @State private var deviceID = ""
    @State private var deviceToken = ""
    @State private var saved = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ScreenHeader(title: "MC2 Sync", eyebrow: "More")

                VStack(spacing: 14) {
                    field("Server URL", text: $serverURL)
                    field("Device ID", text: $deviceID)

                    SecureField("Device Token", text: $deviceToken)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .font(.system(size: 15, weight: .medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(theme.surface2)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    HStack(spacing: 12) {
                        Button {
                            MissionControlServerConfig.save(
                                baseURLString: serverURL,
                                deviceID: deviceID,
                                deviceToken: deviceToken
                            )
                            saved = true
                        } label: {
                            Label("Save", systemImage: "checkmark.circle.fill")
                        }
                        .buttonStyle(.borderedProminent)

                        Button(role: .destructive) {
                            MissionControlServerConfig.clearMobileCredentials()
                            deviceID = ""
                            deviceToken = ""
                            saved = false
                        } label: {
                            Label("Clear", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)

                        Spacer()
                    }

                    HStack(spacing: 8) {
                        Image(systemName: saved || MissionControlServerConfig.mobileCredentials != nil ? "checkmark.shield.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(saved || MissionControlServerConfig.mobileCredentials != nil ? theme.success : theme.warn)
                        Text(saved || MissionControlServerConfig.mobileCredentials != nil ? "Paired" : "Not paired")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(theme.textMuted)
                        Spacer()
                    }
                }
                .glassCard(padding: 16, radius: AppLayout.radiusMedium)
                .padding(.horizontal, AppLayout.sectionPadding)
            }
            .padding(.bottom, 100)
        }
        .background(theme.bg)
        .onAppear(perform: load)
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .font(.system(size: 15, weight: .medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func load() {
        serverURL = UserDefaults.standard.string(forKey: MissionControlServerConfig.serverURLKey)
            ?? MissionControlServerConfig.defaultBaseURLString
        deviceID = MissionControlServerConfig.mobileDeviceID
        deviceToken = MissionControlServerConfig.mobileDeviceToken
        saved = MissionControlServerConfig.mobileCredentials != nil
    }
}
