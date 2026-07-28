import SwiftUI

struct RequiredFinancialSourceView: View {
    @Environment(\.theme) private var theme

    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(AppFont.sectionHeaderMedium)
                .tracking(AppFont.sectionTracking)
                .foregroundStyle(theme.textMuted)
            Text("Unavailable")
                .font(AppFont.mediumNumberMono)
                .foregroundStyle(theme.text)
            Text(message)
                .font(AppFont.smallRegular)
                .foregroundStyle(theme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}
