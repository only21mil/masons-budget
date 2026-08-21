import SwiftUI

struct Hairline: View {
    var indent: CGFloat = 0

    @Environment(\.theme) var theme

    var body: some View {
        theme.border
            .frame(height: 1)
            .padding(.leading, indent)
    }
}
