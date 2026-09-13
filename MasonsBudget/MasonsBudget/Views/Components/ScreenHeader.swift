import SwiftUI

private struct LedgerRootTitleKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct LedgerRootAccessoryKey: EnvironmentKey { static let defaultValue: AnyView? = nil }
extension EnvironmentValues {
    var ledgerRootTitle: String? {
        get { self[LedgerRootTitleKey.self] }
        set { self[LedgerRootTitleKey.self] = newValue }
    }
    var ledgerRootAccessory: AnyView? {
        get { self[LedgerRootAccessoryKey.self] }
        set { self[LedgerRootAccessoryKey.self] = newValue }
    }
}

/// A destination owns the native title, while its existing ScreenHeader is suppressed.
struct LedgerDrilldown<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .environment(\.ledgerRootTitle, "")
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            #endif
    }
}

struct ScreenHeader<Accessory: View>: View {
    let title: String
    var eyebrow: String?
    @ViewBuilder var accessory: () -> Accessory

    @Environment(\.ledgerTokens) private var tokens
    @Environment(\.theme) var theme
    @Environment(\.ledgerRootTitle) private var rootTitle
    @Environment(\.ledgerRootAccessory) private var rootAccessory

    init(title: String, eyebrow: String? = nil, @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() }) {
        self.title = title
        self.eyebrow = eyebrow
        self.accessory = accessory
    }

    var body: some View {
        #if os(iOS)
        if let rootTitle, rootTitle != title {
            Color.clear.frame(height: 0)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { accessory().frame(minWidth: LedgerMetrics.minimumHitTarget, minHeight: LedgerMetrics.minimumHitTarget) }
                }
        } else {
            header
        }
        #else
        header
        #endif
    }

    private var header: some View {
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
                if rootTitle == title, let rootAccessory {
                    rootAccessory.frame(minHeight: LedgerMetrics.minimumHitTarget)
                } else {
                    accessory().frame(minHeight: LedgerMetrics.minimumHitTarget)
                }
            }
        }
        .padding(.horizontal, tokens.metrics.screenGutter)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }
}
