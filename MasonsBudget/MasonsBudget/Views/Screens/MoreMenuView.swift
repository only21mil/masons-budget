import SwiftUI

struct MoreMenuView: View {
    @Environment(\.theme) var theme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    ScreenHeader(title: "More", eyebrow: "Explore")

                    VStack(spacing: 0) {
                        moreRow(icon: "target", label: "Net Worth", destination: NetWorthView())
                        Hairline(indent: 52)
                        moreRow(icon: "bolt.fill", label: "Activity", destination: ActivityView())
                        Hairline(indent: 52)
                        moreRow(icon: "tray.fill", label: "Projects", destination: ProjectsView())
                    }
                    .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    .padding(.horizontal, AppLayout.sectionPadding)
                }
                .padding(.bottom, 100)
            }
            .background(theme.bg)
        }
    }

    private func moreRow<D: View>(icon: String, label: String, destination: D) -> some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(theme.accent)
                    .frame(width: 28)

                Text(label)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(theme.text)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.textFaint)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}
