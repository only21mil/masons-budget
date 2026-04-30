import SwiftUI

struct SectionHeader: View {
    let title: String
    let icon: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.accentColor)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.primaryText)
            Spacer()
        }
        .padding(.top, 6)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 16) {
        SectionHeader(title: "Bitcoin", icon: "bitcoinsign.circle.fill")
        SectionHeader(title: "Retirement", icon: "chart.pie.fill")
    }
    .padding()
    .background(AppTheme.background)
}
