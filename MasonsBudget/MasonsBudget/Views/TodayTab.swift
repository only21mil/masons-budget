import SwiftUI
import SwiftData

struct TodayTab: View {
    @Environment(\.modelContext) private var modelContext
    @AppStorage("selected_family_member") private var selectedMember: String = FamilyMember.victor.rawValue

    private var currentMember: FamilyMember {
        FamilyMember(rawValue: selectedMember) ?? .victor
    }

    private var dayLabel: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "EEEE · MMMM d"
        return fmt.string(from: Date())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.cardSpacing) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(dayLabel.uppercased())
                            .font(AppTheme.eyebrowFont)
                            .foregroundStyle(AppTheme.accentColor)
                        Text("Today")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(AppTheme.primaryText)
                    }
                    .padding(.horizontal, 4)

                    Text("Todo functionality coming soon.")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.secondaryText)
                        .glassCard()
                }
                .padding(.horizontal, AppTheme.horizontalPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(AppTheme.background)
            .navigationTitle("Today")
            #if os(iOS)
            .toolbarColorScheme(.dark, for: .navigationBar)
            #endif
        }
    }
}
