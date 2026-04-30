import SwiftUI

struct SyncBadge: View {
    enum Status {
        case synced
        case syncing
        case error
        case disconnected
    }

    let status: Status

    private var icon: String {
        switch status {
        case .synced:       return "checkmark.icloud.fill"
        case .syncing:      return "arrow.triangle.2.circlepath.icloud.fill"
        case .error:        return "exclamationmark.icloud.fill"
        case .disconnected: return "icloud.slash"
        }
    }

    private var color: Color {
        switch status {
        case .synced:       return AppTheme.positive
        case .syncing:      return AppTheme.accentColor
        case .error:        return AppTheme.negative
        case .disconnected: return AppTheme.tertiaryText
        }
    }

    private var label: String {
        switch status {
        case .synced:       return "Synced"
        case .syncing:      return "Syncing…"
        case .error:        return "Sync Error"
        case .disconnected: return "Offline"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(color)
                .symbolEffect(.pulse, isActive: status == .syncing)
            Text(label)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(color.opacity(0.1))
        .clipShape(Capsule())
    }
}

#Preview {
    VStack(spacing: 12) {
        SyncBadge(status: .synced)
        SyncBadge(status: .syncing)
        SyncBadge(status: .error)
        SyncBadge(status: .disconnected)
    }
    .padding()
    .background(AppTheme.background)
}
