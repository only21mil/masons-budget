import SwiftUI

struct ProjectsTab: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AREAS OF FOCUS")
                            .font(AppTheme.eyebrowFont)
                            .foregroundStyle(AppTheme.accentColor)
                        Text("Projects")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(AppTheme.primaryText)
                    }
                    .padding(.horizontal, 4)

                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        shortcutCard(label: "Inbox", count: 0, icon: "tray.fill")
                        shortcutCard(label: "Today", count: 0, icon: "target")
                        shortcutCard(label: "Upcoming", count: 0, icon: "calendar")
                        shortcutCard(label: "Flagged", count: 0, icon: "flag.fill")
                    }

                    Text("Projects and areas will appear here once todo sync is active.")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.secondaryText)
                        .glassCard()
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("More")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }

    private func shortcutCard(label: String, count: Int, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(AppTheme.accentColor)
                .frame(width: 32, height: 32)
                .background(AppTheme.accentSoft)
                .clipShape(RoundedRectangle(cornerRadius: 9))

            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AppTheme.secondaryText)

            Text("\(count)")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .glassCard()
    }
}
