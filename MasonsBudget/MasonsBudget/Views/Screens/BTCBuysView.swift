import SwiftData
import SwiftUI

struct BTCBuysView: View {
    @Environment(\.ledgerTokens) private var ledgerTokens
    @Environment(\.theme) var theme
    @AppStorage("display_unit") private var displayUnitRaw = DisplayUnit.btc.rawValue
    @AppStorage("selected_family_member") private var selectedMemberRaw = FamilyMember.victor.rawValue

    @State private var showingAdd = false
    @AppStorage(ConvexSyncService.versionsMemberKey) private var syncedMember = ""
    @AppStorage(ConvexSyncService.lastSyncKey) private var lastSync = 0.0

    @Query(sort: \BTCBuy.date, order: .reverse) private var allBuys: [BTCBuy]

    private var unit: DisplayUnit {
        DisplayUnit(rawValue: displayUnitRaw) ?? .btc
    }

    private var activeMember: FamilyMember {
        FamilyMember(rawValue: selectedMemberRaw) ?? .victor
    }

    private var btcPrice: Decimal {
        BTCPriceService.storedPrice ?? 0
    }

    private var visibleBuys: [BTCBuy] {
        allBuys.filter { buy in
            guard let owner = buy.ownerMember else { return false }
            guard activeMember.sharesNetWorth(with: owner) else { return false }
            return buy.amountBTC > 0 && buy.usd > 0
        }
    }

    private var totalBtc: Decimal {
        visibleBuys.reduce(Decimal(0)) { $0 + $1.amountBTC }
    }

    private var totalUsd: Decimal {
        visibleBuys.reduce(Decimal(0)) { $0 + $1.usd }
    }

    private var grouped: [(String, [BTCBuy])] {
        AppFormatter.groupedByMonth(visibleBuys, by: \.date)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                #if os(iOS)
                    Color.clear
                        .frame(height: AppLayout.cardSpacing)
                #else
                    ScreenHeader(title: "Bitcoin Buys", eyebrow: "DCA Log")
                #endif

                if visibleBuys.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bitcoinsign.circle").font(AppFont.iconLarge)
                        Text(hasLoaded ? "No Bitcoin buys yet" : "Bitcoin buys unavailable").ledgerType(.rowPrimary)
                        if hasLoaded {
                            if activeMember.isAdult && AppWritebackConfig.canWriteBitcoin {
                                Button("Add Bitcoin buy") { showingAdd = true }.frame(minHeight: 44)
                            } else { DeviceWriteSetupPrompt() }
                        } else { Text("Pull to refresh your buys.").ledgerType(.rowMeta) }
                    }
                    .foregroundStyle(theme.text)
                    .frame(maxWidth: .infinity).padding(ledgerTokens.metrics.screenGutter)
                } else { summaryCard }
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.bottom, AppLayout.cardSpacing)

                ForEach(grouped, id: \.0) { month, buys in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(month.uppercased())
                            .ledgerType(.sectionLabel)
                            .foregroundStyle(theme.textMuted)
                            .padding(.horizontal, 4)

                        VStack(spacing: 0) {
                            ForEach(Array(buys.enumerated()), id: \.element.id) { idx, buy in
                                NavigationLink {
                                    BTCBuyReadDetail(buy: buy)
                                } label: { buyRow(buy) }
                                .buttonStyle(.plain)
                                if idx < buys.count - 1 {
                                    Hairline(indent: 56)
                                }
                            }
                        }
                        .glassCard(padding: 0, radius: AppLayout.radiusMedium)
                    }
                    .padding(.horizontal, ledgerTokens.metrics.screenGutter)
                    .padding(.bottom, AppLayout.cardSpacing)
                }
            }
            .padding(.bottom, AppLayout.cardSpacing)
        }
        .background(theme.bg)
        .navigationTitle("Bitcoin Buys")
        .modifier(LedgerListRefresh())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if activeMember.isAdult && AppWritebackConfig.canWriteBitcoin {
                    Button("Add Bitcoin buy", systemImage: "plus") { showingAdd = true }
                }
            }
        }
        .sheet(isPresented: $showingAdd) { AddTransactionView(initialType: .btcBuy) }
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        #endif
    }

    private var hasLoaded: Bool {
        _ = lastSync
        let source = activeMember.hasDedicatedChildFinanceFiles ? "mason-bitcoin-buys" : "bitcoin-buys"
        return syncedMember == activeMember.rawValue && UserDefaults.standard.dictionary(forKey: ConvexSyncService.dataVersionsKey)?[source] != nil
    }

    private var summaryCard: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("TOTAL BOUGHT")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(theme.onAccent)
                if unit != .usd || btcPrice > 0 {
                    AmountView(sats: totalBtc * 100_000_000, unit: unit, role: .kpiValue, color: theme.onAccent, btcPrice: btcPrice)
                } else { Text("USD value unavailable").ledgerType(.rowMeta) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("TOTAL INVESTED")
                    .ledgerType(.sectionLabel)
                    .foregroundStyle(theme.onAccent)
                Text(AppFormatter.formatCurrency(totalUsd)).ledgerType(.kpiValue).foregroundStyle(theme.onAccent)
            }
        }
        .padding(20)
        .background(theme.accentFill)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func buyRow(_ buy: BTCBuy) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.accentSoft)
                .frame(width: 38, height: 38)
                .overlay(
                    BtcGlyphView(size: 18, color: theme.accent),
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(buy.source)
                    .ledgerType(.rowPrimary)
                    .foregroundStyle(theme.text)
                Text(buy.date.formatted(.dateTime.month(.abbreviated).day()))
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                if unit != .usd || btcPrice > 0 {
                    AmountView(sats: buy.amountBTC * 100_000_000, unit: unit, role: .rowFigure, btcPrice: btcPrice)
                } else { Text("USD value unavailable").ledgerType(.rowMeta) }
                Text("@ \(AppFormatter.formatCurrency(buy.priceUSD))")
                    .ledgerType(.rowMeta)
                    .foregroundStyle(theme.textMuted)
            }
        }
        .padding(14)
    }
}

private struct BTCBuyReadDetail: View {
    let buy: BTCBuy
    var body: some View {
        Form {
            LabeledContent("Account", value: buy.source)
            LabeledContent("Date", value: buy.date.formatted(date: .abbreviated, time: .omitted))
            LabeledContent("Bitcoin", value: AppFormatter.formatAmount(sats: buy.amountBTC * 100_000_000, unit: .btc, btcPrice: 0))
            LabeledContent("Paid", value: AppFormatter.formatCurrency(buy.usd))
            LabeledContent("Price per BTC", value: AppFormatter.formatCurrency(buy.priceUSD))
            if let note = buy.note { LabeledContent("Note", value: note) }
        }
        .navigationTitle("Bitcoin buy")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        #endif
    }
}
