import SwiftUI

struct Hairline: View {
    var indent: CGFloat = 0

    var body: some View {
        LedgerRule(level: .row)
            .padding(.leading, indent)
    }
}
