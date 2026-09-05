import SwiftUI

struct ScreenHeader<Accessory: View>: View {
    let title: String
    var eyebrow: String?
    @ViewBuilder var accessory: () -> Accessory

    @Environment(\.theme) var theme

    init(title: String, eyebrow: String? = nil, @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() }) {
        self.title = title
        self.eyebrow = eyebrow
        self.accessory = accessory
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let eyebrow {
                Text(eyebrow)
                    .ledgerType(.screenSubtitle)
                    .foregroundStyle(theme.accent)
            }

            HStack(alignment: .bottom) {
                Text(title)
                    .ledgerType(.screenTitle)
                    .foregroundStyle(theme.text)

                Spacer()
                accessory()
            }
        }
        .padding(.horizontal, AppLayout.sectionPadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }
}
